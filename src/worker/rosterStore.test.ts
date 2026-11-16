// rosterStore 的存储层语义回归测试。用一个内存 fake 实现 RosterKV 接口面注入，
// 因此全部用例在 node 环境可跑，不需要 workerd 与真实 KV 绑定——真实绑定的
// 一致性行为（cacheTtl、批量读返回 Map）留给 Task 14 的集成断言。
//
// 这里锁住的语义边界都直接对应 Go 端的运维后果：
//
//   1. fail-closed：KV 里没有任何可用名单时，加载必须抛错而不是返回空名单。
//      空名单会让服务正常启动并对外返回「没有学生」，把「运维忘了上传」
//      伪装成「这所学校没有学生」。
//   2. 最终一致窗口：批量读里个别 key 为 null 只是写入扩散的暂时现象，
//      跳过它、其余学校照常服务；但全部为 null 仍是 fail-closed，
//      不能因「个别可跳过」而把空数据也放过。
//   3. 写路径顺序：先校验后写。校验失败的 payload 必须一个字节都不落 KV，
//      否则坏数据先污染存储，等下一次加载才暴露，且运维看不到这是上传出错。
import { describe, expect, it } from "vitest";
import { errNoRosterMessage } from "../shared/roster";
import { RosterStore, rosterIndexKey, rosterKey, type RosterKV, type RosterKVGetOptions } from "./rosterStore";

// FakeRosterKV 是 RosterKV 的内存实现：entries 模拟 KV 的键值空间，
// puts/deletes 记录写动作流水，供「校验失败不落库」这类副作用断言使用。
// 读取动作同样记录，用于确认 loadAll 走的是批量读而非逐 key 读——逐 key 读
// 在上千所学校时会撞 Workers 的每次请求 subrequest 限额，而批量读只算一次。
class FakeRosterKV implements RosterKV {
  // entries 不设为 private：它有 peek 这个读取入口，但「键空间为空」这类
  // 断言要直接看整体，遍历 peek 只是绕一圈。
  readonly entries = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string }> = [];
  readonly deletes: string[] = [];
  readonly singleReads: string[] = [];
  readonly batchReads: string[][] = [];
  readonly readOptions: RosterKVGetOptions[] = [];

  // seed 直接写内存，不记入 puts：它是测试的数据准备，不是被测代码的写动作。
  seed(key: string, value: string): void {
    this.entries.set(key, value);
  }

  // peek 读内存当前值，用于断言「写后落库了什么」。
  peek(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  get(key: string, options?: RosterKVGetOptions): Promise<string | null>;
  get(keys: string[], options?: RosterKVGetOptions): Promise<Map<string, string | null>>;
  async get(
    key: string | string[],
    options?: RosterKVGetOptions,
  ): Promise<string | null | Map<string, string | null>> {
    this.readOptions.push(options ?? {});
    if (Array.isArray(key)) {
      this.batchReads.push(key);
      const out = new Map<string, string | null>();
      // 真实 KV 的批量读给每个请求的 key 都留一个条目，缺失的为 null。
      // fake 必须同形，否则「Map 里没有这个 key」与「值为 null」在测试里
      // 分不开，实现端 ?? null 的兜底就成了无法验证的死代码。
      for (const item of key) out.set(item, this.entries.get(item) ?? null);
      return out;
    }
    this.singleReads.push(key);
    return this.entries.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
    this.puts.push({ key, value });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
    this.deletes.push(key);
  }
}

// rosterJson 构造一份上游 build_hierarchy_json.py 形状的名单原文：
// 区县 / 学校[校名 / 年级[年级名 / 班级[班名 / 学生[姓名]]]]。
// 延伸为「班名 → 姓名列表」的映射，映射插入序即班级顺序。
function rosterJson(school: string, grade: string, classes: Record<string, string[]>): string {
  return JSON.stringify({
    区县: "福清市",
    学校: [
      {
        校名: school,
        年级: [
          {
            年级名: grade,
            班级: Object.entries(classes).map(([name, students]) => ({
              班名: name,
              学生: students.map((student) => ({ 姓名: student })),
            })),
          },
        ],
      },
    ],
  });
}

