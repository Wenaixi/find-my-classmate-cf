// 管理端点的单一 owner：Bearer 认证、名单上传/删除/列表三条 wire 契约，
// 以及「这个路径归管理端」的判定。
//
// 职责边界：
// - 认证只回答「是不是管理员」，不区分「缺头 / 格式不对 / token 错」——
//   三者都落在同一个 false 上，调用点因此也只有一个 401 响应，攻击者无法
//   从状态码、错误码或文案里判断自己猜对了哪一半。
// - 名单的校验与存储唯一归属 worker/rosterStore.ts（它再委托 shared/roster.ts）。
//   本文件只把校验抛出的错误文案原样转成 400，不自己解析 roster JSON，
//   也不自己判班级格式——两处判定必然分叉，分叉后管理端会放行一份
//   loadAll 会拒绝的名单，形成「上传成功但服务加载失败」的静默裂缝。
// - 错误体形态唯一归属 worker/errors.ts。401 unauthorized 是管理端专属码，
//   刻意不进 ERR_STATUS 公共表（规格 3.4）：公共端点的错误码表是前端与
//   排障手册共同依赖的契约，多一个只有管理端会发的码没有收益。
//   写它时因此直接 writeJSON(401, ...)，不能走 writeError——后者查不到
//   未登记的码会回落 500，把认证失败伪装成服务故障。
//
// 路径形态：
//
//   /api/admin/roster          集合：GET 列表
//   /api/admin/roster/{school} 单项：PUT 上传、DELETE 删除
//
// 集合与单项的方法集合不同，405 的 Allow 头因此也分两套。把两者按同一套
// Allow 回答会让运维拿着 Allow: GET 去 PUT 单项路径，而那条路径明确支持 PUT。
import { trimGoSpace } from "../shared/classparse";
import { ERR_CODES, writeError, writeJSON } from "./errors";
import { InvalidRosterError, InvalidSchoolNameError, type RosterStore } from "./rosterStore";

// 401 的错误码。不进 ERR_CODES：理由见文件头（仅管理端使用）。
const ERR_UNAUTHORIZED = "unauthorized";

// 400 的错误码。它同样是管理端专属：公共端点的 400 指的是「你给的查询参数
// 不对」，而这里指「你上传的名单内容没有通过加载侧校验」，两者对客户端的
// 处置动作不同。message 字段承载 shared/roster.ts 的逐字文案。
const ERR_INVALID_ROSTER = "invalid_roster";

// 管理端的根路径。isAdminPath 与 handler 共用同一份前缀：两处各写一份
// 字面量后，改前缀只会改到一处，另一处静默失配——装配层不再把管理请求
// 路由到这里，而 handler 还以为自己收到了管理请求。
const ADMIN_PREFIX = "/api/admin/roster";

// Authorization 头的解析形态：scheme 大小写不敏感（RFC 7235 规定
// auth-scheme 不区分大小写，客户端发 bearer 与 Bearer 必须同等接受），
// scheme 与凭据之间至少一个空白，凭据自身不含空白（Bearer token 的定义如此）。
// 用正则整体匹配而不是 startsWith("Bearer ")：后者对 "Bearer" / "Bearer " /
// "bearer  tok" 的处置取决于手写切片的细节，正则把接受域写死成一条规则。
const BEARER_PATTERN = /^Bearer\s+(\S+)\s*$/i;

// toBytes 把凭据编码成 UTF-8 字节。用字节而不是码元比较：UTF-8 字节序是
// 凭据的真实形态，而 JS 的字符串长度按 UTF-16 码元计——代理对与组合字符下
// 「码元等长」与「字节等长」不是一回事，恒时比较必须在字节层做。
function toBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

// workersTimingSafeEqual 取 Workers 扩展 crypto.subtle.timingSafeEqual；
// 该 API 不在标准 WebCrypto 里，node 测试环境（v26）确实没有它。
// 返回 null 表示当前运行时没有这个能力，由调用方走等价的本地实现。
//
// 类型断言而不是声明全局：本模块不依赖 workers-types，声明全局会让
// 「这个 API 一定存在」变成编译期的既成事实，而运行时探测才是真实契约。
function workersTimingSafeEqual(): ((a: Uint8Array, b: Uint8Array) => boolean) | null {
  const timingSafeEqual = (crypto.subtle as { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean })
    .timingSafeEqual;
  if (typeof timingSafeEqual !== "function") return null;
  // 取出后包一层绑定：直接传方法引用在某些宿主里会丢 this。
  return (a, b) => timingSafeEqual.call(crypto.subtle, a, b);
}

