// HTTP 翻译层的回归测试，用例从 Go 端 server/main_test.go 与 server/api.go 的行为平移：
// TestHealthReflectsDataAvailability（200 / 503 degraded）、TestHealthMethodNotAllowed、
// TestUnknownAPIJSON404、TestSearchResponseKeys（响应键白名单）、
// TestSearchDataUnavailable、TestSearchMethodNotAllowed、
// TestSearchRejectsOutOfRangeParameters、TestSearchRejectsOverlongQuery、
// TestSearchAcceptsBoundaryParameters，并补上 schools 端点与健康检查差集降级
// （评审要求的前端可观测降级信号）。
//
// 上面列出的每个 Go 用例名都必须在本文件里有一条对应断言，否则这条清单就是
// 虚假覆盖声明——评审轮 1 正是凭这份清单发现 health 的 405 契约无人承接。
// 改动本文件时请顺手核对清单与实际用例：新增名字要有用例，删用例要删名字。
//
// store 用真实的 RosterStore 加内存 fake KV 注入，而不是伪造一个 store 对象：
// 「store 抛错 -> 500」这类用例的真实来源是 KV 里 index 缺失或文档损坏，
// 用真实 store 才能让这条路径走完整实现，也不必对 RosterStore 的私有字段做类型断言。
// 全部用例在 node 环境可跑，不需要 workerd 与真实 KV 绑定。
import { describe, expect, it } from "vitest";
import { PAGE_SIZE } from "../shared/contract";
import { newStudentSchool, type RosterStudent } from "../shared/student";
import { healthHandler, notFoundHandler, schoolsHandler, searchHandler, toWireStudent } from "./handlers";
import { RosterStore, rosterIndexKey, rosterKey, type RosterKV, type RosterKVGetOptions } from "./rosterStore";

// 与 errors.ts 同一份 JSON Content-Type，逐字对齐 Go 端 writeJSON。
const jsonContentType = "application/json; charset=utf-8";

// FakeRosterKV 是 RosterKV 的内存实现：entries 模拟 KV 键值空间，
// singleReads / batchReads 供断言「方法限定的拒绝发生在读数据之前」。
//
// indexBurst 按读取顺序接管 roster:index 的单键读取，用完回落到 entries。
// 元素允许 null：真实 KV 对缺失键返回的就是 null，这条能造出「第二次读 index
// 时它已经消失」的分支。它唯一的用途是造出「loadAll 读到的 index 正常、
// 随后 listSchools 读到的 index 坏掉或消失」这种真实 KV 里难以出现、
// 但实现里确实存在的分支（健康检查的第二次 index 读取）。
class FakeRosterKV implements RosterKV {
  private readonly entries = new Map<string, string>();
  indexBurst: Array<string | null> = [];
  readonly singleReads: string[] = [];
  readonly batchReads: string[][] = [];

  seed(key: string, value: string): void {
    this.entries.set(key, value);
  }