describe("loadAll 正常路径", () => {
  it("index 加两校一次批量读，返回全部学生与已加载学校，SchoolIdx 按 index 序分配", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中", "福清二中"]));
    kv.seed(rosterKey("福清一中"), rosterJson("福清一中", "高一", { "1班": ["张三", "李四"] }));
    kv.seed(rosterKey("福清二中"), rosterJson("福清二中", "高二", { "3班": ["王五"] }));

    const store = new RosterStore(kv);
    const got = await store.loadAll();

    expect(got.schools).toEqual(["福清一中", "福清二中"]);
    expect(got.students.map((s) => s.name)).toEqual(["张三", "李四", "王五"]);
    // 跨文件共享同一份加载态：校名与 SchoolIdx 一一对应，且按 index 序单调。
    expect(got.students.map((s) => s.school)).toEqual(["福清一中", "福清一中", "福清二中"]);
    expect(got.students.map((s) => s.schoolIdx)).toEqual([0, 0, 1]);
    // 批量读一次覆盖全部学校；逐 key 读会撞 Workers 的 subrequest 限额。
    expect(kv.batchReads.length).toBe(1);
    expect(kv.batchReads[0]).toEqual([rosterKey("福清一中"), rosterKey("福清二中")]);
    expect(kv.singleReads).toEqual([rosterIndexKey]);
  });

  it("读路径带 60 秒 read cache，减少同一 colo 上的 KV 读计费", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中"]));
    kv.seed(rosterKey("福清一中"), rosterJson("福清一中", "高一", { "1班": ["张三"] }));

    await new RosterStore(kv).loadAll();

    for (const options of kv.readOptions) {
      expect(options).toEqual({ type: "text", cacheTtl: 60 });
    }
  });

  it("index 为空数组时同样 fail-closed，不返回空名单", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify([]));

    await expect(new RosterStore(kv).loadAll()).rejects.toThrow(errNoRosterMessage());
  });
});

describe("fail-closed", () => {
  it("index 缺失抛 errNoRoster 文案，且不发起任何 roster 读取", async () => {
    const kv = new FakeRosterKV();

    await expect(new RosterStore(kv).loadAll()).rejects.toThrow(errNoRosterMessage());
    expect(kv.batchReads).toEqual([]);
  });

  it("index 存在但全部 roster 均为 null 时抛 errNoRoster 文案", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中", "福清二中"]));

    await expect(new RosterStore(kv).loadAll()).rejects.toThrow(errNoRosterMessage());
    // 要先能读到 index，才会发起这次批量读。
    expect(kv.batchReads.length).toBe(1);
  });

  // index 内容坏掉是数据损坏，不是「没有名单」。若静默当成空数组，运维看到的
  // 文案会指向「请放入 roster JSON」，真实原因却是 index 被写坏，排障方向被
  // 引到错误的一层。
  it("index 不是 JSON 时抛解析错误，不伪装成名单缺失", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, "不是 JSON");

    await expect(new RosterStore(kv).loadAll()).rejects.toThrow(/解析 roster:index 失败/);
  });

  it("index 不是数组时抛错", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify({ 学校: ["福清一中"] }));

    await expect(new RosterStore(kv).loadAll()).rejects.toThrow(/不是学校名数组/);
  });

  it("index 里有非字符串元素时抛错", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中", 123]));

    await expect(new RosterStore(kv).loadAll()).rejects.toThrow(/非字符串元素/);
  });

  // 单份 roster 自身坏掉时整批拒绝（fail-closed 的下游）：与 Go 端
  // 「一份坏文件整目录拒绝」一致，避免带病数据对外服务。
  it("某校 roster 内容坏掉时整批抛错", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中"]));
    kv.seed(rosterKey("福清一中"), JSON.stringify({ 学校: [{ 校名: "福清一中", 年级: [{ 年级名: "高一", 班级: [{ 班名: "0班", 学生: [] }] }] }] }));

    await expect(new RosterStore(kv).loadAll()).rejects.toThrow(/班级格式异常/);
  });
});

