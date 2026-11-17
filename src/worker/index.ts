// Workers 装配层：把 handlers / admin / middleware / errors / rosterStore 拼成一条
// 请求链，并给出 fetch 入口。
//
// 链顺序（由外到内）沿用迁移前 Go 端 newHandlerChainWith 的形态：
//
//   securityHeaders -> rateLimit -> accessLog -> mux
//
// 三条由此推出的行为约束，装配层必须原样保住：
//
// 1. 安全头最外。所有响应都要过 setSecurityHeaders，包括限流拒绝（429）、未知
//    路径的 404 与管理端的 401。若把安全头放在 rateLimit 内侧，429 就成了头部
//    例外——攻击者能从响应头差异上区分「被限流」与「被拒绝」，那是 Go 端
//    特意用链顺序消掉的信息。
// 2. 限流在 accessLog 之外短路。被限流拒绝的请求不写访问日志，否则攻击流量会
//    按比例放大日志写入量，正好是限流要保护的东西。
// 3. accessLog 在 mux 之外：它记录的是「这次请求最终答了什么」，因此既要看到
//    handler 的正常响应，也要看到 handler 抛出的异常转换后的响应。跳过
//    /api/health 的判定留在 accessLog 内部（见 middleware.ts），本层不重复。
//
// 与 Go 的唯一形态差异是入口位置：Go 的 mux 是 http.ServeMux，"non-/api" 落到
// frontendHandler；Workers 用 assets binding，装配层判定路径后把请求交给
// env.ASSETS.fetch。判定规则本身逐字照搬 buildMux：精确匹配三条 API 路径，
// "/api/" 前缀兜底 404，其余全部回退静态资源。
//
// 错误边界：handler 抛 ApiException 时用它的 toResponse 出响应（状态与错误体
// 都由抛出点决定）；其余异常一律 500 internal_error，且绝不把异常文本或堆栈
// 写进响应体——平台异常里常有上游细节，外泄即是信息泄露。

import type { ExecutionContext, ExportedHandler, Fetcher, RateLimit } from "@cloudflare/workers-types";
import { adminHandlers, isAdminPath } from "./admin";
import { ApiException, ERR_CODES, writeError, writeJSON } from "./errors";
import { healthHandler, notFoundHandler, schoolsHandler, searchHandler } from "./handlers";
import { accessLog, setSecurityHeaders } from "./middleware";
import { RosterStore, type RosterKV } from "./rosterStore";

// Env 是绑定契约的唯一声明处。取值来源是 wrangler.jsonc（Task 17 补全环境变量
// 与真实 id）：
//
//   ROSTER             KV namespace（rosterStore 的 RosterKV 子集即可，真实
//                      KVNamespace 是它的超集，可直接赋入）
//   API_RATE_LIMITER   Rate Limiting binding（公共端点的令牌桶）
//   ADMIN_TOKEN        secret，管理端 Bearer 凭据
//   VERSION            部署版本号，健康检查与 503 都会回显
//   ASSETS             assets binding，非 /api 路径的回退目标
export interface Env {
  ROSTER: RosterKV;
  API_RATE_LIMITER: RateLimit;
  ADMIN_TOKEN: string;
  VERSION: string;
  ASSETS: Fetcher;
}

// Retry-After 取 60 秒：与 wrangler.jsonc 里限流窗口的 period 同值，Go 端按
// 令牌桶算出的是「补满一个令牌的等待时间」（rateInterval=1s），Workers 的
// simple 限流只有固定窗口，对外统一给一个窗口长度，客户端据此退避即可。
const RETRY_AFTER_SECONDS = "60";

// CHECK_RATE_LIMIT 是限流判定的唯一实现，抽成可注入纯函数是刻意的：
// 测试用假 limiter 传入真实装配链，就能断言 429 的完整形态（状态、错误体、
// Retry-After、安全头），不必在 workerd 里操控真实 binding 的计数状态。
//
// 契约与 Go 的 limiter.allow 一致：返回 true 表示放行，false 表示拒绝。限流键
// 用 cf-connecting-ip（Workers 边缘注入的裸地址，对应 Go 的 r.RemoteAddr）。
//
// 不吞 limiter 抛出的错误：限流是一道安全控制，binding 故障时应当表现为可见的
// 500（由本层错误边界转换），而不是静默放行所有流量。降级成「不限流」会让
// 一次配置疏漏变成长期无保护的假健康状态，而 500 会在告警与探针上立刻暴露。
export async function checkRateLimit(limiter: RateLimit, ip: string): Promise<boolean> {
  const { success } = await limiter.limit({ key: ip });
  return success;
}

