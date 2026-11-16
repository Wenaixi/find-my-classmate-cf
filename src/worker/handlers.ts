// HTTP 翻译层的单一 owner：把 Go 端 server/api.go 的 buildMux / searchHandler /
// schoolsHandler 与 /api/health 探针平移为 Workers 的 handler 函数。
//
// 本文件只做 HTTP 翻译：参数取值、错误码映射与 JSON 写出。查询语义（解析、匹配、
// 排序、分页）唯一归属 worker/search.ts，学校下拉派生唯一归属 worker/schools.ts，
// 名单加载唯一归属 worker/rosterStore.ts，错误体形态与状态查表唯一归属
// worker/errors.ts。此处不复制其中任何一条规则——只把 wire 形态翻译成调用。
//
// 两条从 Go 端承重的形态约束：
//
// 1. 错误响应的状态不在这里出现。writeError(code, headers?) 自己查 ERR_STATUS
//    带出状态，发射点只挑码（Ruling 15）。若在调用点写 ERR_STATUS[code]，
//    漏写兜底就会把错误答成 200 + 空体，同一张表还会被每个发射点抄一遍。
//
// 2. 领域形状绝不出这个文件。RosterStudent 带着 nameKey / classNo / gradeIdx /
//    schoolIdx 四个派生字段；Go 端靠 json:"-" 把它们挡在 wire 外，TS 没有这个
//    机制，直接序列化领域对象就会把这些字段漏给前端。因此成功路径必须先经
//    toWireStudent 收窄成四个字段，再交给 writeJSON。班级字段的键名是 class
//    （不是 className）：server/search.go 的 json tag 与前端 src/lib/api.ts 的
//    decodeItem 都按 item.class 取值，写成 className 会让前端把每一条响应当成
//    invalid-response，服务端却一切正常——这是最典型的静默 wire 分叉。
import { trimGoSpace } from "../shared/classparse";
import { MAX_LIMIT, MAX_QUERY_LENGTH, PAGE_SIZE } from "../shared/contract";
import type { Grade } from "../shared/grades";
import type { RosterStudent } from "../shared/student";
import { ERR_CODES, writeError, writeJSON } from "./errors";
import type { RosterStore } from "./rosterStore";
import { schoolList } from "./schools";
import { SearchInSchool } from "./search";

// handler 的依赖注入形态：store 由装配层给出，不在本文件构造。
// 这样 handlers 的测试可以注入内存 fake KV 的 RosterStore，装配层也能按请求
// 绑定真实的 KV namespace——两种场景共用同一份 handler 代码，无分支。
export interface HandlerContext {
  store: RosterStore;
}

// health 的上下文多一个 version：探针要答「这份部署是谁」，
// 503 也带 version，否则降级响应在编排层与日志里无法指认部署。
export interface HealthContext extends HandlerContext {
  version: string;
}

// wire 学生形状：字段名与 Go 端 search.go 的 json tag 逐字一致。
// class 而不是 className 是契约，理由见文件头。四个字段就是全部，不加不减少。
export interface WireStudent {
  name: string;
  school: string;
  grade: Grade;
  class: string;
}

// toWireStudent 把领域学生收窄成 wire 形状，是隐私红线的唯一关口。
//
// 显式逐字段取值而不是解构后 spread：spread 会把领域对象里所有键原样带出去，
// 将来在 RosterStudent 上新增任何派生字段（比如姓名拼音、学号）都会静默泄漏，
// 而这里一个白名单结构体反而让「新增字段要不要外泄」变成必须显式决定的事。
export function toWireStudent(student: RosterStudent): WireStudent {
  return {
    name: student.name,
    school: student.school,
    grade: student.grade,
    class: student.className,
  };
}

// 整数文本的字面形态：可选正负号加十进制数字。与 Go 的 strconv.Atoi 对齐——
// 它接受 "+7"、"-7"、前导零，但拒绝空白、小数、十六进制与科学计数法。
// 用正则而不是 Number() 直接转型，是因为 Number(" 12 ") === 12、"0x10" === 16、
// "12abc" 是 NaN 而 " " 是 0，这几种在 Go 里都是 Atoi 错误码。
const INTEGER_LITERAL = /^[+-]?[0-9]+$/;

// int64 边界，与 Go 的 Atoi 溢出判据一致。用 BigInt 而不是十进制数字字面量：
// Number 在 2^53 以上会舍入，9223372036854775807 与它的溢出后继在浮点上相等，
// 「刚刚越界」这一格判定不出来（实测 9223372036854775808 被判成合法）。
// BigInt 逐位精确，边界因此与 Go 逐字对齐。
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// parseInteger 复刻 strconv.Atoi 的判定：非法形态返回 null，溢出同样返回 null。
// 调用点用 null 表示「不可解析」，与「解析出 0」区分开——offset=0 是合法边界，
// 若用 0 兼表失败，边界格会被误判成 400。
//
// 范围判定走 BigInt，返回值走 Number：Go 在 int64 内接受的值可能超过 2^53
// 精确范围，但唯一的消费方是搜索层的分页钳制（offset 超匹配条数即钳到末尾），
// 精度损失不改变任何实际行为；limit 另有 1..MAX_LIMIT 的窄约束，不受影响。
function parseInteger(raw: string): number | null {
  if (!INTEGER_LITERAL.test(raw)) return null;
  const big = BigInt(raw);
  if (big < INT64_MIN || big > INT64_MAX) return null;
  return Number(big);
}