describe("最终一致窗口", () => {
  it("批量读中一校为 null 时跳过该校，另一校正常服务且不占 SchoolIdx", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中", "福清二中"]));
    kv.seed(rosterKey("福清一中"), rosterJson("福清一中", "高一", { "1班": ["张三"] }));
    // 福清二中的 roster 尚未扩散到本 colo：批量读返回 null。

    const got = await new RosterStore(kv).loadAll();

    expect(got.schools).toEqual(["福清一中"]);
    expect(got.students.length).toBe(1);
    expect(got.students[0].school).toBe("福清一中");
    // 跳过的学校不得占用 SchoolIdx：否则下一次该校数据就绪时，同一校名的
    // 下标会随「本次跳过了谁」漂移，下拉顺序在两次请求之间不稳定。
    expect(got.students[0].schoolIdx).toBe(0);
  });

  // 失败-重试路径：loadAll 是全或无，抛错时本地加载态随栈帧一起销毁，
  // 因此同一个 store 实例在喂进修好的文档后必须干净地从 SchoolIdx 0 重新开始。
  //
  // 这条用例锁的是「失败即放弃整次加载」这个契约本身，而不是某段实现细节：
  // 若将来有人为了「部分学校仍可服务」改成 try/catch 逐校容错，坏文档占掉的
  // 校名与 SchoolIdx 会残留，第二次加载就会报出误导性的「校名重复」，
  // 或者在能用不报错的情况下把下标错位。没有这条断言，那种改动是静默通过的。
  it("先遇坏文档抛错，换修好的文档后第二次加载成功且 SchoolIdx 从 0 开始", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中", "福清二中"]));
    // 第一份文档坏在末层（班名 0 班非法）：此时校名与 SchoolIdx 已在本轮
    // 加载态里占位，正是 roster.ts 契约说的「已占位但未产出学生」的残留态。
    kv.seed(
      rosterKey("福清一中"),
      JSON.stringify({
        学校: [
          {
            校名: "福清一中",
            年级: [{ 年级名: "高一", 班级: [{ 班名: "0班", 学生: [{ 姓名: "张三" }] }] }],
          },
        ],
      }),
    );
    kv.seed(rosterKey("福清二中"), rosterJson("福清二中", "高二", { "3班": ["王五"] }));

    const store = new RosterStore(kv);
    await expect(store.loadAll()).rejects.toThrow(/班级格式异常/);

    // 换上修好的文档后重试同一个 store 实例。
    kv.seed(rosterKey("福清一中"), rosterJson("福清一中", "高一", { "1班": ["张三"] }));
    const got = await store.loadAll();

    expect(got.schools).toEqual(["福清一中", "福清二中"]);
    expect(got.students.map((s) => s.name)).toEqual(["张三", "王五"]);
    // 关键断言：不是「能加载」而已，而是下标从头开始、没有接着残留态自增。
    // 若复用了失败那轮的态，两校下标会是 [1, 2] 而不是 [0, 1]。
    expect(got.students.map((s) => s.schoolIdx)).toEqual([0, 1]);
  });

  // 校名唯一性由跨文件共享的加载态把控，与 Go 端 schoolOrder 同语义。
  // 两份 roster 文档里出现同一校名时必须整份拒绝，否则下拉出现重复项、
  // 同一校名在搜索侧指向两个 SchoolIdx。
  it("两份文档出现重复校名时抛错（共享加载态生效）", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中", "福清二中"]));
    kv.seed(rosterKey("福清一中"), rosterJson("福清一中", "高一", { "1班": ["张三"] }));
    // 第二份文档自称「福清一中」，与 index 里的校名不同，撞上校名唯一性。
    kv.seed(rosterKey("福清二中"), rosterJson("福清一中", "高一", { "1班": ["李四"] }));

    await expect(new RosterStore(kv).loadAll()).rejects.toThrow(/校名重复: 福清一中/);
  });
});

describe("putRoster", () => {
  it("校验失败时不调用 kv.put，index 保持原样", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中"]));

    // 学校数组为空：合法 JSON 却不是 roster 形状，必须被 parseSingleDocument 拒绝。
    await expect(new RosterStore(kv).putRoster("福清二中", JSON.stringify({ 学校: [] }))).rejects.toThrow(
      /缺少学校数据/,
    );
    expect(kv.puts).toEqual([]);
    expect(kv.deletes).toEqual([]);
    expect(kv.peek(rosterIndexKey)).toBe(JSON.stringify(["福清一中"]));
  });

  it("校验成功后写入 roster 与 index，返回学生条数", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中"]));
    kv.seed(rosterKey("福清一中"), rosterJson("福清一中", "高一", { "1班": ["张三"] }));

    const payload = rosterJson("福清二中", "高二", { "2班": ["王五", "赵六"] });
    const got = await new RosterStore(kv).putRoster("福清二中", payload);

    expect(got.students).toBe(2);
    expect(kv.peek(rosterKey("福清二中"))).toBe(payload);
    expect(kv.peek(rosterIndexKey)).toBe(JSON.stringify(["福清一中", "福清二中"]));
  });

  it("覆盖已有学校时 index 不重复追加该校", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中", "福清二中"]));

    const payload = rosterJson("福清一中", "高三", { "9班": ["孙七"] });
    const got = await new RosterStore(kv).putRoster("福清一中", payload);

    expect(got.students).toBe(1);
    expect(kv.peek(rosterKey("福清一中"))).toBe(payload);
    expect(kv.peek(rosterIndexKey)).toBe(JSON.stringify(["福清一中", "福清二中"]));
  });

  it("index 缺失时新建 index", async () => {
    const kv = new FakeRosterKV();

    await new RosterStore(kv).putRoster("福清一中", rosterJson("福清一中", "高一", { "1班": ["张三"] }));
    expect(kv.peek(rosterIndexKey)).toBe(JSON.stringify(["福清一中"]));
  });

  it("空校名（含纯空白）拒绝写入，不产生任何 KV 动作", async () => {
    const kv = new FakeRosterKV();
    const store = new RosterStore(kv);
    const payload = rosterJson("福清一中", "高一", { "1班": ["张三"] });

    await expect(store.putRoster("", payload)).rejects.toThrow(/校名不能为空/);
    await expect(store.putRoster("  ", payload)).rejects.toThrow(/校名不能为空/);
    expect(kv.puts).toEqual([]);
  });
});

