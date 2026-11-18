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
// 命中边缘缓存，不重复计费也不重复跨区回源。60 秒与迁移设计一致——名单是低频
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

// InvalidSchoolNameError 标记「校名本身不合法」这一类拒绝：空名、保留名 index、
// 含控制字符。它与「名单原文校验失败」是两种不同的事实，管理端必须能分开——
// 前者是请求的问题（改 URL 重发即可），后者是上传内容的问题（改文件重发）。
// 两者都返回 400，但 DELETE 路径上只有后者不该被当成「数据坏了」去翻 KV。
//
// 用独立类型而不是给 Error 加字段：instanceof 判定让 handler 不必去解析
// message 文本，message 的 owner 因此仍只属于抛出处——文案改动不会让
// 分类逻辑静默失效。
export class InvalidSchoolNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSchoolNameError";
  }
}

// InvalidRosterError 标记「名单原文没有通过加载侧校验」，message 逐字沿用
// shared/roster.ts 的文案（本层不加工）。它与 InvalidSchoolNameError 一起，
// 让管理端无需解析文本就能分出三类事实：
//
//   InvalidSchoolNameError  校名不合法（空名/保留名/控制字符/键名超长）→ 400
//   InvalidRosterError      名单内容不合法（解析/结构/班级格式等）→ 400 + 文案
//   其他                      存储层故障（KV 读写抛错）→ 500 data_unavailable
//
// 第三种最关键：平台抛出的错误文本（键值超限、限流、超时）若被当成「内容
// 不合法」转发，管理员会拿着好文件反复重传，同时内部错误文本外露。
export class InvalidRosterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRosterError";
  }
}

// READ_OPTIONS 抽出共用，避免四个读取点各写一份字面量后悄悄分叉
// （例如某处漏了 cacheTtl，读数就不再走边缘缓存，计费与延迟都变）。
//
// cacheTtl 取 60 是与迁移设计一致的策略值，不是平台下限：官方文档写明
// cacheTtl 最小值是 30，默认值也是 60。取默认值的理由有两条——名单是
// 写少读多的数据，60 秒的读缓存能显著减少同一 colo 的回源与计费；
// 代价是「刚写入的名单在别的 colo 上最多晚 60 秒可见」，而这个代价直接
// 放大了下面 putRoster / deleteRoster 的读-改-写竞态窗口，见其标注。
const READ_OPTIONS: RosterKVGetOptions = { type: "text", cacheTtl: 60 };

// ROSTER_KEY_MAX_BYTES 是 KV 键名的字节上限，来自平台文档的硬限制
//（https://developers.cloudflare.com/kv/platform/limits/：Key size 512 bytes，
// Free 与 Paid 相同）。写成具名常量而不是散落字面量：它同时被输入校验与
// 错误文案引用，两处必须永远同一个数。
const ROSTER_KEY_MAX_BYTES = 512;

// RosterStore 是名单的读取与写入入口。一个实例对应一组 KV 绑定，
// 生命周期与当前请求一致：本层不持有任何跨请求缓存——名单的一致性
// 由 KV 的 read cache 与写扩散决定，进程内再缓一层会让管理端上传后
// 的可见延迟变成两段不可预期的叠加。
export class RosterStore {
  // 构造只收 kv。设计稿里那个 now?: () => number 在本任务没有任何消费者
  // （没有 TTL 判定，也没有失败冷却），为空参数写接口只会让后续读者以为
  // 这里存在时间相关行为。真需要时钟时补一个可选参数不破坏任何调用点。
  constructor(private readonly kv: RosterKV) {}

