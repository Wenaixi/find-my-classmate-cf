// 名单在 KV 里的存储层 owner：把 Go 端「目录 → 逐文件读取 → 校验 → 快照」的
// 加载职责，平移到「KV 索引 + 每校一份原文」的存储布局上。
//
// 布局与职责边界：
//
//   roster:index        学校名数组（JSON）。它是唯一的事实源：index 里没有的
//                       学校不会被加载，即使 roster:{school} 的 key 还留在 KV 里。
//   roster:{school}     单校名单原文，内容就是上游 build_hierarchy_json.py
//                       输出的整份 JSON（含 区县/学校/年级/班级/学生），
//                       本层不做任何改写，原样存取——管理端上传什么，加载时
//                       校验什么，运维看到的 KV 内容与本地文件逐字节一致。
//
// 校验不在本层实现：单一 owner 是 shared/roster.ts。本层只负责「取出来、
// 按 index 顺序喂给校验、把结果拼成快照」和「写之前先过校验」。
//
// 两条从 Go 端平移过来的硬约束：
//
//   fail-closed：KV 里没有任何可用名单时抛 errNoRoster 文案，绝不返回空名单。
//   空名单会让服务正常启动并对外答「没有学生」，把「运维忘了上传」伪装成
//   「这所学校没有学生」，排障方向因此被引到错误的一层。
//
//   最终一致窗口：KV 的写扩散不是瞬时的，index 刚更新时某个 colo 上
//   roster:{school} 可能还读到 null。此时跳过该校、其余照常服务，比整批
//   503 更可用；但全部为 null 仍是 fail-closed——「个别可跳过」不能一路
//   放宽到「空数据也放过」。
//
// 依赖方向单向：本文件不重新实现校验，也不持有第二份键名或错误文案。
import { trimGoSpace } from "../shared/classparse";
import {
  errNoRosterMessage,
  newRosterLoadState,
  parseRosterDocument,
  parseSingleDocument,
} from "../shared/roster";
import type { RosterStudent } from "../shared/student";

// KV 读取选项。cacheTtl 是 Workers KV 的 read cache：同一个 colo 上的重复读
// 命中边缘缓存，不重复计费也不重复跨区回源。60 秒与计划书一致——名单是低频
// 写、高频读的数据，一分钟的滞后对「刚上传完想立刻看到」的场景仍可接受。
export interface RosterKVGetOptions {
  type?: "text";
  cacheTtl?: number;
}

// RosterKV 是本层依赖的最小 KV 接口面，刻意不直接引用 Workers 的 KVNamespace
// 类型：测试要能在 node 环境注入内存 fake，而 KVNamespace 带着运行时全局与
// 一堆与本层无关的方法（list / getWithMetadata / expirationTtl）。
//
// 用重载而不是「一个 get + 可选第三参」表达两种读取形态：单键返回 string|null，
// 批量返回 Map。返回值形状不同，重载让每个调用点的静态类型直接对上，避免
// 一个宽联合类型在调用处再收窄一次。
//
// 真实 KVNamespace 可以直接赋给这个接口（它的重载是本接口的超集）；
// 测试与本地适配器实现上面这些成员即可。
export interface RosterKV {
  get(key: string, options?: RosterKVGetOptions): Promise<string | null>;
  get(keys: string[], options?: RosterKVGetOptions): Promise<Map<string, string | null>>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// 学校名索引的固定键。不随校名变化，因此单独常量而不是走 rosterKey。
export const rosterIndexKey = "roster:index";

// rosterKey 是单校原文的键名，前缀与 index 同族（都 roster: 开头），
// 便于用一次 KV list prefix 巡检。
export function rosterKey(school: string): string {
  return `roster:${school}`;
}

// READ_OPTIONS 抽出共用，避免四个读取点各写一份字面量后悄悄分叉
// （例如某处漏了 cacheTtl，读数就不再走边缘缓存，计费与延迟都变）。
const READ_OPTIONS: RosterKVGetOptions = { type: "text", cacheTtl: 60 };

// RosterStore 是名单的读取与写入入口。一个实例对应一组 KV 绑定，
// 生命周期与当前请求一致：本层不持有任何跨请求缓存——名单的一致性
// 由 KV 的 read cache 与写扩散决定，进程内再缓一层会让管理端上传后
// 的可见延迟变成两段不可预期的叠加。
export class RosterStore {
  // 构造只收 kv。计划书里那个 now?: () => number 在本任务没有任何消费者
  // （没有 TTL 判定，也没有失败冷却），为空参数写接口只会让后续读者以为
  // 这里存在时间相关行为。真需要时钟时补一个可选参数不破坏任何调用点。
  constructor(private readonly kv: RosterKV) {}