// clientKey 取限流键：cf-connecting-ip 是 Workers 边缘注入的客户端地址（对应
// Go 的 r.RemoteAddr）。缺失时给空串而不是直接放行——空串会让所有无该头的
// 请求共用一个桶，在直连或本地调用场景下形成一条共享配额，这与 Go 端
// RemoteAddr 永远有值的情形等价；若改成「无头则放行」，只要伪造一个头就
// 能整个绕过限流。
function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "";
}

// rateLimited 写出 429：错误体与状态查表仍归 errors.ts（ERR_STATUS 里
// rate_limited -> 429），这里只补 Retry-After 这一个随场景变化的头。
function rateLimited(): Response {
  return writeError(ERR_CODES.rateLimited, { "Retry-After": RETRY_AFTER_SECONDS });
}

// 静态产物的长缓存头，逐字对齐 Go 端 config.go 的 assetCacheMaxAge。
//
// 取值不可改：构建产物是哈希命名的，内容变则文件名变，因此一年长缓存是安全的，
// 也是首屏性能依赖的前提。改短它会让每次回访都重新下载哈希资源。
const ASSET_CACHE_MAX_AGE = "public, max-age=31536000, immutable";

// 静态产物的路径前缀，对齐 Go 端 web.go 里判定 immutable 的那两个前缀。
// 只有这两个前缀下的文件是构建产物；其余路径（首页、任意回退路径）不设长缓存。
const ASSET_PATH_PREFIXES = ["/assets/", "/fonts/"] as const;