// byteEqual 是恒时比较的本地实现：长度不等直接返回 false，等长时对全部字节
// 做异或累积、跑完整轮才给出结论，中途不提前返回。
//
// 长度不等时的处置：比较在进入字节循环之前就结束。这里泄露的信息只有
// 「长度不同」，而管理员 token 的长度是部署时就固定的常数（不是凭据的熵，
// 也不是随机生成的一次性口令），知道它并不比不知道更容易猜出 token；
// 反过来若把两者填充到等长再比，末尾的填充段会引入「比真实凭据更长」
// 这一类输入的特殊路径，反而多一种需要证明不会提前返回的分支。
// 更重要的是不能把不等长的缓冲交给平台版的 timingSafeEqual：它对长度不等
// 的入参会抛错，一条 "Bearer short" 就会把认证失败变成 500，用异常类型
// 泄露「长度对了没有」——这比时间差更容易被观察到。
function byteEqual(provided: Uint8Array, expected: Uint8Array): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < provided.length; index += 1) {
    diff |= provided[index] ^ expected[index];
  }
  return diff === 0;
}

// 凭据比较的默认实现：平台有 timingSafeEqual 就用它，没有就用 byteEqual。
// 两者的行为契约相同（等长才比、跑完整轮、不提前返回），因此换运行时
// 不会改变任何调用点的判定结果。
function constantTimeEqual(provided: string, expected: string): boolean {
  const a = toBytes(provided);
  const b = toBytes(expected);
  // 长度先判：理由见 byteEqual。放在这里而不是各自实现里，使平台分支与
  // 本地分支共用同一条长度闸门，两种运行时的接受域不可能分叉。
  if (a.length !== b.length) return false;
  const platformCompare = workersTimingSafeEqual();
  if (platformCompare !== null) {
    return platformCompare(a, b);
  }
  return byteEqual(a, b);
}

// 凭据比较的注入点。签名收字符串而不是字节：调用点与测试都只关心「两个
// 凭据是否相等」，编码是默认实现的内部细节；测试用假 compare 时也不必
// 自己造 Uint8Array。
export type CredentialCompare = (provided: string, expected: string) => boolean;

// verifyBearer 判定请求是否携带正确的管理员凭据。
//
// compare 可注入是因为 crypto.subtle.timingSafeEqual 是 Workers 扩展、
// node 测试环境没有它——测试传一个假 compare 就能验证「解析头部 + 判定」
// 的完整逻辑，不必让测试环境假装拥有平台 API，也不必把真实比较实现
// 降级成 === 后忘记换回来。默认值即生产使用的恒时实现。
//
// 空 expected 一律拒绝：部署若漏配 ADMIN_TOKEN（secret 缺失时读出空串），
// 空 expected 与一条空的 Bearer 凭据相等会让管理端点变成人人可写。
// 这条守卫放在比较之前，任何 compare 实现都绕不过去。
//
// 类型守卫必须先于空串判定，且必须写成 typeof 而不是 == null：
// TextEncoder().encode(null) 得到 4 字节的 "null"（不是 0 字节），于是
// "Authorization: Bearer null" 与 null 等长全等、认证直接通过；undefined
// 才得 0 字节、被长度闸门兜住。装配层写 env.ADMIN_TOKEN ?? null、或测试
// 注入 null 时，只有 typeof 能拦住这类活口。签名收 string，这个判定是为
// 「调用点绕过类型」的真实场景准备的。
export function verifyBearer(request: Request, expected: string, compare: CredentialCompare = constantTimeEqual): boolean {
  if (typeof expected !== "string" || expected === "") return false;
  const header = request.headers.get("Authorization");
  if (header === null) return false;
  const match = BEARER_PATTERN.exec(header);
  if (match === null) return false;
  return compare(match[1], expected);
}

// isAdminPath 判定路径是否归管理端。只认固定前缀与它的子路径。
//
// 分隔符必须显式要求（`${ADMIN_PREFIX}/`）：只判 startsWith 会把
// /api/admin/rosterX 也当成管理端点，而那条路径在装配层的兜底路由里
// 本该答 404——落到这里就会先要求认证，把「路径不存在」变成 401。
export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
}

// 管理 handler 的依赖注入形态：token 由装配层从 secret 读出后传入，
// 本文件不读全局配置——handler 因此可以在测试里用任意 token 跑完整逻辑。
export interface AdminContext {
  store: RosterStore;
  adminToken: string;
}

