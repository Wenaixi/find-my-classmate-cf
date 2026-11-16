// 错误码与 JSON 写出的单一事实源，平移自 Go 端 server/errors.go。
// 全站 JSON 错误体与成功响应体都从这里出去：发射点只挑状态与码，
// 写出格式（Content-Type、body 序列化、头合并顺序）只由本文件定义。
//
// 与 Go 的一处签名差异及其等价性说明：
// Go 的 writeError(w, code) 只收码，状态由 errStatus 表带出，未知码回落 500。
// 本层 writeJSON/writeError 返回 Response（Workers 没有可写的 ResponseWriter，
// 状态必须在构造 Response 时给定），所以 writeError 额外收 status。
// 等价取法：发射点一律写 writeError(ERR_STATUS[code] ?? 500, code)——
// 查表命中时状态与 Go 表完全一致，查不到时也回落 500，与 Go 未知码处置同义。
// ERR_STATUS 仍是状态的唯一登记处；新增码必须在此登记，否则发射点会静默拿到
// undefined 而落到 500（Go 侧由 TestErrStatusMapping 的尺寸断言捕获，本层由
// errors.test.ts 的同名断言捕获）。
// 响应体形态保持 {"error": code} 单键：Go 用 map[string]string，多一个字段
// 就是 wire 契约变更，前端与人工排查都在读它。

// 错误码字面值表：对外 wire 契约的一部分，取值不可随意改。
export const ERR_CODES = {
  // 未知 /api/* 路径。
  notFound: "not_found",
  // 非 GET 访问 /api/* 只读接口（health/search/schools，响应带 Allow: GET）。
  methodNotAllowed: "method_not_allowed",
  // limit 非数字或越界（1-50）。
  invalidLimit: "invalid_limit",
  // offset 非数字或负数。
  invalidOffset: "invalid_offset",
  // 查询串超过 maxQueryRunes。
  invalidQuery: "invalid_query",
  // 数据源缺失或损坏（500）。
  dataUnavailable: "data_unavailable",
  // 限流拒绝（429，响应带 Retry-After）。
  rateLimited: "rate_limited"
} as const;

// 错误码到 HTTP 状态的唯一映射表，与 Go 端 errStatus 逐字一致。
// 类型放宽为 Record<string, number>（而非按 ERR_CODES 的键做精确类型）：
// 调用点会用 ERR_STATUS[某个可能不存在的码] 取状态并 ?? 500 回落，
// 精确键类型会让这种查表直接通不过编译，等于逼调用点改写状态，
// 状态登记就又散回发射点了。
export const ERR_STATUS: Record<string, number> = {
  [ERR_CODES.notFound]: 404,
  [ERR_CODES.methodNotAllowed]: 405,
  [ERR_CODES.invalidLimit]: 400,
  [ERR_CODES.invalidOffset]: 400,
  [ERR_CODES.invalidQuery]: 400,
  [ERR_CODES.dataUnavailable]: 500,
  [ERR_CODES.rateLimited]: 429
};

// JSON 响应的 Content-Type，与 Go 端 writeJSON 逐字一致。
// charset=utf-8 不可省：中文错误文案与校名/姓名都在响应体里。
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

// writeJSON 写出 JSON 响应：先铺调用点的头，再强制覆盖 Content-Type，
// 最后序列化 body。
//
// 顺序是刻意的：Content-Type 由本函数持有唯一写权，调用点传了 text/plain
// 也会被覆盖——否则「JSON 写出」这个函数名不再保证内容可被 JSON 解析。
// 其余头（Cache-Control、Retry-After、Allow）由调用点决定，本函数不设默认值，
// 避免在写出层埋下与 middleware 层冲突的策略。
export function writeJSON(status: number, value: unknown, headers?: Record<string, string>): Response {
  const init: ResponseInit = { status };
  if (headers) {
    // 复制一份再覆盖，不改动调用点持有的对象。
    const merged: Record<string, string> = {};
    for (const [name, headerValue] of Object.entries(headers)) {
      merged[name] = headerValue;
    }
    merged["Content-Type"] = JSON_CONTENT_TYPE;
    init.headers = merged;
  } else {
    init.headers = { "Content-Type": JSON_CONTENT_TYPE };
  }
  return new Response(JSON.stringify(value), init);
}

// writeError 写出 JSON 错误体：调用点给出状态与错误码，响应体固定为
// {"error": code} 单键。
// 状态不在此查表（Response 构造必须显式给 status），调用点按
// ERR_STATUS[code] ?? 500 取值，语义与 Go 未知码回落 500 相同。
export function writeError(status: number, code: string, headers?: Record<string, string>): Response {
  return writeJSON(status, { error: code }, headers);
}

// ApiException 是 handlers 抛出的错误载体：status 决定响应码、code 决定
// 响应体、headers 承载 Allow / Retry-After 这类随错误码变化的头。
// index 层 fetch 捕获后直接 writeError(e.status, e.code, e.headers) 转成 Response，
// 因此构造器只做搬运，不做状态查表——查表留在 ERR_STATUS，转译留在写出函数。
//
// message 取错误码本身：日志里看到 ApiException 就带着码，不必再读自定义字段。
export class ApiException extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly headers?: Record<string, string>;

  constructor(status: number, code: string, headers?: Record<string, string>) {
    super(code);
    this.name = "ApiException";
    this.status = status;
    this.code = code;
    if (headers !== undefined) {
      this.headers = headers;
    }
  }
}