// searchHandler 翻译 GET /api/search 的 wire 契约：方法、limit、offset 与
// 查询串/校名的长度校验在此完成并映射为 400 契约错误码；数据不可用映射为 500。
// 成功路径委托 SearchInSchool，由它独占匹配、排序与分页语义。
//
// 校验顺序逐条照搬 Go 端 api.go：方法 → limit → offset → q → school → 数据加载。
// 顺序本身是行为的一部分（同时给出坏 limit 与坏 offset 时答哪个码），
// 也让「方法不合法的请求不付任何 KV 读」成为可断言的事实。
export async function searchHandler(request: Request, ctx: HandlerContext): Promise<Response> {
  if (request.method !== "GET") {
    // 405 必须声明 Allow: GET，与 Go 在写错误体前 Set("Allow") 同形。
    return writeError(ERR_CODES.methodNotAllowed, { Allow: "GET" });
  }

  const params = new URL(request.url).searchParams;

  // limit：缺省取 PAGE_SIZE，显式值必须落在 1..MAX_LIMIT。
  // 空串与缺省同判，因为 Go 的 url.Query().Get 对 "?limit=" 与不传都返回空串，
  // 两者都该走默认值，而不是被当成「非数字」去报 400。
  let limit = PAGE_SIZE;
  const limitRaw = params.get("limit");
  if (limitRaw !== null && limitRaw !== "") {
    const parsed = parseInteger(limitRaw);
    if (parsed === null || parsed < 1 || parsed > MAX_LIMIT) {
      return writeError(ERR_CODES.invalidLimit);
    }
    limit = parsed;
  }

  // offset：缺省 0，显式值须非负。上界不在此校验——分页自守交给搜索层
  // （offset 超过匹配条数会被钳到末尾，与 Go 的 Search 同语义）。
  let offset = 0;
  const offsetRaw = params.get("offset");
  if (offsetRaw !== null && offsetRaw !== "") {
    const parsed = parseInteger(offsetRaw);
    if (parsed === null || parsed < 0) {
      return writeError(ERR_CODES.invalidOffset);
    }
    offset = parsed;
  }

  // q：长度上限在剥空白之后按 rune 计。用 rune 而不是 q.length——后者按
  // UTF-16 码元计，一个 emoji 算 2，80 个 emoji 会被误判成超限；而 Go 的
  // len([]rune(...)) 数的是码位。长度检查用剥空白后的串，喂给搜索层的却是
  // 原始串，与 Go 端 api.go 的写法逐字一致（剥空白只服务于长度判定）。
  const q = params.get("q") ?? "";
  if ([...trimGoSpace(q)].length > MAX_QUERY_LENGTH) {
    return writeError(ERR_CODES.invalidQuery);
  }

  // school：来自下拉选择的精确校名，先剥空白再判长、再原样交给搜索层过滤。
  // 与 q 共用同一上限（校名远短于此，这条只防异常超长输入）。
  const school = trimGoSpace(params.get("school") ?? "");
  if ([...school].length > MAX_QUERY_LENGTH) {
    return writeError(ERR_CODES.invalidQuery);
  }

  // 数据加载是最后一步：上面的参数错误都不该为了报 400 去读一次 KV。
  // loadAll 的全或无语义由 rosterStore 独占，失败原因（index 缺失、文档损坏）
  // 已在那里收口，此处只把「取不到名单」翻译成 500 data_unavailable。
  let students: RosterStudent[];
  try {
    students = (await ctx.store.loadAll()).students;
  } catch {
    return writeError(ERR_CODES.dataUnavailable);
  }

  const result = SearchInSchool(students, q, school, limit, offset);

  // 先映射成 wire 形状再写出：items 是收窄过的四个字段，其余四个分页字段
  // 逐字取自搜索结果（含搜索层钳制后的 limit/offset）。绝不直接写 result——
  // result.items 是领域对象数组，序列化即泄漏派生字段。
  return writeJSON(200, {
    items: result.items.map(toWireStudent),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    hasMore: result.hasMore,
  });
}