// 保留名校名 index 是本层必须守的键空间边界，不是管理端该记得的事：
// rosterKey("index") === rosterIndexKey，校名取 index 就能把名单原文写进索引键。
// 守卫在 normalizeSchoolName 里（落键归一之后），因此编码形态与带空白的
// " index " 都会被同一条判定拦下。
//
// 这些用例锁的是根因层，不依赖管理端是否记得检查——管理端将来换了实现、
// 或有人直接调 store，都不会绕过它。
describe("保留校名 index 拒绝（C-1 根因层）", () => {
  it("putRoster 拒绝 index，不产生任何 KV 动作，index 不被覆盖", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中"]));
    const payload = rosterJson("index", "高一", { "1班": ["张三"] });

    await expect(new RosterStore(kv).putRoster("index", payload)).rejects.toThrow(/保留字 index/);
    // 关键：一个字节都没落 KV，索引仍是原来的学校名数组。
    expect(kv.puts).toEqual([]);
    expect(kv.peek(rosterIndexKey)).toBe(JSON.stringify(["福清一中"]));
    // roster:index 既是索引键也是 rosterKey("index") 本身，覆盖与否看同一个键。
    expect(kv.peek(rosterKey("index"))).toBe(JSON.stringify(["福清一中"]));
  });

  it("deleteRoster 拒绝 index，index 键不被删除", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中"]));
    kv.seed(rosterKey("福清一中"), rosterJson("福清一中", "高一", { "1班": ["张三"] }));

    await expect(new RosterStore(kv).deleteRoster("index")).rejects.toThrow(/保留字 index/);
    // 关键：索引与其余学校原文都还在，没有变成孤儿。
    expect(kv.deletes).toEqual([]);
    expect(kv.peek(rosterIndexKey)).toBe(JSON.stringify(["福清一中"]));
    expect(kv.peek(rosterKey("福清一中"))).not.toBeNull();
  });

  // 带前后空白的 index 归一后同样是保留名：判定必须在归一之后。
  it("带空白的 index 与编码形态都走同一条判定", async () => {
    const kv = new FakeRosterKV();
    const store = new RosterStore(kv);
    const payload = rosterJson("index", "高一", { "1班": ["张三"] });

    await expect(store.putRoster("  index  ", payload)).rejects.toThrow(/保留字 index/);
    await expect(store.putRoster("\tindex\n", payload)).rejects.toThrow(/保留字 index/);
    expect(kv.puts).toEqual([]);
  });

  // 控制字符（NUL 正是去重键的分隔符）同样拒绝。
  it("含控制字符的校名被拒绝", async () => {
    const kv = new FakeRosterKV();
    const payload = rosterJson("x", "高一", { "1班": ["张三"] });

    await expect(new RosterStore(kv).putRoster("福清\u0000一中", payload)).rejects.toThrow(/控制字符/);
    await expect(new RosterStore(kv).putRoster("福清\u001f一中", payload)).rejects.toThrow(/控制字符/);
    expect(kv.puts).toEqual([]);
  });
});