// isAssetPath 判定路径是否属于构建产物。前缀列表与 ASSET_PATH_PREFIXES 同源，
// 不在调用点重写字面量。
function isAssetPath(pathname: string): boolean {
  return ASSET_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// withSecurityHeaders 把全站安全头铺到任何响应上，并处理静态产物的缓存头。
//
// 用复制而不是就地改 response.headers：ASSETS.fetch 返回的是平台响应，它的
// headers 是受保护的（不可变），就地 set 会抛 TypeError。复制时保留 body
// 引用（不读不缓存），避免把静态资源整体读进内存。
//
// Cache-Control 是这一层唯一的例外，因为它有两套互斥的正确值：
//
//   /assets/ 与 /fonts/  构建产物 → public, max-age=31536000, immutable
//   其余（首页、API）             → no-store
//
// 这个分支是对齐 Go 的 web.go 与 middleware.go：Go 里 setSecurityHeaders 先设
// no-store，静态资源的 143 行再覆盖成 immutable，后写者胜。Workers 这一层是
// 后处理，方向相反，因此必须显式按路径选值，不能指望上游。
//
// 为什么不「保留上游 Cache-Control」：实测 env.ASSETS.fetch 对 /assets/* 返回的
// 是 public, max-age=0, must-revalidate（不是 immutable）。直接保留会让构建产物
// 失去长缓存，与 Go 的 assetCacheMaxAge 分叉。上游那个值只表达「可缓存但须回源
// 校验」，与 Go 的语义不同。
//
// 缺失资源不继承 immutable：Go 的 web.go 只在确认资源存在后设长缓存，
// 缺失的 /assets/* 走 404 且不带 immutable（static_cache_test.go 有两条锁这个）。
//
// 判定是 200 或 304，不是「仅 200」。304 来自 If-None-Match 命中，它本身就是
// 「资源存在且未变」的证据；Go 的时序是先 Set(Cache-Control)（web.go:143）
// 再写 304（:162-164），因此 **304 继承一年 immutable**。若这里只认 200，
// 304 会落到 no-store，客户端在条件请求之后反而丢掉长缓存——下次还得回源校验，
// 而一年 immutable 的全部收益就在条件请求这一格。
//
// 缺失产物在这里仍走 404：不是靠本函数判 HTML，而是 dispatch 在交给资产层之后
// 就把「构建产物路径上的 HTML 兜底页」改回 404（见那里的注释）。本函数只看
// 状态码，因此不需要再猜内容类型。
//
// 无 body 的状态码（204/304）必须显式传 null body：给 Response 构造器传一个
// 非 null body 会抛「Invalid response status code」。
//
// 不提 101：实测 `new Response(null, { status: 101 })` 直接抛错（status 必须在
// 200-599 之间）。它不可能出现在这条链的响应里，留着那半个判定只会让读者以为
// 还有一条需要处理的分支。
function withSecurityHeaders(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  setSecurityHeaders(headers);
  // setSecurityHeaders 已按全站契约铺了 no-store；静态产物的「存在」响应（200
  // 与 304）用同一个 set 覆盖成 immutable——与 Go 的「后写者胜」等价，只是显式选值。
  const exists = response.status === 200 || response.status === 304;
  if (isAssetPath(new URL(request.url).pathname) && exists) {
    headers.set("Cache-Control", ASSET_CACHE_MAX_AGE);
  }
  const body = response.status === 204 || response.status === 304 ? null : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// isPublicAPIPath 判定路径属于公共 API 命名空间。
//
// 用 startsWith("/api/") 而不是 startsWith("/api")：Go 的 mux 按子树注册
// "/api/"，它匹配 "/api/" 与其下的所有路径，裸 "/api"（缺尾斜杠）则不在其中。
// 写成 startsWith("/api") 会把裸 "/api" 从静态回退里挖出来答 JSON 404。
//
// 与 Go 的一处已知差异：Go 的 ServeMux 对「子树根缺尾斜杠」会补一个 301 跳转，
// 本实现直接把裸 "/api" 交给资产层。只影响这一条退化输入，真实客户端不会
// 请求它；为它复刻 301 需要一条手写跳转分支，收益只是形态对齐。
function isPublicAPIPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

// routePublic 是公共链路的 mux：精确匹配三条已注册路径，其余 /api/* 答
// JSON 404。notFoundHandler 不接 request，这里单独接线（它对方法与路径都不
// 做区分，任何走到兜底的形式都是同一个答案）。
//
// store 每条请求新建：RosterStore 除 KV 绑定外不持有任何跨请求状态，
// 复用一个实例只是为了少一次对象分配，却会让未来加进去的缓存隐式跨请求。
function routePublic(request: Request, env: Env, pathname: string): Promise<Response> {
  const store = new RosterStore(env.ROSTER);
  switch (pathname) {
    case "/api/health":
      return healthHandler(request, { store, version: env.VERSION });
    case "/api/search":
      return searchHandler(request, { store });
    case "/api/schools":
      return schoolsHandler(request, { store });
    default:
      return Promise.resolve(notFoundHandler());
  }
}

// dispatch 是链的最内层 mux：判定 admin / 公共 API / 静态回退三条去向。
//
// 管理端不走公共限流（装配层在调用本函数前已分流）：管理端是单管理员低频
// 写入，且每次都要过 Bearer 认证，对它再叠一层 IP 限流收益很小，却会让管理员
// 在网络抖动时被自己的限流器挡住上传。
async function dispatch(request: Request, env: Env, pathname: string): Promise<Response> {
  if (isAdminPath(pathname)) {
    const store = new RosterStore(env.ROSTER);
    return adminHandlers(request, { store, adminToken: env.ADMIN_TOKEN });
  }
  if (isPublicAPIPath(pathname)) {
    return routePublic(request, env, pathname);
  }
  // 静态资源与页面：Go 端由 frontendHandler 服务，Workers 交给 assets binding。
  // 请求原样透传（不改 URL、不剥查询串），缓存与条件请求语义由平台资产层负责。
  const response = await env.ASSETS.fetch(request);
  // 构建产物路径上的缺失文件必须答 404，不能接兜底页。
  //
  // wrangler.jsonc 开了 not_found_handling: single-page-application：资产层对
  // 「目录里没有这个文件」的路径一律回 index.html 且状态 200。这对页面路由是
  // 需要的（客户端路由要拿到首页去自己解析路径），但对 /assets/ 与 /fonts/ 是
  // 错的——那两个前缀下只放哈希命名的构建产物，不存在「客户端路由」用法，
  // 所以 HTML 兜底页在那里只可能意味着文件缺失。
  //
  // 不改成 404 的后果有两层：一是缺失的 .js 会以 200 HTML 返回，浏览器把它当
  // 脚本解析，报的是语法错误而不是拿到 404，排障方向被引偏；二是装配层会按
  // 「200 + /assets/ 前缀」判它存在，给它打上一年 immutable，客户端随后把这段
  // HTML 缓存成 .js 整整一年。Go 的 web.go 对缺失构建产物答 404 且不带长缓存
  // （static_cache_test.go 两条锁这个），这里回到同一形态。
  //
  // 判据用 Content-Type 而不是「body 是否等于 index.html」：资产层给兜底页的
  // 是 text/html，给真实构建产物的是 js/css/woff2 之类，判据与内容比对相比
  // 少读一次 body，也不会在首页改版后失效。
  const contentType = response.headers.get("Content-Type") ?? "";
  if (isAssetPath(pathname) && contentType.startsWith("text/html")) {
    return new Response("not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
  return response;
}

// asResponse 把异常收窄成响应：ApiException 走它自己的 toResponse（状态与
// 错误体由抛出点决定），其余一律 500 internal_error。
//
// 500 的码是字面量而不是 ERR_CODES 的成员：internal_error 只在「这里出了
// 未预期的异常」一个场景出现，它不属于对外错误码契约（ERR_STATUS 的那些码
// 都对应客户端可处置的具体原因）。把异常文本记进日志而不是写进响应体，
// 排障靠日志、对外只留一个稳定码。
function asResponse(error: unknown): Response {
  if (error instanceof ApiException) {
    return error.toResponse();
  }
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`unhandled worker error: ${detail}`);
  return writeJSON(500, { error: "internal_error" });
}

// handler 是本模块唯一的链装配点。
//
// 顺序严格对应 Go 的 securityHeaders -> rateLimit -> accessLog -> mux，
// 装配细节见文件头三条约束。写法上把「限流拒绝」与「正常路由」两步分开，
// 是因为中间件的短路语义无法用一次 await 表达：被拒绝的请求不进入 accessLog，
// 也就不能走统一的响应后处理。
//
// 不导出：注入假 limiter 的测试直接调默认导出的 fetch(request, env, ctx)，
// 把 env 换成自己造的那一份即可。多导出一个入口只会多一条需要维护的调用路径。
async function handler(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const startedAt = performance.now();

  let response: Response;
  let logged = true;
  try {
    // 限流层：管理端之外的一切请求都要过令牌桶，包括 /api/health。
    // 健康检查只跳过访问日志，不跳过限流——Go 的链里 rateLimit 在 accessLog
    // 外侧，探针同样消耗令牌。给 health 开一条免限流的口子就等于在任何
    // 负载下把最常被外部调用的那条路径留成无限频入口。
    //
    // isAdminPath 在这里判一次、dispatch 内再判一次是刻意的：前者决定「要不要
    // 过限流」，后者决定「路由到哪里」。两者共用同一份判定函数，因此不会分叉；
    // 合并成一个分支反而要把限流逻辑塞进路由层，让路由函数同时承担横切关注点。
    if (!isAdminPath(pathname) && !(await checkRateLimit(env.API_RATE_LIMITER, clientKey(request)))) {
      response = rateLimited();
      // 被限流拒绝的请求不写访问日志（Go 的 rateLimit 在 accessLog 外侧短路），
      // 否则攻击流量会按比例放大日志写入量，正好是限流要保护的东西。
      logged = false;
    } else {
      response = await dispatch(request, env, pathname);
    }
  } catch (error) {
    response = asResponse(error);
  }

  // accessLog 在 mux 外侧：它在响应产生之后拿状态码与耗时，因此异常路径也
  // 会被记录（与 Go 的 statusRecorder 同义）。被限流拒绝的请求不进这里，
  // 理由见文件头第 2 条。
  if (logged) {
    accessLog(request, response.status, performance.now() - startedAt);
  }

  // 安全头最外：无论是 429、404 还是异常转换出的 500，都要带上全站安全头。
  // request 也传进去：静态产物的长缓存头要按路径判定（见 withSecurityHeaders）。
  return withSecurityHeaders(request, response);
}

// fetch 是 Workers 入口。ctx 保留但当前不使用：本层没有需要 waitUntil 延后的
// 后台工作（访问日志是同步 console.log），将来若加异步日志或缓存刷新再在这里接。
export default {
  fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handler(request, env);
  }
} satisfies ExportedHandler<Env>;