  // loadAll 读 index、批量读全部 roster 原文、按 index 顺序逐校校验，
  // 返回学生快照与本次真正加载到的学校名。
  //
  // schools 返回的是「已加载」而不是「index 里声明」的集合：跳过 null 的
  // 那些学校不在里面。调用方（学校下拉、健康检查）依据的是能服务什么，
  // 而不是 KV 里写了什么。
  async loadAll(): Promise<{ students: RosterStudent[]; schools: string[] }> {
    const schools = await this.readIndex();
    if (schools.length === 0) {
      // index 存在但为空数组：等价于「一所学校都没配」，与 index 缺失同判。
      throw new Error(errNoRosterMessage());
    }

    // 一次批量读覆盖全部学校。逐 key 读在百校规模就会撞 Workers 的单次请求
    // subrequest 限额（每次 get 都算一次），批量读只算一次。
    const documents = await this.kv.get(
      schools.map((school) => rosterKey(school)),
      READ_OPTIONS,
    );

    // 跨文件共享同一份加载态：校名唯一性与 SchoolIdx 单调都依赖它。
    // 每次 loadAll 新建，绝不复用上一轮的态——roster.ts 的契约写明失败后
    // 的残留态会让修好的文件报出误导性的「校名重复」。
    const state = newRosterLoadState();
    const students: RosterStudent[] = [];
    const loadedSchools: string[] = [];

    for (const school of schools) {
      // Map 里可能压根没有这个 key（fake 之外的实现未必逐 key 塞条目），
      // 也可能是 null（真实 KV 对缺失键的表示）。两种都按「这里读不到」处理。
      const payload = documents.get(rosterKey(school)) ?? null;
      if (payload === null) {
        // 最终一致窗口：该校的写入尚未扩散到当前 colo。跳过它继续服务其余学校，
        // 但跳过必须在「分配 SchoolIdx」之前发生——先跳过就不占下标，下一次
        // 该校数据就绪时下标与「从未跳过」的加载完全一致，下拉顺序不漂移。
        //
        // 注意 skip 的判定成本：这不是「容错」而是「可用性优先于完整性」的
        // 显式取舍。一份坏掉的 JSON 仍然整批拒绝（下面的 parse 会抛），
        // 只有「读不到」才跳过——「读到了但内容坏」与「没读到」是两件事。
        continue;
      }
      // sourceName 用 index 里的校名：错误文案因此指向「KV 里哪一项」，
      // 与管理端 upload 时用的标识同一套。
      students.push(...parseRosterDocument(payload, school, state));
      loadedSchools.push(school);
    }

    if (loadedSchools.length === 0) {
      // 全部读不到：这不是「这些学校暂时没有数据」，而是「KV 里没有名单」，
      // 与 index 缺失同判 fail-closed。
      throw new Error(errNoRosterMessage());
    }

    return { students, schools: loadedSchools };
  }

  // listSchools 只读 index，给管理端列表与学校下拉的「有哪些学校」用。
  // 不加载任何 roster：列表页不该为了一串校名付全量解析的代价。
  async listSchools(): Promise<string[]> {
    return this.readIndex();
  }

