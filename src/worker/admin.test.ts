// 管理端点的回归测试：认证、三端点（PUT / DELETE / GET 列表）与路径判定。
//
// 测试用真实 RosterStore 加内存 fake KV，而不是伪造一个 store 对象：RosterStore
// 带私有字段，结构类型无法被对象字面量满足；用真实 store 还能让「校验失败一个
// 字节都不落 KV」这条断言直接读 KV 键空间，不必对私有状态做类型断言。
// putRoster 的调用次数用 vi.spyOn 监视，用来证明校验失败的请求没有走到写入。
//
// 常量时间比较在 node 环境没有 crypto.subtle.timingSafeEqual（它是 Workers 扩展），
// 所以本文件既验默认比较的降级路径，也验注入 compare 的接缝：假 compare 能证明
// verifyBearer 把「校验逻辑」与「比较实现」解耦，测试环境不依赖平台 API 存在。
import { describe, expect, it, vi } from "vitest";
import { adminHandlers, isAdminPath, verifyBearer } from "./admin";
import { RosterStore, rosterIndexKey, rosterKey, type RosterKV, type RosterKVGetOptions } from "./rosterStore";

// 与 errors.ts 同一份 JSON Content-Type，逐字对齐 Go 端 writeJSON。
const jsonContentType = "application/json; charset=utf-8";

// 测试用管理员 token。长度取 24，任何「不等长」用例都以它为基准。
const TOKEN = "admin-token-0123456789";

// FakeRosterKV 是 RosterKV 的内存实现。entries 公开，供断言直接读键空间——
// 「校验失败的请求没有写 KV」只能靠它看到。
//
// reads 累计一切 get 调用（单键与批量各算一次）：认证先于数据访问这条顺序
// 约束只能靠「零读」断言证明，光看响应码看不出 handler 是否偷偷读了一次。
class FakeRosterKV implements RosterKV {
  readonly entries = new Map<string, string>();
  reads = 0;

  seed(key: string, value: string): void {
    this.entries.set(key, value);
  }