  // loadAll 读 index、批量读全部 roster 原文、按 index 顺序逐校校验，
  // 返回学生快照与本次真正加载到的学校名。
  //
  // 返回的 schools 是「已加载」而不是「index 里声明」的集合：跳过 null 的
  // 那些学校不在里面。这个选择让调用方依据「能服务什么」而不是「KV 里写了
  // 什么」来决策，但它同时意味着**两个集合不等价**，调用方不得互换使用：
  //
  //   schools        只在本次读到了原文的学校，已过滤掉最终一致窗口里缺数据的项；
  //   listSchools()  读 index，是声明集合，未做任何过滤。
  //
  // 差集（listSchools() 去掉 schools）就是本次被跳过的学校——这是把「静默
  // 少一所」变成可观测信号的唯一入口。健康检查应当据此判断降级：差集非空即
  // 「有学校此刻读不到数据」；差集全量（即 schools 为空）本函数已经抛
  // errNoRosterMessage，不会走到这里。不要把两者当成同一个东西，也不要让
  // 下拉与健康检查共用一处取值而不加区分。
  async loadAll(): Promise<{ students: RosterStudent[]; schools: string[] }> {
    const schools = await this.readIndex();
    if (schools.length === 0) {
      // index 存在但为空数组：等价于「一所学校都没配」，与 index 缺失同判。
      throw new Error(errNoRosterMessage());
    }

    // 一次批量读覆盖全部学校。逐 key 读在百校规模就会撞 Workers 的单次请求
    // subrequest 限额（每次 get 都算一次），批量读只算一次。
    //
    // ponytail: KV 的批量 get 单次最多 100 个 key（官方文档 Input: Max: 100 keys），
    // 越界时平台行为未明说（报错或静默截断都可能）。当前学校数量级远未触线，
    // 因此不分片。学校数向 100 逼近时，改成按 100 分组读并把各组 Map 合并。
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
    // 校验异常向上抛，message 保持 shared/roster.ts 的逐字形态，本层不加前缀
    // 不改写——调用方（管理端 handler）把这段文案原样转成 400。
    //
    // 包一层 InvalidRosterError 只加类型不加文案：校验失败与「KV 写失败」在
    // 上层必须能分开——前者答 400 并把文案给管理员，后者答 500 且不该把平台
    // 的原始错误文本外露。不包装的话两者都是裸 Error，调用点只能靠「是不是
    // 在校验之后抛出」去猜，而那个判断随实现顺序变动。
    let students: RosterStudent[];
    try {
      students = parseSingleDocument(payload, name);
    } catch (error) {
      throw new InvalidRosterError(error instanceof Error ? error.message : String(error));
    }

    // 先写原文。若随后 index 更新失败，数据仍在 KV 里（下次修好 index 就能加载），
    // 反过来先写 index 再写原文失败，则 index 会指向一个读不到的空项。
    await this.kv.put(rosterKey(name), payload);

    const schools = await this.readIndex();
    if (!schools.includes(name)) {
      // 只在真的新增时才写 index：覆盖同名学校不产生一次无意义的写扩散。
      //
      // ponytail: 读-改-写没有跨请求互斥，两个并发写者会各写一份 index，
      // 后者覆盖先者、丢掉对方的新增项。校名仍是唯一键、roster 原文也都写成了，
      // 丢的只是 index 里的一行，重传一次即可补回。
      //
      // 这个窗口不是「两个请求几乎同时」那么窄：readIndex 走 READ_OPTIONS 的
      // cacheTtl，跨 colo 的写入要等缓存过期才可见（官方文档明写「来自其他
      // 全球网络位置的写入在缓存值过期前不可见」），因此在缓存周期内到达的
      // 第二个写者，读到的很可能就是旧快照——窗口实际长达一个缓存周期
      // （当前 60 秒）。调小 cacheTtl 能缩窗，但读侧会立刻增加回源、计费与延迟；
      // 两者是同一根旋钮的两端。
      //
      // 真要强一致得把写入收进一个 Durable Object 串行化——当前管理端是
      // 单管理员低频写入，不做。
      await this.kv.put(rosterIndexKey, JSON.stringify([...schools, name]));
    }

    return { students: students.length };
  }