// 键名 512 字节是 KV 的硬限制，越界时平台会抛自己的错误——那条文本若流到
// 客户端，会被读成「你上传的名单内容不合法」，而真实原因是这个校名太长。
// 拦截前置在本层，用 rosterKey(name) 的字节数判定（前缀也算额度），
// 于是 PUT 与 DELETE 拿到同一件事：「这个校名不能用」。
describe("键长上限前置（根因层）", () => {
  // "roster:" 是 7 个 ASCII 字符：校名 505 字节时键名恰好 512（允许），
  // 506 字节时 513（拒绝）。
  const atLimit = "a".repeat(505);
  const overLimit = "a".repeat(506);

  it("恰好 512 字节允许落键", async () => {
    const kv = new FakeRosterKV();
    await new RosterStore(kv).putRoster(atLimit, rosterJson(atLimit, "高一", { "1班": ["张三"] }));

    expect(kv.peek(rosterKey(atLimit))).not.toBeNull();
  });

  it("超过 512 字节抛 InvalidSchoolNameError，一个字节都不落 KV", async () => {
    const kv = new FakeRosterKV();
    const payload = rosterJson(overLimit, "高一", { "1班": ["张三"] });

    await expect(new RosterStore(kv).putRoster(overLimit, payload)).rejects.toThrow(/校名过长/);
    expect(kv.puts).toEqual([]);
    expect(kv.entries.size).toBe(0);
  });

  // 汉字按 UTF-8 计三字节：200 个汉字是 600 字节，加前缀 607，远超 512。
  // 用码元或码点数近似都会漏判（200 个汉字在 JS 里 length 也是 200）。
  it("汉字校名按 UTF-8 字节判定，不按字符数", async () => {
    const kv = new FakeRosterKV();
    const longName = "症".repeat(200);

    await expect(new RosterStore(kv).putRoster(longName, rosterJson(longName, "高一", { "1班": ["张三"] }))).rejects.toThrow(
      /校名过长/,
    );
    await expect(new RosterStore(kv).deleteRoster(longName)).rejects.toThrow(/校名过长/);
    expect(kv.puts).toEqual([]);
    expect(kv.deletes).toEqual([]);
  });
});

describe("deleteRoster", () => {
  it("删除 roster key 并从 index 移除该校，返回 true", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中", "福清二中"]));
    kv.seed(rosterKey("福清一中"), rosterJson("福清一中", "高一", { "1班": ["张三"] }));
    kv.seed(rosterKey("福清二中"), rosterJson("福清二中", "高一", { "1班": ["李四"] }));

    const deleted = await new RosterStore(kv).deleteRoster("福清一中");

    expect(deleted).toBe(true);
    expect(kv.peek(rosterKey("福清一中"))).toBeNull();
    expect(kv.peek(rosterKey("福清二中"))).not.toBeNull();
    expect(kv.peek(rosterIndexKey)).toBe(JSON.stringify(["福清二中"]));
    expect(kv.deletes).toEqual([rosterKey("福清一中")]);
  });

  // index 里没有该校时仍删 roster key：KV 里可能留着孤儿 key（例如 index
  // 被手改过），留着它会让同名上传的旧数据先于新数据可用；但 index 没有变化，
  // 因此不该产生一次 index 写。
  it("index 无该校时只删 roster key，不写 index，返回 false", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中"]));
    kv.seed(rosterKey("福清二中"), rosterJson("福清二中", "高一", { "1班": ["李四"] }));

    const deleted = await new RosterStore(kv).deleteRoster("福清二中");

    expect(deleted).toBe(false);
    expect(kv.peek(rosterKey("福清二中"))).toBeNull();
    expect(kv.puts).toEqual([]);
    expect(kv.peek(rosterIndexKey)).toBe(JSON.stringify(["福清一中"]));
  });

  it("index 缺失时删除仍不抛错", async () => {
    const kv = new FakeRosterKV();

    await expect(new RosterStore(kv).deleteRoster("福清一中")).resolves.toBe(false);
    expect(kv.puts).toEqual([]);
  });
});

describe("listSchools", () => {
  it("只读 index，返回学校名且不触碰 roster key", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中", "福清二中"]));

    expect(await new RosterStore(kv).listSchools()).toEqual(["福清一中", "福清二中"]);
    expect(kv.batchReads).toEqual([]);
    expect(kv.singleReads).toEqual([rosterIndexKey]);
  });

  it("index 缺失时返回空数组（管理端列表的自然空态）", async () => {
    const kv = new FakeRosterKV();

    expect(await new RosterStore(kv).listSchools()).toEqual([]);
  });

  it("index 损坏时抛错，不静默返回空列表", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, "不是 JSON");

    await expect(new RosterStore(kv).listSchools()).rejects.toThrow(/解析 roster:index 失败/);
  });
});

describe("键名常量", () => {
  it("rosterKey 带 roster: 前缀，index 键固定", () => {
    expect(rosterKey("福清一中")).toBe("roster:福清一中");
    expect(rosterIndexKey).toBe("roster:index");
  });
});
