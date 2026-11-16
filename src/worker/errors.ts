// 错误码与 JSON 写出的单一事实源，平移自 Go 端 server/errors.go。
// 全站 JSON 错误体与成功响应体都从这里出去：发射点只挑码，
// 状态查表、Content-Type、body 序列化只由本文件定义。
//
// 与 Go 的形态对照：
// Go 的 writeError(w, code) 只收码，状态由 errStatus 表带出，未知码回落 500。
// 本层 writeError 同样只收码：Response 构造需要显式 status，但那个 status
// 由本函数自己查 ERR_STATUS 得出，发射点不参与——「发射点只传码，writeError
// 统一查表带出状态」这条原始决策因此完整保住，一处都不重复。
// ERR_STATUS 仍是状态的唯一登记处。新增码若不登记，查表得 undefined，
// 由 `?? 500` 回落 500（与 Go 未知码处置同义），并由 errors.test.ts 的
// 尺寸断言与未知码行为断言共同捕获遗漏。
// 响应体形态保持 {"error": code} 单键：Go 用 map[string]string，多一个字段
// 就是 wire 契约变更，前端与人工排查都在读它。
//
// 异常路径（handlers 内抛出、index 层统一转 Response）走 ApiException，
// 它的 status 由抛出点给定，但错误体形态同样收在本模块的 toResponse 里，
// 不留给装配层手拼 JSON。

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
// 类型保持 Record<string, number>：内部查表要能接受未登记过的码，
// 由 writeError 的 `?? 500` 兜住；发射点不再自己索引这张表，
// 所以类型层「索引返回裸 number」不会让任何调用点写出错误状态。
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

// writeJSON 写出 JSON 响应：先铺调用点的头，再用 Headers.set 覆盖 Content-Type，
// 最后序列化 body。
//
// 用 Headers 而不是把 headers 对象手抄进一个新对象：HTTP 头名大小写不敏感，
// 而对象键敏感。手抄时调用点传 {"content-type":"text/plain"} 会与
// merged["Content-Type"] 各占一个键，序列化出
// "text/plain, application/json; charset=utf-8" 这种非法拼接值。
// Headers 天然做大小写折叠，set 之后同名头只剩一个值。顺带省下手抄循环。
//
// Content-Type 由本函数持有唯一写权：调用点传什么都会被覆盖，
// 否则「JSON 写出」这个函数名不再保证 body 可被 JSON 解析。
// 其余头（Cache-Control、Retry-After、Allow）由调用点决定，本函数不设默认值，
// 避免在写出层埋下与 middleware 层冲突的策略。
export function writeJSON(status: number, value: unknown, headers?: Record<string, string>): Response {
  const finalHeaders = new Headers(headers);
  finalHeaders.set("Content-Type", JSON_CONTENT_TYPE);
  // value 为 undefined 时 JSON.stringify 返回 undefined（不是 "null"），
  // Response 会因此写出 0 字节 body——与 Go 的 json.Encoder.Encode(nil)
  // 产出 null 不一致。用 ?? null 统一成 JSON 的空值字面量。
  return new Response(JSON.stringify(value ?? null), { status, headers: finalHeaders });
}

// writeError 写出 JSON 错误体：发射点只传错误码（可选头），
// 状态由本函数查 ERR_STATUS 带出，未登记的码回落 500。
// 响应体固定为 {"error": code} 单键。
export function writeError(code: string, headers?: Record<string, string>): Response {
  return writeJSON(ERR_STATUS[code] ?? 500, { error: code }, headers);
}

// ApiException 是 handlers 抛出的错误载体：status 决定响应码、code 决定
// 响应体、headers 承载 Allow / Retry-After 这类随错误码变化的头。
// 抛出点已知道自己的地位（参数校验失败是 400、限流是 429），所以这里收 status；
// 转成 Response 的动作收在 toResponse 里，index 层只写 catch -> toResponse，
// 不手拼 JSON、不重新查表——错误体形态仍由本模块独占。
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

  // toResponse 把异常转成错误响应：状态取抛出点给的 status，
  // body 仍走 writeError 的单键错误体形态与 JSON 写出格式。
  // 这里刻意不用 ERR_STATUS 查表：抛出点已经给出状态，
  // 再查一次会让两处状态来源打架。
  toResponse(): Response {
    return writeJSON(this.status, { error: this.code }, this.headers);
  }
}
