/// <reference types="@cloudflare/vitest-plugin/types" />
// workerd 集成测试：用 cloudflare:test 的 SELF.fetch 打真实装配链，覆盖
// 路由分流、限流短路、错误边界与安全头契约。
//
// 与单元测试的分工（Ruling 4）：worker/handlers.test、admin.test、middleware.test
// 等留在 node 项目，它们用 fake store / fake KV 验证每条规则本身；本文件只验证
// 「这些规则被正确装配在一起」——装配顺序、短路行为、绑定取值。同一条规则在
// 两处都断言是刻意的：单元测试证明规则成立，集成测试证明装配没有绕过它。
//
// 用例清单对应 Go 端基线：
//   TestHealthReflectsDataAvailability   health 200 / 503（含 partial）
//   TestHealthMethodNotAllowed           health 非 GET -> 405 + Allow: GET
//   TestSearchResponseKeys               search 成功形状与 item 四键白名单
//   TestUnknownAPIJSON404                未知 /api/* -> 404 JSON
//   TestHandlerChainRateLimitedResponseCarriesSecurityHeaders  429 携带安全头
//
// 限流的验证方式（本任务的关键设计）：装配层的判定收在可注入的
// checkRateLimit(limiter, ip) 里，而 limiter 来自 env。因此注入假 limiter 不需要
// 任何测试专用钩子——直接调默认导出的 fetch(request, env, ctx)，把 env 换成
// 自己造的那一份即可。这一组用例因此断言的是**真实装配链**的 429 行为
// （状态、错误体、Retry-After、安全头），而不是一份与生产链并列的测试替身。
//
// 生产链（SELF.fetch）走的是 wrangler.jsonc 里的真实 binding，另有一组用例把
// 窗口真的打满来证明绑定确实接上了。两组缺一不可：
//   - 假 limiter：精确控制第几次开始拒绝，能断言「前 N 次放行、第 N+1 次拒绝」。
//   - 真实 binding：证明 wrangler.jsonc 的 ratelimits 声明与 env 取值对得上。
//
// 假 limiter 的 denial 语义照真实 API 的一次一计：每次 limit() 调用消耗一个
// 名额，前 N 次 success=true，之后 false。返回的 limiter 暴露 keys 数组，
// 让「限流键确实是客户端 IP」这条可以被断言。
function fakeLimiter(allowCount: number): { limiter: RateLimit; keys: string[] } {
  const keys: string[] = [];
  let remaining = allowCount;
  return {
    keys,
    limiter: {
      async limit(options: { key: string }): Promise<{ success: boolean }> {
        keys.push(options.key);
        if (remaining > 0) {
          remaining -= 1;
          return { success: true };
        }
        return { success: false };
      }
    }
  };
}

// makeEnv 造一份测试用绑定集合：KV 与 assets 取真实绑定（它们的行为就是要被
// 验证的那一份），只替换限流器。
function makeEnv(limiter: RateLimit): Env {
  return {
    ROSTER: env.ROSTER,
    API_RATE_LIMITER: limiter,
    ADMIN_TOKEN: env.ADMIN_TOKEN,
    VERSION: env.VERSION,
    ASSETS: env.ASSETS
  };
}
import { env, SELF, reset } from "cloudflare:test";
import worker, { checkRateLimit } from "./index";
import type { Env } from "./index";
import { afterEach, describe, expect, it } from "vitest";
import { rosterIndexKey, rosterKey } from "./rosterStore";
import type { RateLimit } from "@cloudflare/workers-types";

// 与 errors.ts / handlers.ts 同一份 JSON Content-Type。
const jsonContentType = "application/json; charset=utf-8";

// 六个安全头，逐字对齐 middleware.ts 的 SECURITY_HEADERS。
// 集成层用「存在且值正确」而不是「非空」：值被改宽松（例如 Permissions-Policy
// 丢掉 camera 禁用）同样要让这条翻红。
const EXPECTED_SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; font-src 'self'; style-src 'self' 'unsafe-inline'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store"
};