// errorMessage 取错误的文本形态。校验失败一律是 Error（shared/roster.ts
// 与 rosterStore 都抛 Error），非 Error 的抛出值只可能来自注入的 fake，
// 用 String 兜住而不是让 message 变成 "[object Object]"。
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// decodeSchool 把路径段还原成校名。畸形百分号转义（"%E0%A4" 这类）会让
// decodeURIComponent 抛 URIError，作为路径参数它是「这个目标不存在」而不是
// 服务故障，因此统一降级成 null，由调用点答 404。
function decodeSchool(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

// unauthorized 是认证失败的唯一响应形态。缺头、格式不对、token 错都走它，
// 三者的响应逐字相同（同状态、同体、同头），因此无法从中反推原因。
//
// 带 WWW-Authenticate: Bearer：RFC 7235 要求 401 用这个头告知客户端该用哪种
// 认证方案，客户端与运维工具（curl -u 之外的一切）都按它提示重试。它是常量，
// 不随失败原因变化，因此不影响「三条失败路径逐字相同」这条约束。
function unauthorized(): Response {
  return writeJSON(401, { error: ERR_UNAUTHORIZED }, { "WWW-Authenticate": "Bearer" });
}

// rosterValidationFailed 把加载侧的校验错误转成 400：码固定 invalid_roster，
// message 逐字沿用 shared/roster.ts 的文案（带来源名/校名/年级名，运维据此
// 定位到上传文件里的哪一层）。本文件不加前缀、不改写——文案的 owner 是校验层，
// 这里只是搬运。
//
// 校名不合法（空名/保留名 index/含控制字符/键名超长）同样落到这个码上：对客户端
// 而言「这次请求给的校名不能用」与「上传的名单不能用」都是要改请求重发，码相同
// 不损失信息，文案已经把具体原因说清楚了。
//
// 本函数只处理「客户端可修」的错误。调用点的约定是：
//
//   InvalidSchoolNameError  校名不合法（空名/保留名/控制字符/键名超长）→ 400
//   InvalidRosterError      名单内容不合法（解析/结构/班级格式等）→ 400 + 加载侧文案
//   其余                     存储层抛错（KV 读写故障）→ 500 data_unavailable
//
// 第三类绝不能走这里：平台抛出的错误文本（上游超时、限流、值超限）会被原样
// 塞进 message，把「存储层写失败」标注成「你上传的内容不合法」，管理员拿着
// 好文件反复重传，同时内部错误文本外露给客户端。分流由调用点做（见 PUT 与
// DELETE 各自的 catch），本函数不猜错误类型。
function rosterValidationFailed(error: unknown): Response {
  return writeJSON(400, { error: ERR_INVALID_ROSTER, message: errorMessage(error) });
}

// adminHandlers 是管理端的 HTTP 翻译层：认证 -> 路径拆分 -> 方法分派 -> 委托 store。
//
// 顺序是硬约束：
// 1. 认证先于一切。未认证的请求不该拿到 405（「这个方法在这里不被允许」）
//    或 404（「这个路径不存在」）这类结构信息，也不该为一次注定被拒的请求
//    付任何 KV 读。
// 2. 路径拆分先于方法判定。集合与单项的方法集合不同，Allow 头也不同；
//    先判方法就得先知道自己在哪条路径上。
// 3. 方法判定先于数据读写。这条与公共端点同义：405 不该消耗一次 KV 操作，
//    也让「方法限定在 handler 第一行」这条纪律在管理端同样可断言。
export async function adminHandlers(request: Request, ctx: AdminContext): Promise<Response> {
  if (!verifyBearer(request, ctx.adminToken)) {
    return unauthorized();
  }

  const pathname = new URL(request.url).pathname;
  if (!isAdminPath(pathname)) {
    // 装配层只会在 isAdminPath 为真时路由到这里；这一个分支是为「调用点
    // 判错」兜底。它答 404 而不是 401，因为路径本身不属于管理端，
    // 与认证无关——若走 unauthorized，调用点的 bug 会表现为「认证坏了」。
    return writeError(ERR_CODES.notFound);
  }

  const rest = pathname.slice(ADMIN_PREFIX.length);

  // 集合路径：恰好是前缀本身（无尾斜杠）。
  if (rest === "") {
    if (request.method !== "GET") {
      return writeError(ERR_CODES.methodNotAllowed, { Allow: "GET" });
    }
    try {
      // listSchools 读 index，不加载任何 roster：列表页不该为了一串校名
      // 付全量解析的代价。index 缺失返回空数组是管理端的自然空态
      //（「一所都还没上传」），不是错误。
      return writeJSON(200, { schools: await ctx.store.listSchools() });
    } catch {
      // index 被写坏时列表无法给出可信答案。用公共错误码 data_unavailable
      // 而不新增管理端专属码：客户端处置动作与公共端点一致（都该去修数据），
      // 管理端专属码没有带来新的信息。
      return writeError(ERR_CODES.dataUnavailable);
    }
  }

  const school = decodeSchool(rest.slice(1));
  // 校名为空（路径以尾斜杠结尾，如 /api/admin/roster/）或转义畸形：目标
  // 不存在。必须在调 store 之前拦下——空校名进去会让 rosterStore 抛
  // 「校名不能为空」，那条消息会被下面的 catch 映射成 400 invalid_roster，
  // 把「路径没写全」说成「名单内容不合法」，排障方向被引偏一层。
  if (school === null || trimGoSpace(school) === "") {
    return writeError(ERR_CODES.notFound);
  }

  if (request.method === "PUT") {
    const payload = await request.text();
    try {
      const { students } = await ctx.store.putRoster(school, payload);
      // 回显归一后的校名（落键形态），而不是路径原文：带前后空白的路径段
      // 与不带空白的是同一项，回显原文会让管理员以为存在两个不同的学校。
      // 归一动作本身仍归 rosterStore 所有，这里只是用同一份 shared 空白语义
      //（trimGoSpace）算出回显值，不重新实现落键。
      return writeJSON(201, { school: trimGoSpace(school), students });
    } catch (error) {
      // 两类「客户端可修」的失败都答 400，但必须与存储故障分开：
      //
      // 1. 校名不合法（空名/保留名 index/控制字符/键名超长）：由存储层在读写
      //    之前抛出，KV 还没被动过。message 是「这个校名不能用」。
      // 2. 名单内容不合法：parseSingleDocument 在第一次 kv.put 之前完成，
      //    抛出的 message 是 shared/roster.ts 的应届文案（带来源名/校名/年级名），
      //    运维据此定位到上传文件里的哪一层。
      //
      // 其余一律是存储故障。它绝不能走 400：平台的错误文本（值大小超限、限流、
      // 超时）会被原样塞进 message，把「存储层写失败」标注成「你上传的内容
      // 不合法」——管理员拿着好文件反复重传，排障方向被引偏，同时内部错误
      // 文本外露给客户端。这里与 GET 列表同答 data_unavailable。
      //
      // 键名超长不在这条分支上：它已在 rosterStore.normalizeSchoolName 前置拦下，
      // 抛 InvalidSchoolNameError，走上面的 400。
      if (error instanceof InvalidSchoolNameError || error instanceof InvalidRosterError) {
        return rosterValidationFailed(error);
      }
      return writeError(ERR_CODES.dataUnavailable);
    }
  }

  if (request.method === "DELETE") {
    // 与 GET 列表同形：store 抛错一律翻译成 data_unavailable。
    //
    // 触发面是「存储层自身故障」：index 内容损坏（parseSchoolIndex 抛）、
    // KV 读写调用本身抛错（上游超时、限流之后仍失败）。这些都不该让异常冒泡，
    // 否则同一份「存储层拒绝了这个动作」在 GET 得 data_unavailable（说「去修
    // 数据」）、在这里得 500 空体（说「这是代码 bug」），排障方向被引偏一层。
    // 两处同码才让人往同一处找。
    //
    // 校名不合法（保留名 index、含控制字符、键名超长）不是数据问题：
    // InvalidSchoolNameError 由存储层抛在读写之前，它答 400（改请求重发），
    // 不走 500。键名超长在存储层前置拦下，因此不会再走到这里的 KV 抛错分支。
    try {
      const deleted = await ctx.store.deleteRoster(school);
      // deleteRoster 返回「该校是否在 index 里」：false 表示这所学校从未上传
      //（或已被删除），对管理员是「目标不存在」，答 404 而不是 200 幂等成功——
      // 拼错校名的 DELETE 若答 200，管理员会以为删掉了一所实际还在的学校。
      if (!deleted) {
        return writeError(ERR_CODES.notFound);
      }
      return writeJSON(200, { deleted: true });
    } catch (error) {
      // 校名不合法（保留名 index、含控制字符、键名超长）不是数据问题：
      // 它由存储层抛在读写之前，答 400（改请求重发），不走 500。
      if (error instanceof InvalidSchoolNameError) {
        return rosterValidationFailed(error);
      }
      return writeError(ERR_CODES.dataUnavailable);
    }
  }

  // 单项路径只接受 PUT / DELETE。Allow 逐字列出两者而不是笼统的 "PUT, DELETE"
  // 之外再加 GET——列表在集合路径上，单项路径没有 GET。
  return writeError(ERR_CODES.methodNotAllowed, { Allow: "PUT, DELETE" });
}