// schoolsHandler 翻译 GET /api/schools：只读接口，非 GET 一律 405 + Allow。
// 成功体是单键 {schools: [...]}，与 Go 端 schools.go 同形；派生规则（只列
// 含高中年段的学校、去重、按加载序）由 schools.ts 独占，此处不重述。
export async function schoolsHandler(request: Request, ctx: HandlerContext): Promise<Response> {
  if (request.method !== "GET") {
    return writeError(ERR_CODES.methodNotAllowed, { Allow: "GET" });
  }

  let students: RosterStudent[];
  try {
    students = (await ctx.store.loadAll()).students;
  } catch {
    return writeError(ERR_CODES.dataUnavailable);
  }

  return writeJSON(200, { schools: schoolList(students) });
}

// healthHandler 是探针：答「现在能不能对外声称数据完整」。
//
// 探测接口同样是只读端点，方法限定必须与 search / schools 同形：非 GET 一律
// 405 并声明 Allow: GET（Go 端 api.go 把这条判定放在 handler 第一行）。
// 顺序是硬约束——方法判定必须在任何 KV 读之前完成：写方法在探针路径上走到
// 下游逻辑，会让「服务对一切方法都健康」这种误解成立，而每次探针的 KV 读
// 现在已知要为健康检查付三次（见下），不该被一个注定 405 的请求白白消耗。
//
// 判据不是「有没有加载到任何一份名单」，而是「index 声明的每一所学校本次是否
// 都读到了」。loadAll().schools 是本次实际加载成功的集合（已过滤掉读不到原文
// 的项），listSchools() 读 index、是声明集合；两者的差集就是本次被跳过的学校。
//
// 为什么差集非空也算降级：KV 的写扩散不是瞬时的，跨 colo 的写入要等 read cache
// 过期才可见（rosterStore 的 cacheTtl 当前 60 秒），因此在某个 colo 上「index
// 已更新、某校原文还没扩散到」是正常且必然出现的窗口。窗口内服务仍在跑、
// 其余学校照常可查，但对外数据是少一所的——此时答 200 ok 就是在向编排层与
// 前端声称一份不完整的名单完整可用，而这正是 Task 9 里那种「静默少一所」的
// 不可观测形态。把它报成 degraded 之后，运维能从一个探针请求看出差异，
// 而不必等用户反馈「搜不到某校的人」。reason 取 partial 与 data 区分开：
// data 指「一所都不可用」（loadAll 已 fail-closed），partial 指「部分学校
// 此刻不可见」，两者的处置动作不同（前者查上传，后者等缓存扩散或查写入）。
//
// listSchools 自身抛错（index 内容损坏）与 loadAll 失败同判：探针无法确认
// 声明集合，就无从声称完整性，因此同样归到 reason=data 的 503。
// 注意 index 缺失这一支不会抛错——rosterStore 的 listSchools 对缺失返回空数组
// （那是管理端列表的自然空态），所以「声明集合为空」必须在这里单独判成失败：
// loadAll 能加载到学生、而声明集合却为空，只可能是两次读取之间 index 消失了，
// 此时若答 200 ok 就等于声称一份自己已经读不到索引的名单完整可用。
//
// 两次读取之间有窗口（TOCTOU）：loadAll 与 listSchools 各读一次 index，
// KV 的最终一致意味着两次内容可能不一致——第二次多出一校会表现为差集非空，
// 走 partial，这正是「有学校此刻读不到」的语义，可接受；第二次少一校则
// 差集缩小甚至为空，探针会偏乐观地答 ok，但那一校在 loadAll 的批量读里
// 也没读到、下一次探针就会看到。探针的价值在于「窗口内的降级可见」而非
// 提供快照一致性，因此不为此加互斥或复用同一次 index 读。
//
// 注意 503 也带 version，否则降级响应无法指认部署。
export async function healthHandler(request: Request, ctx: HealthContext): Promise<Response> {
  if (request.method !== "GET") {
    return writeError(ERR_CODES.methodNotAllowed, { Allow: "GET" });
  }

  try {
    const loaded = await ctx.store.loadAll();
    const declared = await ctx.store.listSchools();
    if (declared.length === 0) {
      return writeJSON(503, { status: "degraded", reason: "data", version: ctx.version });
    }
    const skipped = declared.filter((school) => !loaded.schools.includes(school));
    if (skipped.length > 0) {
      return writeJSON(503, { status: "degraded", reason: "partial", version: ctx.version });
    }
    return writeJSON(200, { status: "ok", version: ctx.version });
  } catch {
    return writeJSON(503, { status: "degraded", reason: "data", version: ctx.version });
  }
}

// notFoundHandler 是未知 /api/* 的兜底：JSON 404 单键体，与全站错误格式一致。
// 形状走 writeError 而不手拼 JSON，错误体形态因此仍由 errors.ts 独占。
// 没有 request 参数：兜底路由对方法与路径都不做区分，任何走到这里的形式
// 都是同一个答案。
export function notFoundHandler(): Response {
  return writeError(ERR_CODES.notFound);
}