// expectSecurityHeaders 断言全站安全头齐备且值逐字正确。
// 抽成函数是因为它要贴在每一条状态码上反复使用：200 / 429 / 404 / 401，
// 哪一条漏了断言，那条响应就成了头部契约的例外。
function expectSecurityHeaders(response: Response, label: string): void {
  for (const [name, value] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
    expect(response.headers.get(name), `${label} 缺安全头 ${name}`).toBe(value);
  }
}

// rosterJson 构造上游 build_hierarchy_json.py 形状的名单原文。
// 形状必须真的是这一份：rosterStore 委托 shared/roster.ts 校验，
// 结构不对会在加载期就抛错，测试就会以「503 而不是 200」的形式失败，
// 看起来像装配层的问题。
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

// seedSchool 往真实 KV 里写一所学校的名单（先原文、后 index 顺序与 putRoster 一致）。
async function seedSchool(school: string, grade: string, classes: Record<string, string[]>): Promise<void> {
  await env.ROSTER.put(rosterKey(school), rosterJson(school, grade, classes));
}

// seedIndex 写学校名索引。index 是唯一事实源：不写它的 roster 原文不会被加载。
async function seedIndex(schools: string[]): Promise<void> {
  await env.ROSTER.put(rosterIndexKey, JSON.stringify(schools));
}

// seedTwoSchools 是健康与搜索用例的常规语料：两校各有学生，index 与原文齐全。
async function seedTwoSchools(): Promise<void> {
  await seedSchool("福清一中", "高一", { "1班": ["张伟"], "2班": ["张敏"] });
  await seedSchool("福清二中", "高三", { "3班": ["李强"] });
  await seedIndex(["福清一中", "福清二中"]);
}

// request 造一个带边缘客户端 IP 的请求。cf-connecting-ip 是 Workers 里限流键
// 的来源；每条用例用独立 IP，避免用例之间通过限流窗口互相污染——限流计数
// 跨请求存在，共享一个 IP 会让前面用例消耗掉的令牌把后面的断言打成 429。
function request(path: string, init?: RequestInit, ip = freshIP()): Request {
  const headers = new Headers(init?.headers);
  headers.set("cf-connecting-ip", ip);
  return new Request(`https://fmc.example${path}`, { ...init, headers });
}

// ipCounter 让每条请求拿到不同地址：198.18.0.0/15 是 RFC 2544 的基准测试网段，
// 不会与真实地址冲突，也便于在日志里一眼认出是测试流量。
let ipCounter = 0;
function freshIP(): string {
  ipCounter += 1;
  // 每 60000 条回绕一次，用例数远小于此，回绕不会影响任何断言。
  const third = Math.floor(ipCounter / 250) % 250;
  const fourth = (ipCounter % 250) + 1;
  return `198.18.${third}.${fourth}`;
}

// 每个用例结束清空 KV：miniflare 的存储默认在用例间隔离，但 index 与 roster
// 原文是显式写入的，reset 让「KV 空」这类用例不必依赖用例顺序。
afterEach(async () => {
  await reset();
});