  get(key: string, options?: RosterKVGetOptions): Promise<string | null>;
  get(keys: string[], options?: RosterKVGetOptions): Promise<Map<string, string | null>>;
  async get(
    key: string | string[],
    _options?: RosterKVGetOptions,
  ): Promise<string | null | Map<string, string | null>> {
    this.reads += 1;
    if (Array.isArray(key)) {
      const out = new Map<string, string | null>();
      for (const item of key) out.set(item, this.entries.get(item) ?? null);
      return out;
    }
    return this.entries.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

// LongKeyRejectingKV 模拟真实 KV 的键长上限（512 字节）：超过就抛错。
// 用于证明「store 抛错 -> data_unavailable」覆盖的是全部抛错，而不只是
// index 解析失败那一支。
class LongKeyRejectingKV extends FakeRosterKV {
  private static readonly KEY_LIMIT = 512;

  private assertKey(key: string): void {
    if (new TextEncoder().encode(key).length > LongKeyRejectingKV.KEY_LIMIT) {
      throw new Error("KV rejected: key exceeds 512 bytes");
    }
  }

  override async put(key: string, value: string): Promise<void> {
    this.assertKey(key);
    await super.put(key, value);
  }

  override async delete(key: string): Promise<void> {
    this.assertKey(key);
    await super.delete(key);
  }
}

// rosterJson 构造上游 build_hierarchy_json.py 形状的名单原文。
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

// adminRequest 造一个管理端点请求。token 传 undefined 表示完全不带 Authorization 头，
// 传字符串则按 `Bearer <token>` 组装；authorization 可传原串以覆盖畸形格式的用例。
function adminRequest(
  path: string,
  options: {
    method?: string;
    token?: string;
    authorization?: string;
    body?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (options.authorization !== undefined) {
    headers.Authorization = options.authorization;
  } else if (options.token !== undefined) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) {
    init.body = options.body;
  }
  return new Request(`https://fmc.example${path}`, init);
}

// seededKV 是已上传一所学校的 KV：index 声明福清一中，原文两名学生。
function seededKV(): FakeRosterKV {
  const kv = new FakeRosterKV();
  kv.seed(rosterIndexKey, JSON.stringify(["福清一中"]));
  kv.seed(rosterKey("福清一中"), rosterJson("福清一中", "高一", { "1班": ["张伟"], "2班": ["张敏"] }));
  return kv;
}

// adminCtx 组装 handler 的依赖：真实 store 包 fake KV，并给出正确的 token。
function adminCtx(kv: FakeRosterKV, adminToken = TOKEN): { store: RosterStore; adminToken: string } {
  return { store: new RosterStore(kv), adminToken };
}

describe("verifyBearer", () => {
  // 缺头与错 token 只答同一个布尔，调用点无从区分（避免泄露「头格式对不对」）。
  it("缺 Authorization 头、非 Bearer 格式、空 token 一律 false", () => {
    expect(verifyBearer(adminRequest("/api/admin/roster"), TOKEN)).toBe(false);
    expect(verifyBearer(adminRequest("/api/admin/roster", { authorization: `Basic ${TOKEN}` }), TOKEN)).toBe(false);
    expect(verifyBearer(adminRequest("/api/admin/roster", { authorization: "Bearer" }), TOKEN)).toBe(false);
    expect(verifyBearer(adminRequest("/api/admin/roster", { authorization: "Bearer " }), TOKEN)).toBe(false);
  });

  // scheme 大小写不敏感（RFC 7235 的 auth-scheme 本就如此），token 逐字比较。
  it("scheme 大小写不敏感、正确 token 为 true、错 token 为 false", () => {
    expect(verifyBearer(adminRequest("/api/admin/roster", { authorization: `bearer ${TOKEN}` }), TOKEN)).toBe(true);
    expect(verifyBearer(adminRequest("/api/admin/roster", { token: TOKEN }), TOKEN)).toBe(true);
    expect(verifyBearer(adminRequest("/api/admin/roster", { token: `${TOKEN}x` }), TOKEN)).toBe(false);
    expect(verifyBearer(adminRequest("/api/admin/roster", { token: TOKEN.slice(0, 10) }), TOKEN)).toBe(false);
  });

  // 长度不等不得抛异常：默认比较（node 下走降级实现）必须先比长度再比内容，
  // timingSafeEqual 对不等长缓冲会抛，若不做这层守卫，一条畸形头就是 500。
  // 40 字节那一侧用 ASCII：HTTP 头值只能是 latin-1 字节，塞中文会在构造 Request
  // 时被 Headers 直接拒绝，测不到比较逻辑。
  it("长度不等（5 字节 vs 40 字节）不抛异常，平稳返回 false", () => {
    expect(() => verifyBearer(adminRequest("/api/admin/roster", { token: "short" }), TOKEN)).not.toThrow();
    expect(verifyBearer(adminRequest("/api/admin/roster", { token: "short" }), TOKEN)).toBe(false);
    expect(verifyBearer(adminRequest("/api/admin/roster", { token: "x".repeat(40) }), TOKEN)).toBe(false);
  });

  // 未配置 token 的部署（expected 为空串）绝不放行任何请求：
  // 否则一条空的 "Bearer " 头会与空 expected 相等，管理端点变成人人可写。
  //
  // 前三条（空凭据、空的 "Bearer "、缺头）只证明「格式守门」有效，删掉
  // expected 守卫它们照样全过——那是恒真断言。真正承重的是最后一条：
  // compare 恒返回 true（模拟平台比较对任意输入都答等），若没有 expected
  // 守卫，这里会是 true；有守卫才是 false。不注入 compare 就测不到这条。
  it("expected 为空串时任何请求都是 false，包括空 token", () => {
    expect(verifyBearer(adminRequest("/api/admin/roster", { token: "" }), "")).toBe(false);
    expect(verifyBearer(adminRequest("/api/admin/roster", { authorization: "Bearer " }), "")).toBe(false);
    expect(verifyBearer(adminRequest("/api/admin/roster"), "")).toBe(false);
    // 承重用例：凭据格式合法、compare 恒等，唯一的拒绝理由是 expected 为空。
    expect(verifyBearer(adminRequest("/api/admin/roster", { token: "x" }), "", () => true)).toBe(false);
  });

  // expected 为 null（不是空串）是另一条活口：TextEncoder().encode(null) 得到
  // 4 字节的 "null" 而不是 0 字节，于是 "Authorization: Bearer null" 与之等长
  // 全等、认证通过。装配层写 env.ADMIN_TOKEN ?? null、或测试注入 null 时，
  // 只有 typeof 守卫能拦住它——空串守卫拦不住，长度闸门也拦不住。
  it("expected 为 null 时一律 false，即使凭据正是字符串 null", () => {
    const nullToken = null as unknown as string;
    expect(verifyBearer(adminRequest("/api/admin/roster", { token: "null" }), nullToken)).toBe(false);
    expect(verifyBearer(adminRequest("/api/admin/roster", { token: "null" }), nullToken, () => true)).toBe(false);
    expect(verifyBearer(adminRequest("/api/admin/roster", { token: TOKEN }), nullToken)).toBe(false);
  });

  // 注入的 compare 是唯一比较入口：(provided, expected) 的顺序是契约，
  // 换实现（真实 timingSafeEqual / 假函数）不影响上方任何一条判定。
  it("compare 可注入且以 (provided, expected) 顺序调用", () => {
    const compare = vi.fn((provided: string, expected: string) => provided === "same");
    expect(verifyBearer(adminRequest("/api/admin/roster", { token: "same" }), TOKEN, compare)).toBe(true);
    expect(compare).toHaveBeenLastCalledWith("same", TOKEN);
    expect(verifyBearer(adminRequest("/api/admin/roster", { token: "other" }), TOKEN, compare)).toBe(false);
  });
});

describe("isAdminPath", () => {
  it("判定 /api/admin/roster 及其子路径", () => {
    expect(isAdminPath("/api/admin/roster")).toBe(true);
    expect(isAdminPath("/api/admin/roster/")).toBe(true);
    expect(isAdminPath(`/api/admin/roster/${encodeURIComponent("福清一中")}`)).toBe(true);
  });

  it("相邻路径与公共端点不误判", () => {
    expect(isAdminPath("/api/search")).toBe(false);
    expect(isAdminPath("/api/schools")).toBe(false);
    expect(isAdminPath("/api/admin")).toBe(false);
    // 前缀相同但多字符：若不判分隔符，这里会被当成管理端点。
    expect(isAdminPath("/api/admin/rosterX")).toBe(false);
  });
});

describe("adminHandlers 认证", () => {
  // 缺头与错 token 逐字同一响应：状态、体、头都不区分，避免以外观差异泄露原因。
  // 三条用例共用同一次比对——整集比较 headers 而不是逐个取，任何一处
  //（包括将来新增的头）多出差异都会翻红。
  it("缺 Authorization 头与错 token 都返回 401 unauthorized，响应逐字相同", async () => {
    const kv = seededKV();
    const ctx = adminCtx(kv);

    const missing = await adminHandlers(adminRequest("/api/admin/roster"), ctx);
    const wrongToken = await adminHandlers(adminRequest("/api/admin/roster", { token: "wrong-token-here" }), ctx);
    const wrongLength = await adminHandlers(adminRequest("/api/admin/roster", { token: "short" }), ctx);

    const bodies: string[] = [];
    for (const res of [missing, wrongToken, wrongLength]) {
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('{"error":"unauthorized"}');
    }
    // 整集比较：status、全部头、body 三者完全一致，缺头与错 token 无从区分。
    for (const res of [missing, wrongToken, wrongLength]) bodies.push(JSON.stringify([res.status, [...res.headers].sort()]));
    expect(new Set(bodies).size).toBe(1);

    // RFC 7235 规定 401 应当带 WWW-Authenticate，告知客户端该用哪种 scheme。
    expect(missing.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  // 认证先于方法与路径：未认证的请求不该拿到 405 / 404 这类「这个方法/这个路径
  // 存在」的信号，也不该触发任何 KV 读。用满 KV 加零读断言——空 KV 上零读
  // 可能是因为「没数据所以没读」，满 KV 上的零读才证明顺序真的是认证在前。
  it("未认证时不校验方法与路径，且零读 KV", async () => {
    const kv = seededKV();
    const cases = [
      adminRequest("/api/admin/roster", { method: "POST" }),
      adminRequest(`/api/admin/roster/${encodeURIComponent("福清一中")}`, { method: "DELETE" }),
      adminRequest("/api/admin/roster/不存在的校名", { method: "PUT", body: "{}" }),
    ];

    for (const request of cases) {
      const res = await adminHandlers(request, adminCtx(kv));
      expect(res.status, request.method).toBe(401);
      expect(res.headers.get("Allow")).toBeNull();
    }

    expect(kv.reads).toBe(0);
    expect(kv.entries.get(rosterIndexKey)).toBe(JSON.stringify(["福清一中"]));
  });
});

describe("adminHandlers PUT", () => {
  it("成功返回 201 {school, students} 并落 KV 与 index", async () => {
    const kv = new FakeRosterKV();
    const store = new RosterStore(kv);
    const payload = rosterJson("福清二中", "高三", { "3班": ["李强", "王芳"] });

    const res = await adminHandlers(
      adminRequest("/api/admin/roster/%E7%A6%8F%E6%B8%85%E4%BA%8C%E4%B8%AD", { method: "PUT", token: TOKEN, body: payload }),
      { store, adminToken: TOKEN },
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ school: "福清二中", students: 2 });

    expect(kv.entries.get(rosterKey("福清二中"))).toBe(payload);
    expect(kv.entries.get(rosterIndexKey)).toBe(JSON.stringify(["福清二中"]));
  });

  // 路径里的 school 必须 decodeURIComponent 后再落键：编码过的中文若不解码，
  // 键会变成 "roster:%E7%A6%8F..."，index 里也会出现一串转义，前端下拉永远对不上。
  it("路径 school 解码后再落键，覆盖已存在的学校不重复写 index", async () => {
    const kv = seededKV();
    const payload = rosterJson("福清一中", "高一", { "1班": ["张伟"] });

    const res = await adminHandlers(
      adminRequest(`/api/admin/roster/${encodeURIComponent("福清一中")}`, { method: "PUT", token: TOKEN, body: payload }),
      adminCtx(kv),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ school: "福清一中", students: 1 });
    expect(kv.entries.get(rosterKey("福清一中"))).toBe(payload);
    // 已存在，index 不变。
    expect(kv.entries.get(rosterIndexKey)).toBe(JSON.stringify(["福清一中"]));
  });

  // 校名前后空白在落键时归一：带空白的路径段与不带空白的同一项必须是同一个键。
  it("路径 school 的 Go 空白被归一后再落键", async () => {
    const kv = new FakeRosterKV();
    const payload = rosterJson("福清一中", "高一", { "1班": ["张伟"] });

    const res = await adminHandlers(
      adminRequest(`/api/admin/roster/${encodeURIComponent("  福清一中  ")}`, { method: "PUT", token: TOKEN, body: payload }),
      adminCtx(kv),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ school: "福清一中", students: 1 });
    expect(kv.entries.get(rosterKey("福清一中"))).not.toBeNull();
  });

  // 校验失败：400 + 固定码 invalid_roster + 加载侧逐字文案，且一个字节都不落 KV。
  //
  // 断言是「委托给 store 一次、KV 零写入」而非「store 从未被调用」：清单校验的
  // 唯一 owner 是 rosterStore.putRoster（它内部走 shared/roster.ts），handler 若
  // 自己先校验一遍就成了第二个 owner，两处判定必然分叉。所以这条用例钉的是
  // 「校验责任在 store、失败后 KV 干净」，不是「handler 抢着校验」。
  it("名单校验失败返回 400 invalid_roster，message 取加载侧文案，且不写 KV", async () => {
    const kv = new FakeRosterKV();
    const store = new RosterStore(kv);
    const putSpy = vi.spyOn(store, "putRoster");
    const payload = rosterJson("福清一中", "高一", { "0班": ["张伟"] });

    const res = await adminHandlers(
      adminRequest(`/api/admin/roster/${encodeURIComponent("福清一中")}`, { method: "PUT", token: TOKEN, body: payload }),
      { store, adminToken: TOKEN },
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    const body = await res.json();
    expect(body.error).toBe("invalid_roster");
    expect(body.message).toContain("班级格式异常");
    // 文案里带校名与年级，与加载侧 parseRosterDocument 的形态一致。
    expect(body.message).toContain("福清一中");
    expect(putSpy).toHaveBeenCalledTimes(1);
    // 校验前置的硬约束落在这里：失败后 KV 键空间必须仍是空的。
    expect(kv.entries.size).toBe(0);
  });

  it("body 不是 JSON 时同样 400 invalid_roster", async () => {
    const kv = new FakeRosterKV();
    const res = await adminHandlers(
      adminRequest(`/api/admin/roster/${encodeURIComponent("福清一中")}`, { method: "PUT", token: TOKEN, body: "不是 JSON" }),
      adminCtx(kv),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_roster");
    expect(body.message).toContain("解析 福清一中 失败");
  });

  // 空校名段不是 PUT 的合法目标，但要分两种情况：
  // 无尾斜杠的集合路径上 PUT 是「方法不对」——Allow: GET 能告诉客户端该改用
  // 哪个方法；带尾斜杠的空段才是「指向一个不存在的校名」，答 404。
  it("集合路径的 PUT 返回 405 Allow: GET，尾斜杠空校名段返回 404", async () => {
    const kv = new FakeRosterKV();

    const collection = await adminHandlers(
      adminRequest("/api/admin/roster", { method: "PUT", token: TOKEN, body: "{}" }),
      adminCtx(kv),
    );
    expect(collection.status).toBe(405);
    expect(collection.headers.get("Allow")).toBe("GET");
    expect(await collection.json()).toEqual({ error: "method_not_allowed" });

    const emptySegment = await adminHandlers(
      adminRequest("/api/admin/roster/", { method: "PUT", token: TOKEN, body: "{}" }),
      adminCtx(kv),
    );
    expect(emptySegment.status).toBe(404);
    expect(await emptySegment.json()).toEqual({ error: "not_found" });
  });

  // 畸形百分号转义（decodeURIComponent 会抛 URIError）不得变成 500。
  it("畸形百分号转义的 PUT 返回 404 not_found 而不是抛错", async () => {
    const kv = new FakeRosterKV();
    const res = await adminHandlers(adminRequest("/api/admin/roster/%E0%A4", { method: "PUT", token: TOKEN, body: "{}" }), adminCtx(kv));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  // 路径段里的控制字符（如 %00 解出 \u0000）必须拒绝：NUL 正是 shared/roster.ts
  // 用来拼去重键的分隔符（KEY_SEPARATOR），含 NUL 的校名会让「两段拼起来相同但
  // 分段不同」的记录无法区分。它同时也会让 index 里出现不可见字符，肉眼对不上。
  it("含控制字符的路径段返回 400 invalid_roster，且不写 KV", async () => {
    const kv = new FakeRosterKV();
    const res = await adminHandlers(
      adminRequest("/api/admin/roster/%00", { method: "PUT", token: TOKEN, body: rosterJson("x", "高一", { "1班": ["y"] }) }),
      adminCtx(kv),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_roster");
    expect(kv.entries.size).toBe(0);
  });
});

// C-1：校名 index 与索引键 roster:index 撞名。rosterKey("index") 恰好等于
// rosterIndexKey——「roster:」前缀是校名的命名空间，而索引本身住在里面，
// 是那个命名空间里唯一的保留成员。管理端是唯一能提交任意校名的入口，因此
// 这条边界必须在这里之前就由存储层守住，而不是指望调用点不来。
//
// 撞名的后果不可逆且无告警，两条路径都是数据销毁：
//   PUT  .../index 把整份名单原文写进 roster:index → index 不再是学校名数组，
//                   下一次 GET 解析失败答 500，loadAll 全站失败；
//   DELETE .../index 删掉 roster:index → 其余学校原文成孤儿，GET 答
//                   {"schools":[]}，伪装成「从没上传过」，管理员查不出根因。
// 响应还会与副作用完全相反：PUT 答 400「名单内容不合法」，管理员以为重传即可。
describe("保留校名 index 不可作为目标（C-1）", () => {
  const encodedIndex = encodeURIComponent("index");

  it("PUT 校名 index 返回 400，index 与 KV 均未被改动", async () => {
    const kv = seededKV();
    const payload = rosterJson("index", "高一", { "1班": ["张伟"] });

    const res = await adminHandlers(
      adminRequest(`/api/admin/roster/${encodedIndex}`, { method: "PUT", token: TOKEN, body: payload }),
      adminCtx(kv),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_roster");
    expect(body.message).toContain("保留");
    // 数据销毁的判据：index 仍是原来的学校名数组，且没有多出任何键。
    expect(kv.entries.get(rosterIndexKey)).toBe(JSON.stringify(["福清一中"]));
    expect(kv.entries.size).toBe(2);
  });

  it("DELETE 校名 index 返回 400，index 未被删除", async () => {
    const kv = seededKV();

    const res = await adminHandlers(
      adminRequest(`/api/admin/roster/${encodedIndex}`, { method: "DELETE", token: TOKEN }),
      adminCtx(kv),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_roster");
    // 关键断言：index 键必须还在，否则其余学校原文全成孤儿。
    expect(kv.entries.get(rosterIndexKey)).toBe(JSON.stringify(["福清一中"]));
    expect(kv.entries.get(rosterKey("福清一中"))).not.toBeUndefined();
  });

  // 编码形态绕不过去：解码后落键形态相同，判定必须在归一之后。
  it("编码形态 ind%65x 同样被拒绝", async () => {
    const kv = seededKV();
    const payload = rosterJson("index", "高一", { "1班": ["张伟"] });

    const res = await adminHandlers(
      adminRequest("/api/admin/roster/ind%65x", { method: "PUT", token: TOKEN, body: payload }),
      adminCtx(kv),
    );

    expect(res.status).toBe(400);
    expect(kv.entries.get(rosterIndexKey)).toBe(JSON.stringify(["福清一中"]));
  });

  // 校名判定在剥空白之后：带空白的 " index " 归一后同样是保留名。
  it("带前后空白的 index 同样被拒绝", async () => {
    const kv = seededKV();
    const res = await adminHandlers(
      adminRequest(`/api/admin/roster/${encodeURIComponent("  index  ")}`, { method: "DELETE", token: TOKEN }),
      adminCtx(kv),
    );

    expect(res.status).toBe(400);
    expect(kv.entries.get(rosterIndexKey)).toBe(JSON.stringify(["福清一中"]));
  });
});

describe("adminHandlers DELETE 的错误处置（I-2）", () => {
  // index 损坏时 DELETE 必须与 GET 列表同答 500 data_unavailable，而不是把
  // 异常冒泡成货真价实的 500 或另一套错误码。同一份「index 坏了」在 GET 得
  // data_unavailable（说「去修数据」）、在这里若得别的码（说「这是代码 bug」），
  // 排障方向就被引偏一层。
  it("index 损坏返回 500 data_unavailable，与 GET 列表同码", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, "不是 JSON");

    const res = await adminHandlers(
      adminRequest(`/api/admin/roster/${encodeURIComponent("福清一中")}`, { method: "DELETE", token: TOKEN }),
      adminCtx(kv),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ error: "data_unavailable" });
  });

  // 触发面比「index 损坏」宽：KV 对键长有上限（512 字节），超长校名会让
  // delete 本身抛错。这条同样必须翻译成 data_unavailable 而不是裸 500——
  // 用它证明 catch 覆盖的是 store 的一切抛错，而不只是 index 解析失败这一支。
  it("超长校名导致 KV 拒删时返回 500 data_unavailable", async () => {
    // 用一个会拒绝超长键的 KV：真实 KV 对 512 字节以上的键直接报错。
    const kv = new LongKeyRejectingKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中"]));

    const res = await adminHandlers(
      adminRequest(`/api/admin/roster/${encodeURIComponent("症".repeat(200))}`, { method: "DELETE", token: TOKEN }),
      adminCtx(kv),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ error: "data_unavailable" });
  });
});

describe("adminHandlers DELETE", () => {
  it("删除已存在的学校返回 200 {deleted:true} 并清掉原文与 index 项", async () => {
    const kv = seededKV();
    const res = await adminHandlers(
      adminRequest(`/api/admin/roster/${encodeURIComponent("福清一中")}`, { method: "DELETE", token: TOKEN }),
      adminCtx(kv),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ deleted: true });
    expect(kv.entries.get(rosterKey("福清一中"))).toBeUndefined();
    expect(kv.entries.get(rosterIndexKey)).toBe(JSON.stringify([]));
  });

  it("删除不存在的学校返回 404 not_found", async () => {
    const kv = seededKV();
    const res = await adminHandlers(
      adminRequest(`/api/admin/roster/${encodeURIComponent("福清九中")}`, { method: "DELETE", token: TOKEN }),
      adminCtx(kv),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    // 其余学校不受影响。
    expect(kv.entries.get(rosterIndexKey)).toBe(JSON.stringify(["福清一中"]));
  });
});

describe("adminHandlers GET 列表", () => {
  it("返回 200 单键 schools，取自 index 且未上传时为自然空态", async () => {
    const kv = seededKV();
    const res = await adminHandlers(adminRequest("/api/admin/roster", { token: TOKEN }), adminCtx(kv));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ schools: ["福清一中"] });

    const empty = await adminHandlers(adminRequest("/api/admin/roster", { token: TOKEN }), adminCtx(new FakeRosterKV()));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ schools: [] });
  });

  // index 被写坏时列表无法给出可信答案：映射 data_unavailable（500），
  // 与公共端点「取不到数据」同码，不新增管理端专属码。
  it("index 损坏返回 500 data_unavailable", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, "不是 JSON");

    const res = await adminHandlers(adminRequest("/api/admin/roster", { token: TOKEN }), adminCtx(kv));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "data_unavailable" });
  });
});

describe("adminHandlers 方法限定", () => {
  it("集合路径的非 GET 返回 405 与 Allow: GET", async () => {
    const kv = seededKV();
    const res = await adminHandlers(adminRequest("/api/admin/roster", { method: "POST", token: TOKEN }), adminCtx(kv));

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });

  it("单校路径的非 PUT/DELETE 返回 405 与 Allow: PUT, DELETE", async () => {
    const kv = seededKV();
    const res = await adminHandlers(
      adminRequest(`/api/admin/roster/${encodeURIComponent("福清一中")}`, { method: "GET", token: TOKEN }),
      adminCtx(kv),
    );

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("PUT, DELETE");
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });
});