  // deleteRoster 删除一所学校，返回该校是否在 index 里（管理端据此决定 200 还是 404）。
  //
  // roster 原文总会删掉，即使 index 里没有该校：KV 里可能留着孤儿 key
  // （例如 index 被手工改过），留着它会让同名重新上传的旧数据先于新数据可用。
  // 但 index 没有变化时不写 index，避免一次无意义的写扩散。
  //
  // 同 putRoster，本路径也走 index 的读-改-写，因此共享同一竞态与同一个
  // 被 cacheTtl 放大的窗口：缓存周期内到达的第二个写者读到的是旧快照，
  // 它写回的 index 会覆盖先者的改动。详见 putRoster 处的 ponytail 标注。
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

// normalizeSchoolName 把校名归一到落键形态：剥掉 Go 语义的空白，并拒绝空名、
// 保留名与含控制字符的名字。
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
    throw new InvalidSchoolNameError("校名不能为空");
  }
  // 「roster:」前缀是校名独占的键空间，而索引键 roster:index 正是它的保留成员：
  // rosterKey("index") === rosterIndexKey。校名若取 index，PUT 会把名单原文
  // 写进索引键（下一次加载解析失败、全站 500），DELETE 会把索引整个删掉
  //（其余学校原文成孤儿，列表答「一所都没上传」，管理员查不出根因）。
  // 两条都是不可逆的数据销毁，且响应与副作用相反——PUT 会答「名单内容不合法」，
  // 管理员以为重传即可。
  //
  // 判定必须在归一之后：编码形态（ind%65x）与带空白的 " index " 都落到这个
  // 名字上，任何在归一之前做的检查都能被绕过。
  //
  // 用常量比较而不是字面量 "index"：这个保留名的唯一事实源是 rosterIndexKey
  // 的构成方式（"roster:" + 名字 === rosterIndexKey），写成字面量会在将来
  // 改前缀或改索引键时静默失配。
  if (rosterKey(name) === rosterIndexKey) {
    throw new InvalidSchoolNameError("校名不能是保留字 index");
  }
  // 控制字符一并拒绝：NUL 是 shared/roster.ts 拼去重键的分隔符（KEY_SEPARATOR），
  // 含 NUL 的校名会让「两段拼起来相同但分段不同」的记录无法区分；其余控制字符
  // 只可能来自手工构造的请求，任何一种都会让键名与运维看到的文本对不上。
  for (const rune of name) {
    if (rune < " " || rune === "\u007f") {
      throw new InvalidSchoolNameError("校名不能含控制字符");
    }
  }
  // 键长上限前置。真实的 KV 对键名有 512 字节的硬限制（官方 Limits 页注明
  // 键名上限 512 bytes，Free 与 Paid 一致），超过它的写与删都会在平台侧抛错。
  //
  // 判定用 rosterKey(name) 的字节数而不是校名的字节数：前缀 "roster:" 也占
  // 同一份额度，只算校名会让「校名 512 字节」这种边界悄悄越过限制。用 UTF-8
  // 编码算字节，与平台口径一致（汉字是三字节，不能用码元或码点数近似）。
  //
  // 为什么必须在存储层前置，而不是让平台去拒绝：
  // 1. 平台拒绝抛的是它自己的错误文本，管理端只能原样转发——「存储层写失败」
  //    会被标注成「你上传的名单内容不合法」，管理员拿着好文件反复重传，
  //    排障方向被引偏；而且内部错误文本会外露给客户端。
  // 2. PUT 与 DELETE 若各自面对平台抛错，处置还会分叉（一个乐观成功、一个 500）。
  //    前置成同一个 InvalidSchoolNameError 之后，两条方法得到同一件事：
  //    「这个校名不能用」，400，理由同一句。
  //
  // ponytail: 这是对「未知校名」的提前拒绝，不是完整性校验——它只判定键名额度，
  // 不判定 KV 的其他限制（值大小 25 MiB 等）。值大小超限仍由平台抛错并走
  // data_unavailable；真要在本地复刻全部限制，维护成本高于收益。
  if (new TextEncoder().encode(rosterKey(name)).length > ROSTER_KEY_MAX_BYTES) {
    throw new InvalidSchoolNameError("校名过长（键名超过 512 字节）");
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