describe("health 装配", () => {
  it("数据完整时 200 ok 并回显 VERSION", async () => {
    await seedTwoSchools();
    const response = await SELF.fetch(request("/api/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(jsonContentType);
    const body = (await response.json()) as { status: string; version: string };
    // version 必须来自 env.VERSION（wrangler.jsonc 的 vars），不是硬编码字符串：
    // 装配层若漏传 version，这里会拿到 undefined 而不是一份部署标识。
    expect(body.status).toBe("ok");
    expect(body.version).toBe(env.VERSION);
    expectSecurityHeaders(response, "health 200");
  });

  it("KV 为空时 503 degraded/data", async () => {
    const response = await SELF.fetch(request("/api/health"));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { status: string; reason: string; version: string };
    expect(body).toEqual({ status: "degraded", reason: "data", version: env.VERSION });
    expectSecurityHeaders(response, "health 503 data");
  });

  // partial 是这次订正里最容易被漏掉的一格：index 声明了 N 所学校，本次只读到
  // M < N 所。KV 写扩散窗口里这种状态是常态，答 200 就等于向编排层声称一份
  // 不完整的名单完整可用。用「index 写两校、只写一校原文」造出这个窗口。
  it("index 声明两校但只读到一校时 503 degraded/partial", async () => {
    await seedSchool("福清一中", "高一", { "1班": ["张伟"] });
    await seedIndex(["福清一中", "福清二中"]);

    const response = await SELF.fetch(request("/api/health"));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { status: string; reason: string; version: string };
    expect(body).toEqual({ status: "degraded", reason: "partial", version: env.VERSION });
    expectSecurityHeaders(response, "health 503 partial");
  });

  it("非 GET 返回 405 + Allow: GET，且不读数据", async () => {
    await seedTwoSchools();
    const response = await SELF.fetch(request("/api/health", { method: "POST" }));

    expect(response.status).toBe(405);
    // Allow 是 405 的必需头：客户端据此知道该用哪个方法重试。
    expect(response.headers.get("Allow")).toBe("GET");
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
    expectSecurityHeaders(response, "health 405");
  });
});

describe("search 装配", () => {
  it("成功响应五键形状与 item 四键白名单", async () => {
    await seedTwoSchools();
    const response = await SELF.fetch(request("/api/search?q=%E5%BC%A0"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(jsonContentType);
    const body = (await response.json()) as Record<string, unknown>;

    // 响应键集合逐字相等：多一个键就是 wire 契约变更，前端按固定键解码。
    expect(Object.keys(body).sort()).toEqual(["hasMore", "items", "limit", "offset", "total"]);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);

    // item 四键白名单：领域派生字段（nameKey / classNo / gradeIdx / schoolIdx）
    // 与 Go 的导出字段名都不得出现在 wire 上。这是隐私红线的集成层关口——
    // toWireStudent 若被绕过（例如装配层直接序列化领域对象），这里翻红。
    const banned = ["nameKey", "NameKey", "className", "ClassName", "classNo", "ClassNo", "gradeIdx", "GradeIdx", "schoolIdx", "SchoolIdx"];
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["class", "grade", "name", "school"]);
      for (const key of banned) {
        expect(item, `item 泄漏派生字段 ${key}`).not.toHaveProperty(key);
      }
    }
    expectSecurityHeaders(response, "search 200");
  });

  it("非法 limit 映射 400 invalid_limit（错误边界不漏成 500）", async () => {
    await seedTwoSchools();
    const response = await SELF.fetch(request("/api/search?q=%E5%BC%A0&limit=999"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_limit" });
  });
});

describe("未知 /api/* 与静态回退", () => {
  it("未知 /api/* 路径返回 JSON 404", async () => {
    const response = await SELF.fetch(request("/api/unknown"));

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await response.json()).toEqual({ error: "not_found" });
    expectSecurityHeaders(response, "api 404");
  });

  it("非 /api 路径回退 ASSETS 并由资产层给出响应", async () => {
    // 断言「请求确实走进了 assets binding」而不是钉死静态文件内容：assets 目录
    // 的产物随构建变化，钉死文件名或正文会让这条测试跟着构建产物抖动。真正的
    // 契约是分流——首页由资产层服务（text/html 或 404 页面），不是 Worker 的
    // JSON 错误体。因此这里断言响应不是 application/json 且不带 Worker 的错误码。
    const response = await SELF.fetch(request("/"));

    expect(response.headers.get("Content-Type") ?? "").not.toContain("application/json");
    // 安全头必须照样齐全：静态回退的响应同样过最外层 setSecurityHeaders。
    // 这条是装配顺序的第二个证据面（第一个是 429 那条）。
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    const text = await response.text();
    expect(text).not.toContain('"error":"not_found"');
  });

  // "/api" 没有尾斜杠，不落在 "/api/" 前缀里，因此走静态回退。
  //
  // 这里与 Go 有一处已知差异：Go 的 ServeMux 对「注册了子树却请求子树根且缺
  // 尾斜杠」的形态会先回 301 并补上斜杠，而本实现直接交给资产层。差异只在
  // 这一条退化输入上：真实客户端不会请求裸 "/api"，即便请求了，得到的也是
  // 资产层的 404 而不是 Service Worker 的错误体。保留资产回退而不复刻 301，
  // 是因为复刻它需要一个只为这一条路径存在的手写跳转，而收益仅是形态对齐。
  // 这条测试钉住的是判定口径（前缀必须带尾斜杠），防止有人把
  // isPublicAPIPath 改成 startsWith("/api") 后悄悄改变这条路径的去向。
  it("/api（无尾斜杠）不归公共 API，走静态回退", async () => {
    const response = await SELF.fetch(request("/api"));

    expect(response.headers.get("Content-Type") ?? "").not.toContain("application/json");
  });
});

describe("限流", () => {
  // 把限流窗口打满：wrangler.jsonc 声明 limit=60 / period=60，同一个 IP 连发
  // 61 次，前 60 次放行、第 61 次起 429。头几次请求都打 /api/health（KV 为空
  // 时 503 也算「放行」——限流判的是请求次数，不是响应状态）。
  //
  // 这条同时也是 health 走限流的存在性证明：如果装配层给 health 开了免限流
  // 的口子，第 61 次 health 仍会返回 503 而不是 429，循环结束后的断言翻红。
  it("同一 IP 打满窗口后 health 也被 429（health 不跳限流）", async () => {
    const ip = freshIP();
    const limit = 60;

    for (let index = 0; index < limit; index += 1) {
      const response = await SELF.fetch(request("/api/health", undefined, ip));
      // 前 60 次必须都被放行：KV 为空时健康检查答 503，这正是「放行」的证据，
      // 断言 429 之外的状态才能确认它们真的走完了 mux。
      expect([200, 503]).toContain(response.status);
    }

    const denied = await SELF.fetch(request("/api/health", undefined, ip));
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("60");
    expect(await denied.json()).toEqual({ error: "rate_limited" });
    // 429 同样必须携带全站安全头：安全头居最外正是为此，若装配层把
    // setSecurityHeaders 放在限流内侧，这条会翻红。
    expectSecurityHeaders(denied, "429");
  });

  it("被限流的请求不再放行到 search", async () => {
    const ip = freshIP();
    for (let index = 0; index < 60; index += 1) {
      await SELF.fetch(request("/api/health", undefined, ip));
    }

    const denied = await SELF.fetch(request("/api/search?q=%E5%BC%A0", undefined, ip));
    expect(denied.status).toBe(429);

    // 换一个 IP 立刻恢复，证明限流键确实是客户端 IP 而不是全局计数。
    const other = await SELF.fetch(request("/api/search?q=%E5%BC%A0"));
    expect(other.status).not.toBe(429);
  });

  // 管理端不走公共限流：管理员在同一 IP 上连打 70 次列表请求，每次都应答
  // 401（无凭据），不该出现 429。若装配层把 admin 也塞进公共限流，这条翻红。
  it("管理端不受公共限流影响", async () => {
    const ip = freshIP();
    const responses: number[] = [];
    for (let index = 0; index < 70; index += 1) {
      const response = await SELF.fetch(request("/api/admin/roster", undefined, ip));
      responses.push(response.status);
    }

    expect(responses.every((status) => status === 401)).toBe(true);
    expect(responses).not.toContain(429);
  });
});

// 假 limiter 注入组：直接调默认导出的 fetch，把 env 换成自制的那一份。
// 与上面「真实 binding」组的差异只在限流器来源，装配链本身是同一条代码路径。
describe("限流注入（假 limiter）", () => {
  // 前 2 次放行、第 3 次起拒绝。这条同时给出两侧证据：
  // 放行侧能走到 mux（503/404 等真实业务响应），拒绝侧是 429 且带 Retry-After。
  it("前 N 次放行、之后 429，且 Retry-After 与错误体齐备", async () => {
    const { limiter, keys } = fakeLimiter(2);
    const testEnv = makeEnv(limiter);
    const ip = freshIP();

    const first = await worker.fetch(request("/api/health", undefined, ip), testEnv, {} as ExecutionContext);
    expect(first.status).not.toBe(429);

    const second = await worker.fetch(request("/api/health", undefined, ip), testEnv, {} as ExecutionContext);
    expect(second.status).not.toBe(429);

    const third = await worker.fetch(request("/api/health", undefined, ip), testEnv, {} as ExecutionContext);
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBe("60");
    expect(third.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await third.json()).toEqual({ error: "rate_limited" });
    expectSecurityHeaders(third, "假 limiter 429");

    // 限流键必须是客户端 IP：三次调用传的是同一个 IP，因此三次的键都该是它。
    // 若装配层改用了别的键（路径、常量，"unknown"），这条翻红。
    expect(keys).toEqual([ip, ip, ip]);
  });

  // health 不跳限流：这正是 brief 订正的第一条。用一个只放行 0 次的 limiter，
  // 第一条 health 请求就该被 429——若装配层给 health 加了免限流分支，它会
  // 一路走到健康检查并答 503/200，这条翻红。因此这条断言是变异验证的正对点。
  it("health 也走限流：allowCount 为 0 时第一条 health 即 429", async () => {
    const { limiter } = fakeLimiter(0);
    const testEnv = makeEnv(limiter);

    const response = await worker.fetch(request("/api/health"), testEnv, {} as ExecutionContext);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
  });

  // 管理端不消耗公共限流名额：allowCount 为 0（公共限流一放行都不给）时，
  // 管理端仍应正常应答 401。若装配层把 admin 也塞进公共限流，这里会拿到 429。
  it("管理端不在公共限流的覆盖范围内", async () => {
    const { limiter, keys } = fakeLimiter(0);
    const testEnv = makeEnv(limiter);

    const response = await worker.fetch(request("/api/admin/roster"), testEnv, {} as ExecutionContext);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    // 连 limiter.limit() 都没被调用过：管理端请求根本没进限流层。
    expect(keys).toEqual([]);
  });

  // 非 /api 路径同样过公共限流：Go 的链对静态资源也生效，限流不是只保护
  // API 的——静态资源被打时同样会拖垮 Worker。
  it("静态回退路径同样被公共限流覆盖", async () => {
    const { limiter } = fakeLimiter(0);
    const testEnv = makeEnv(limiter);

    const response = await worker.fetch(request("/"), testEnv, {} as ExecutionContext);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
  });
});

// checkRateLimit 自身的形态：它是限流判定的唯一实现，也是唯一可注入点。
// 这里直接调它而不经装配链，是为了钉住两条与 binding 交互的契约：
// success 必须原样透传（不能在返回前再做别的判断），key 必须等于传入的 IP。
describe("checkRateLimit 形态", () => {
  it("透传 binding 的 success，并用传入的 IP 作为 key", async () => {
    const { limiter, keys } = fakeLimiter(1);
    const ip = "198.18.7.7";

    expect(await checkRateLimit(limiter, ip)).toBe(true);
    expect(await checkRateLimit(limiter, ip)).toBe(false);
    // key 逐字等于传入值：把 IP 当 key 是契约，写成路径或常量都能让限流
    // 失效，而响应仍然是 429（只是永远按同一个桶计数）。
    expect(keys).toEqual([ip, ip]);
  });

  // binding 抛错不吞：限流是一道安全控制，故障时应当表现为可见的 500，
  // 而不是静默放行所有流量。这条同时钉住「装配链会把异常转成 500」。
  it("limiter 抛错时装配链答 500 internal_error，不泄漏异常文本", async () => {
    const failing: RateLimit = {
      async limit() {
        throw new Error("binding exploded: secret detail");
      }
    };
    const testEnv = makeEnv(failing);

    const response = await worker.fetch(request("/api/health"), testEnv, {} as ExecutionContext);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    // 平台异常文本绝不能出现在响应体里：它常带上游地址与内部标识。
    expect(response.headers.get("Content-Type")).toBe(jsonContentType);
  });
});

describe("admin 全链路", () => {
  it("无凭据 401 unauthorized + WWW-Authenticate", async () => {
    const response = await SELF.fetch(request("/api/admin/roster"));

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    // 401 也要有安全头：管理端响应不因为「未认证」就成了头部契约的例外。
    expectSecurityHeaders(response, "admin 401");
  });

  it("错误凭据同样 401（与缺凭据逐字相同）", async () => {
    const response = await SELF.fetch(
      request("/api/admin/roster", { headers: { Authorization: "Bearer wrong-token" } }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expectSecurityHeaders(response, "admin 401 wrong token");
  });

  it("正确凭据上传名单 201，随后列表与搜索可见", async () => {
    const payload = rosterJson("福清三中", "高二", { "1班": ["王芳"] });
    const put = await SELF.fetch(
      request("/api/admin/roster/%E7%A6%8F%E6%B8%85%E4%B8%89%E4%B8%AD", {
        method: "PUT",
        headers: { Authorization: "Bearer test-admin-token" },
        body: payload,
      }),
    );

    expect(put.status).toBe(201);
    expect(put.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await put.json()).toEqual({ school: "福清三中", students: 1 });
    expectSecurityHeaders(put, "admin 201");

    // 全链路的第二半：写入的数据必须真的能被公共端点读到。只断言 201 只能
    // 证明 handler 返回了成功，证明不了 KV 里的键与 index 一致——
    // 键名分叉时 201 照旧成立，而 search 永远搜不到。
    const list = await SELF.fetch(
      request("/api/admin/roster", { headers: { Authorization: "Bearer test-admin-token" } }),
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ schools: ["福清三中"] });

    const search = await SELF.fetch(request("/api/search?q=%E7%8E%8B"));
    expect(search.status).toBe(200);
    const body = (await search.json()) as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toEqual({ name: "王芳", school: "福清三中", grade: "高二", class: "1班" });
  });

  it("删除后列表为空且 DELETE 幂等失败答 404", async () => {
    // 先上传再删除，走完整生命周期。
    const payload = rosterJson("福清三中", "高二", { "1班": ["王芳"] });
    await SELF.fetch(
      request("/api/admin/roster/%E7%A6%8F%E6%B8%85%E4%B8%89%E4%B8%AD", {
        method: "PUT",
        headers: { Authorization: "Bearer test-admin-token" },
        body: payload,
      }),
    );

    const del = await SELF.fetch(
      request("/api/admin/roster/%E7%A6%8F%E6%B8%85%E4%B8%89%E4%B8%AD", {
        method: "DELETE",
        headers: { Authorization: "Bearer test-admin-token" },
      }),
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });

    // 第二次删除：该校已不在 index 里，答 404 而不是 200 幂等成功——
    // 拼错校名的 DELETE 若答 200，管理员会以为删掉了一所实际还在的学校。
    const again = await SELF.fetch(
      request("/api/admin/roster/%E7%A6%8F%E6%B8%85%E4%B8%89%E4%B8%AD", {
        method: "DELETE",
        headers: { Authorization: "Bearer test-admin-token" },
      }),
    );
    expect(again.status).toBe(404);
  });
});