  get(key: string, options?: RosterKVGetOptions): Promise<string | null>;
  get(keys: string[], options?: RosterKVGetOptions): Promise<Map<string, string | null>>;
  async get(
    key: string | string[],
    _options?: RosterKVGetOptions,
  ): Promise<string | null | Map<string, string | null>> {
    if (Array.isArray(key)) {
      this.batchReads.push(key);
      const out = new Map<string, string | null>();
      for (const item of key) out.set(item, this.entries.get(item) ?? null);
      return out;
    }
    this.singleReads.push(key);
    if (key === rosterIndexKey && this.indexBurst.length > 0) {
      return this.indexBurst.shift() ?? null;
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

// rosterJson 构造上游 build_hierarchy_json.py 形状的名单原文：
// 区县 / 学校[校名 / 年级[年级名 / 班级[班名 / 学生[姓名]]]]。
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

// fullKV 是正常两校语料：福清一中两名「张」姓学生、福清二中一名「李」姓学生。
// 用两校是为了同时能验证学校过滤与「差集为空 -> 健康 200」。
function fullKV(): FakeRosterKV {
  const kv = new FakeRosterKV();
  kv.seed(rosterIndexKey, JSON.stringify(["福清一中", "福清二中"]));
  kv.seed(
    rosterKey("福清一中"),
    rosterJson("福清一中", "高一", { "1班": ["张伟"], "2班": ["张敏"] }),
  );
  kv.seed(rosterKey("福清二中"), rosterJson("福清二中", "高三", { "3班": ["李强"] }));
  return kv;
}

// getRequest 造一个 GET 请求。URL 用固定基址，路径与查询串由调用点给。
function getRequest(path: string, method = "GET"): Request {
  return new Request(`https://fmc.example${path}`, { method });
}

// sortedKeys 取对象的键名并按字典序排列：用于「键集合逐字相等」的断言，
// 键顺序不属于 JSON 契约，键名与数量才是。
function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

// 成功搜索响应的五个键，逐字对齐 Go 端 SearchResponse 的 json tag。
const RESPONSE_KEYS = ["hasMore", "items", "limit", "offset", "total"];

// item 的四个键，逐字对齐 Go 端 search.go 的 Student json tag（班级字段是 class）。
const ITEM_KEYS = ["class", "grade", "name", "school"];

// 隐私红线：领域派生字段与 Go 端导出字段名都不得出现在 wire 上。
const BANNED_KEYS = ["nameKey", "NameKey", "className", "ClassName", "classNo", "ClassNo", "gradeIdx", "GradeIdx", "schoolIdx", "SchoolIdx"];

describe("searchHandler 方法限定", () => {
  // 非 GET 一律 405 并声明 Allow: GET。KV 留空：若实现先读数据再判方法，
  // 这里会因为 index 缺失先抛出 500 而不是 405，顺序被这条断言钉住。
  it("非 GET 返回 405、Allow: GET 与 method_not_allowed 体，且不读 KV", async () => {
    const kv = new FakeRosterKV();
    const res = await searchHandler(getRequest("/api/search?q=%E5%BC%A0", "POST"), {
      store: new RosterStore(kv),
    });

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
    expect(kv.singleReads).toEqual([]);
    expect(kv.batchReads).toEqual([]);
  });
});

describe("searchHandler 参数校验", () => {
  // 与 Go 的 TestSearchRejectsOutOfRangeParameters 同形：limit 越界与非数字、
  // offset 为负与非数字，四个格各自映射到对应错误码。
  const rejected: Array<{ query: string; code: string }> = [
    { query: "limit=0", code: "invalid_limit" },
    { query: "limit=51", code: "invalid_limit" },
    { query: "limit=abc", code: "invalid_limit" },
    { query: "limit=12.5", code: "invalid_limit" },
    { query: "offset=-1", code: "invalid_offset" },
    { query: "offset=xyz", code: "invalid_offset" },
    // 小数在 Go 侧是 Atoi 的语法错误（不是「取整后合法」）。
    { query: "offset=1.5", code: "invalid_offset" },
    // 超出 int64 的数字同样会让 Atoi 报错，因此也是 400。
    { query: "offset=9223372036854775808", code: "invalid_offset" },
  ];

  for (const { query, code } of rejected) {
    it(`?${query} 返回 400 ${code}`, async () => {
      const res = await searchHandler(getRequest(`/api/search?q=%E5%BC%A0&${query}`), {
        store: new RosterStore(fullKV()),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get("Content-Type")).toBe(jsonContentType);
      expect(await res.json()).toEqual({ error: code });
    });
  }

  // 合法边界不得被一票否决：limit=1、limit=50、offset=0 都应是 200。
  it("limit=1 / limit=50 / offset=0 均返回 200", async () => {
    for (const query of ["limit=1", "limit=50", "offset=0"]) {
      const res = await searchHandler(getRequest(`/api/search?q=%E5%BC%A0&${query}`), {
        store: new RosterStore(fullKV()),
      });
      expect(res.status, query).toBe(200);
    }
  });

  // 空值等价于「没传」：Go 的 url.Query().Get 对 ?limit= 与缺省都返回空串，
  // 因此两者都取默认值，不得当作非数字去报 400。
  it("limit= 空值按未提供处理，取默认 PAGE_SIZE", async () => {
    const res = await searchHandler(getRequest("/api/search?q=%E5%BC%A0&limit="), {
      store: new RosterStore(fullKV()),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).limit).toBe(PAGE_SIZE);
  });

  // 查询串上限按 rune 计而不是 UTF-16 长度：80 个 emoji 的 .length 是 160，
  // 若实现用 q.length 判定，这条会以 400 翻红。
  it("q 超 80 rune 返回 400 invalid_query，80 rune 通过（rune 计不含代理对）", async () => {
    const okRes = await searchHandler(getRequest(`/api/search?q=${"😀".repeat(80)}`), {
      store: new RosterStore(fullKV()),
    });
    expect(okRes.status).toBe(200);

    const overRes = await searchHandler(getRequest(`/api/search?q=${"😀".repeat(81)}`), {
      store: new RosterStore(fullKV()),
    });
    expect(overRes.status).toBe(400);
    expect(await overRes.json()).toEqual({ error: "invalid_query" });
  });

  // school 与 q 共用同一上限，超限同样映射 invalid_query（Go 端逐字如此）。
  it("school 超 80 rune 返回 400 invalid_query", async () => {
    const res = await searchHandler(getRequest(`/api/search?q=%E5%BC%A0&school=${"😀".repeat(81)}`), {
      store: new RosterStore(fullKV()),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_query" });
  });
});

describe("searchHandler 数据不可用", () => {
  // KV 里没有 index 等价于 Go 端的名单目录为空：loadAll fail-closed 抛错，
  // handler 映射为 500 data_unavailable。
  it("store 抛错返回 500 data_unavailable", async () => {
    const res = await searchHandler(getRequest("/api/search?q=%E5%BC%A0"), {
      store: new RosterStore(new FakeRosterKV()),
    });

    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ error: "data_unavailable" });
  });

  it("名单原文损坏同样返回 500 data_unavailable", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中"]));
    kv.seed(rosterKey("福清一中"), '{"学校":[{"校名":"福清一中"');

    const res = await searchHandler(getRequest("/api/search?q=%E5%BC%A0"), {
      store: new RosterStore(kv),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "data_unavailable" });
  });
});

describe("searchHandler 成功响应", () => {
  // 五字段形状：items/total/limit/offset/hasMore，键名逐字，且不多不少。
  it("响应恰好五个键，分页字段来自搜索结果的钳制值", async () => {
    const res = await searchHandler(getRequest("/api/search?q=%E5%BC%A0"), {
      store: new RosterStore(fullKV()),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    const body = await res.json();

    expect(sortedKeys(body)).toEqual(RESPONSE_KEYS);
    expect(body.limit).toBe(PAGE_SIZE);
    expect(body.offset).toBe(0);
    expect(body.total).toBe(2);
    expect(body.items.length).toBe(2);
    expect(body.hasMore).toBe(false);
  });

  // hasMore 的临界：两条匹配、limit=1 时本页取完仍有剩余，必须为 true。
  it("limit=1 时 total 为匹配总数、hasMore 为 true", async () => {
    const res = await searchHandler(getRequest("/api/search?q=%E5%BC%A0&limit=1"), {
      store: new RosterStore(fullKV()),
    });

    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.items.length).toBe(1);
    expect(body.limit).toBe(1);
    expect(body.hasMore).toBe(true);
  });

  // item 键名逐字为 name/school/grade/class（class 不是 className），
  // 且 nameKey/classNo/gradeIdx/schoolIdx 一律不出现在响应里（隐私红线）。
  // 这条正是 Go 端 TestSearchResponseKeys 的平移，多一个键就翻红。
  it("item 恰好四个键 name/school/grade/class，无派生字段泄漏", async () => {
    const res = await searchHandler(getRequest("/api/search?q=%E5%BC%A0"), {
      store: new RosterStore(fullKV()),
    });

    const body = await res.json();
    expect(body.items.length).toBe(2);
    for (const raw of body.items) {
      expect(sortedKeys(raw)).toEqual(ITEM_KEYS);
      for (const banned of BANNED_KEYS) {
        expect(banned in raw, `响应不应含字段 ${banned}`).toBe(false);
      }
    }

    // 字段值本身也要对：班级取领域 className，年段取领域 grade。
    expect(body.items[0]).toEqual({ name: "张伟", school: "福清一中", grade: "高一", class: "1班" });
  });

  // 学校过滤：school 先剥空白再精确匹配。若实现直接拿原始值比较，
  // 带空白的 school 会匹配不到任何学校。
  it("school 剥空白后精确过滤，且响应仍是白名单形状", async () => {
    const res = await searchHandler(getRequest(`/api/search?q=%E6%9D%8E&school=${encodeURIComponent("  福清二中  ")}`), {
      store: new RosterStore(fullKV()),
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.items[0]).toEqual({ name: "李强", school: "福清二中", grade: "高三", class: "3班" });
  });

  // 空查询（无 q、无任何可解析条件）落空结果集，而不是全校返回。
  // 这是 search.ts 的守卫，此处确认 handler 没有把它绕过去。
  it("无 q 时返回空 items 与 total 0", async () => {
    const res = await searchHandler(getRequest("/api/search"), { store: new RosterStore(fullKV()) });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });
});

describe("toWireStudent wire 映射", () => {
  // 直接锁映射函数：四个键、班级落在 class、派生字段不出现。
  it("只产出 name/school/grade/class 四个键", () => {
    const student: RosterStudent = newStudentSchool("福清一中", "张伟", "高一", "1班", 1, 0);
    const wire = toWireStudent(student);

    expect(wire).toEqual({ name: "张伟", school: "福清一中", grade: "高一", class: "1班" });
    expect(sortedKeys(wire)).toEqual(ITEM_KEYS);
    expect("nameKey" in wire).toBe(false);
    expect("classNo" in wire).toBe(false);
    expect("gradeIdx" in wire).toBe(false);
    expect("schoolIdx" in wire).toBe(false);
  });
});

describe("schoolsHandler", () => {
  it("非 GET 返回 405 与 Allow: GET", async () => {
    const res = await schoolsHandler(getRequest("/api/schools", "PUT"), {
      store: new RosterStore(fullKV()),
    });

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });

  it("成功返回单键 schools，按加载序排列", async () => {
    const res = await schoolsHandler(getRequest("/api/schools"), { store: new RosterStore(fullKV()) });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    const body = await res.json();
    expect(sortedKeys(body)).toEqual(["schools"]);
    expect(body.schools).toEqual(["福清一中", "福清二中"]);
  });

  it("store 抛错返回 500 data_unavailable", async () => {
    const res = await schoolsHandler(getRequest("/api/schools"), {
      store: new RosterStore(new FakeRosterKV()),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "data_unavailable" });
  });
});

describe("healthHandler", () => {
  // 对应 Go 端 TestHealthMethodNotAllowed（server/main_test.go:62-78）：
  // 探针接口也必须是只读端点，非 GET 一律 405 并声明 Allow: GET，
  // 否则 /api/health 会成为全站唯一接受写方法的只读端点。
  //
  // 数据用满 KV 而不是空 KV：满数据下若方法判定被放到数据加载之后，
  // 状态码仍是 405（掩盖顺序错误），只有零 KV 读的断言会翻红——这条用例
  // 因此专门承重「判定先于读」这一顺序约束，而不是顺带验个状态码。
  it("非 GET 返回 405、Allow: GET 与 method_not_allowed 体，且不读 KV", async () => {
    const kv = fullKV();
    const res = await healthHandler(getRequest("/api/health", "POST"), {
      store: new RosterStore(kv),
      version: "v-test",
    });

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
    expect(kv.singleReads).toEqual([]);
    expect(kv.batchReads).toEqual([]);
  });

  // 数据完整：200 且体只有 status/version 两个键。
  it("数据完整返回 200 {status:ok, version}", async () => {
    const res = await healthHandler(getRequest("/api/health"), { store: new RosterStore(fullKV()), version: "v-test" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    const body = await res.json();
    expect(sortedKeys(body)).toEqual(["status", "version"]);
    expect(body).toEqual({ status: "ok", version: "v-test" });
  });

  // loadAll 失败：503 degraded，reason 为 data，且 503 也带 version。
  it("loadAll 抛错返回 503 degraded reason=data 且带 version", async () => {
    const res = await healthHandler(getRequest("/api/health"), { store: new RosterStore(new FakeRosterKV()), version: "v-test" });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(sortedKeys(body)).toEqual(["reason", "status", "version"]);
    expect(body).toEqual({ status: "degraded", reason: "data", version: "v-test" });
  });

  // 最终一致窗口：index 里有两校、本次只读到一校 -> 差集非空 -> 503 partial。
  // 若实现只看「有没有加载到任何一份」，这里会错答 200 并把「少一所」静默吞掉。
  it("差集非空（一校读不到）返回 503 degraded reason=partial", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中", "福清二中"]));
    kv.seed(rosterKey("福清一中"), rosterJson("福清一中", "高一", { "1班": ["张伟"] }));
    // 福清二中的 roster 尚未扩散到本 colo：批量读返回 null，被跳过。

    const res = await healthHandler(getRequest("/api/health"), { store: new RosterStore(kv), version: "v-test" });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "degraded", reason: "partial", version: "v-test" });
  });

  // 差集全量（一所都读不到）在 loadAll 里已 fail-closed，走 data 分支。
  it("全部学校读不到时 reason 为 data 而非 partial", async () => {
    const kv = new FakeRosterKV();
    kv.seed(rosterIndexKey, JSON.stringify(["福清一中", "福清二中"]));

    const res = await healthHandler(getRequest("/api/health"), { store: new RosterStore(kv), version: "v-test" });

    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe("data");
  });

  // 第二次 index 读取失败（listSchools 抛错）：按 loadAll 失败处理，仍是 503 data。
  it("listSchools 抛错按数据失败处理，返回 503 degraded reason=data", async () => {
    const kv = fullKV();
    kv.indexBurst = [JSON.stringify(["福清一中", "福清二中"]), "不是 JSON"];

    const res = await healthHandler(getRequest("/api/health"), { store: new RosterStore(kv), version: "v-test" });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "degraded", reason: "data", version: "v-test" });
  });

  // index 在两次读取之间消失：listSchools 对缺失返回空数组而不是抛错，
  // 因此这条路径必须由「声明集合为空」单独判成降级。若只在 catch 里兜底，
  // 这里会错答 200 ok——而探针此刻已经读不到索引了。
  it("index 在第二次读取时消失（声明集合为空）返回 503 degraded reason=data", async () => {
    const kv = fullKV();
    kv.indexBurst = [JSON.stringify(["福清一中", "福清二中"]), null];

    const res = await healthHandler(getRequest("/api/health"), { store: new RosterStore(kv), version: "v-test" });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "degraded", reason: "data", version: "v-test" });
  });
});

describe("notFoundHandler", () => {
  // 未知 /api/* 统一 JSON 404，与全站错误格式一致（Go 端 mux 的兜底路由）。
  it("返回 404 与单键 not_found 体", async () => {
    const res = notFoundHandler();

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