  // putRoster 写入或覆盖一所学校，返回本次写入的名单条数。
  //
  // 顺序是硬约束：先校验、后写。校验失败时一个字节都不落 KV——否则坏数据
  // 先污染存储，等下一次加载才暴露，而错误现场（哪次上传、谁传的）已经丢了。
  // 校验用 parseSingleDocument：单校上传不存在跨文件状态，不该被要求造
  // 一份只活一行的加载态。
  async putRoster(school: string, payload: string): Promise<{ students: number }> {
    const name = normalizeSchoolName(school);
    // 校验异常直接向上抛：调用方（管理端 handler）把 message 原样转成 400，
    // 文案必须保持 shared/roster.ts 的逐字形态，本层不加前缀不改写。
    const students = parseSingleDocument(payload, name);

    // 先写原文。若随后 index 更新失败，数据仍在 KV 里（下次修好 index 就能加载），
    // 反过来先写 index 再写原文失败，则 index 会指向一个读不到的空项。
    await this.kv.put(rosterKey(name), payload);

    const schools = await this.readIndex();
    if (!schools.includes(name)) {
      // 只在真的新增时才写 index：覆盖同名学校不产生一次无意义的写扩散。
      // ponytail: 读-改-写没有跨请求互斥，两个并发上传不同学校时可能各写一份
      // index 而丢掉对方的新增项（后者覆盖先者）。校名仍是唯一键、roster 原文
      // 也都在，丢的只是 index 里的一行，重传一次即可补回。真要强一致得把写入
      // 收进一个 Durable Object 串行化——当前管理端是单管理员低频写入，不做。
      await this.kv.put(rosterIndexKey, JSON.stringify([...schools, name]));
    }

    return { students: students.length };
  }

  // deleteRoster 删除一所学校，返回该校是否在 index 里（管理端据此决定 200 还是 404）。
  //
  // roster 原文总会删掉，即使 index 里没有该校：KV 里可能留着孤儿 key
  // （例如 index 被手工改过），留着它会让同名重新上传的旧数据先于新数据可用。
  // 但 index 没有变化时不写 index，避免一次无意义的写扩散。
  async deleteRoster(school: string): Promise<boolean> {
    const name = normalizeSchoolName(school);
    const schools = await this.readIndex();
    await this.kv.delete(rosterKey(name));

    if (!schools.includes(name)) return false;

    await this.kv.put(
      rosterIndexKey,
      JSON.stringify(schools.filter((entry) => entry !== name)),
    );
    return true;
  }

  // readIndex 读并解析学校名数组。缺失返回空数组（「一所都没配」的自然表示），
  // 内容损坏则抛错——损坏与缺失必须分开：前者要指向「index 被写坏」，
  // 后者才指向「请上传名单」。
  private async readIndex(): Promise<string[]> {
    const raw = await this.kv.get(rosterIndexKey, READ_OPTIONS);
    if (raw === null) return [];
    return parseSchoolIndex(raw);
  }
}

// normalizeSchoolName 把校名归一到落键形态：剥掉 Go 语义的空白，并拒绝空名。
//
// 用 trimGoSpace 而不是 String.prototype.trim 与校验侧保持同一份空白语义
// （后者会剥 U+FEFF 而 Go 不剥，两端会分叉）。
//
// 归一放在落键处而不是展示处：带前后空白的校名若原样落键，管理端 URL 里
// encodeURIComponent 出来的 key 与 index 里存的名字看似不同、实为同一项，
// 排障时无法凭肉眼对上。
function normalizeSchoolName(school: string): string {
  const name = trimGoSpace(school);
  if (name === "") {
    // 空校名落键会得到 roster: 这个无意义的键，且 index 里出现空串项——
    // 下拉里会渲染出一个空选项（等价于「不按学校过滤」的歧义入口）。
    throw new Error("校名不能为空");
  }
  return name;
}

// parseSchoolIndex 解析 index 原文并做形态校验：必须是字符串数组。
//
// 三种失败分开报，因为运维的修法不同：JSON 语法坏（改 index 内容）、
// 结构不是数组（index 被写成了别的东西）、数组里混进非字符串（手工编辑时
// 少了引号最典型）。合成一条「解析失败」会让这三种都指向同一个模糊动作。
//
// 文案前缀 `解析 roster:index 失败` 与 shared/roster.ts 的 `解析 ${sourceName} 失败`
// 同族，grep 一次能捞到所有解析失败。
function parseSchoolIndex(raw: string): string[] {
  // BOM 剥离与 roster.ts 同理：手工用记事本改过的 index 常带 BOM，
  // JSON.parse 会因此报错，而这不是内容错。
  if (raw.startsWith("\uFEFF")) raw = raw.slice(1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`解析 ${rosterIndexKey} 失败: ${detail}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`解析 ${rosterIndexKey} 失败: 不是学校名数组`);
  }

  const schools: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") {
      throw new Error(`解析 ${rosterIndexKey} 失败: 存在非字符串元素（${typeof entry}）`);
    }
    schools.push(entry);
  }
  return schools;
}
