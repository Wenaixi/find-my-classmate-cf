// 错误码与 JSON 写出的回归测试，用例从 Go 端 server/errors_test.go 平移：
// TestErrStatusMapping（每个错误码与状态的绑定逐条锁死 + 表尺寸断言）、
// TestWriteErrorUnknownCodeFallsBackTo500、TestWriteErrorWritesJSONBody，
// 并从 server/main_test.go 的未知 /api/* 404、TestHealthMethodNotAllowed /
// TestSearchMethodNotAllowed（405 带 Allow: GET）、server/ratelimit_test.go
// 的 429 带 Retry-After 补齐 headers 通道的用例。
//
// 签名与 Go 对齐：writeError 只收错误码（外加可选头），状态由函数内部查
// ERR_STATUS 带出。因此「未知码回落 500」测的是函数行为，与 Go 的用例同义。
// ApiException 的 status 由抛出点给定（抛出处已知自己是 400 还是 429），
// toResponse 只负责把 status + code + headers 转成响应。
import { describe, expect, it } from "vitest";
import { ApiException, ERR_CODES, ERR_STATUS, writeError, writeJSON } from "./errors";

// 与 Go 端 errStatus 相同的期望表，逐条对照而非取自实现本身：
// 直接读 ERR_STATUS 再断言 ERR_STATUS 等于自己，什么实现错误都测不出来。
const wantStatus: Record<string, number> = {
  [ERR_CODES.notFound]: 404,
  [ERR_CODES.methodNotAllowed]: 405,
  [ERR_CODES.invalidLimit]: 400,
  [ERR_CODES.invalidOffset]: 400,
  [ERR_CODES.invalidQuery]: 400,
  [ERR_CODES.dataUnavailable]: 500,
  [ERR_CODES.rateLimited]: 429,
};

// 与 Go 的 Content-Type 逐字一致；charset 不能省，前端按 UTF-8 解中文错误文案。
const jsonContentType = "application/json; charset=utf-8";

describe("ERR_STATUS 错误码到 HTTP 状态映射", () => {
  // 对应 Go 端 TestErrStatusMapping 的逐条循环。
  it("每个错误码映射到约定状态", () => {
    for (const [code, status] of Object.entries(wantStatus)) {
      expect(ERR_STATUS[code], `码 ${code} 的状态`).toBe(status);
    }
  });

  // 对应 Go 端 TestErrStatusMapping 的尺寸断言：新增码必须登记一行，
  // 少了这一条，「四码共用一个状态」时漏登记会被逐条循环掩盖。
  it("映射表尺寸与错误码数量一致（每码一行）", () => {
    expect(Object.keys(ERR_STATUS).length).toBe(Object.keys(wantStatus).length);
    expect(Object.keys(ERR_CODES).length).toBe(Object.keys(wantStatus).length);
  });

  // 错误码字面值是对外 wire 契约的一部分，键名可以改，值被前端/日志消费。
  it("错误码取值为稳定的 snake_case 字符串", () => {
    expect(ERR_CODES.notFound).toBe("not_found");
    expect(ERR_CODES.methodNotAllowed).toBe("method_not_allowed");
    expect(ERR_CODES.invalidLimit).toBe("invalid_limit");
    expect(ERR_CODES.invalidOffset).toBe("invalid_offset");
    expect(ERR_CODES.invalidQuery).toBe("invalid_query");
    expect(ERR_CODES.dataUnavailable).toBe("data_unavailable");
    expect(ERR_CODES.rateLimited).toBe("rate_limited");
  });
});

describe("writeError 错误响应", () => {
  // 对应 Go 端 TestWriteErrorWritesJSONBody：状态 400、体为单键 error 对象。
  // 只断言单键，是因为 Go 用 map[string]string{"error": code}——多一个字段
  // 就是 wire 契约变化，前端与手工排查都在读这个 body。
  // 调用点只传码：状态由 writeError 自己查表带出，与 Go 的 writeError 同形。
  it("写出 status、Content-Type 与单键 error 体", async () => {
    const res = writeError(ERR_CODES.invalidLimit);
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ error: "invalid_limit" });
  });

  // 405 必须声明 Allow: GET（Go 端 api.go / schools.go 在写错误体前 Set）。
  it("405 可带 Allow 头", async () => {
    const res = writeError(ERR_CODES.methodNotAllowed, { Allow: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });

  // 429 必须带整数秒 Retry-After（Go 端 ratelimit.go 的约定）。
  it("429 可带 Retry-After 头", async () => {
    const res = writeError(ERR_CODES.rateLimited, { "Retry-After": "1" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  // 对应 Go 端 TestWriteErrorUnknownCodeFallsBackTo500：未登记的码回落 500。
  // 这条锁的是函数行为，不是测试作者自己写的取法——若有人把 writeError 改回
  // 「收 status」，这里必须重新失败，因为漏传状态在 Response 构造里会静默变 200。
  // 同时锁住 code 原样透出：错误路径不能再制造错误（体不能变成 {}）。
  it("未知码回落 500 且 code 原样保留", async () => {
    const res = writeError("unknown_code");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "unknown_code" });
  });

  // 未知 /api/* 的 404 端到端行为：从码到状态走完一次完整查表。
  // 只断言 ERR_STATUS[notFound] === 404 是表断言，断言 writeError 的输出
  // 才证明「码经由写出函数真的产出 404 加 JSON 体」。
  it("not_found 经写出函数产出 404 与 JSON 错误体", async () => {
    const res = writeError(ERR_CODES.notFound);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  // data_unavailable 经写出函数必须落 500：它与未知码回落值相同，
  // 若实现误把「查表失败」当唯一 500 来源，这条能区分「确实是这个码」。
  it("data_unavailable 经写出函数产出 500", async () => {
    expect(writeError(ERR_CODES.dataUnavailable).status).toBe(500);
  });

  // 错误响应不得被中间层缓存：调用点可通过 headers 传 Cache-Control，
  // 这里只验通道可用，具体策略由 middleware 层统一负责。
  it("headers 参数按原样铺设到响应", () => {
    const res = writeError(ERR_CODES.invalidQuery, { "Cache-Control": "no-store", "X-Trace": "abc" });
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace")).toBe("abc");
  });
});

describe("writeJSON 响应写出", () => {
  // Content-Type 是唯一事实源：调用点即便传了别的 Content-Type 也必须被覆盖，
  // 否则「JSON 写出」这个函数名就不再保证内容可被 JSON 解析。
  it("强制 Content-Type 并编码 value", async () => {
    const res = writeJSON(200, { ok: true, grades: ["高一"] });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ ok: true, grades: ["高一"] });
  });

  it("调用点传入的 Content-Type 被强制覆盖为 JSON", () => {
    const res = writeJSON(200, {}, { "Content-Type": "text/plain" });
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
  });

  // HTTP 头名大小写不敏感，对象键却敏感：若实现用手抄键名的方式合并，
  // 传 {"content-type":"text/plain"} 会与 "Content-Type" 各占一键，
  // 产出 "text/plain, application/json; charset=utf-8" 这种非法拼接值。
  // 这条断言最终值恰为单一 JSON 类型，锁住 Headers 的大小写折叠。
  it("小写 content-type 键同样被折叠覆盖为单一 JSON 类型", () => {
    const res = writeJSON(200, {}, { "content-type": "text/plain" });
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(res.headers.get("content-type")).toBe(jsonContentType);
  });

  // undefined 不带 JSON 表示：JSON.stringify(undefined) 返回 undefined，
  // Response 会吞成 0 字节 body，调用 res.json() 直接抛解析错误。
  // Go 的 Encode(nil) 产出 null，这里用 ?? null 对齐。
  it("value 为 undefined 时写出 null 而非空 body", async () => {
    const res = writeJSON(200, undefined);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.text()).toBe("null");
    expect(await writeJSON(200, undefined).json()).toBeNull();
  });

  it("可写出任意 JSON 值：数组、字符串、null、数字", async () => {
    expect(await writeJSON(201, [1, 2, 3]).json()).toEqual([1, 2, 3]);
    expect(await writeJSON(200, "纯文本值").json()).toBe("纯文本值");
    expect(await writeJSON(200, null).json()).toBeNull();
    expect(await writeJSON(200, 0).json()).toBe(0);
  });

  // 成功响应同样需要自定义头通道（health 的 Cache-Control: no-store 等）。
  it("headers 参数与 Content-Type 叠加", () => {
    const res = writeJSON(200, { ok: true }, { "Cache-Control": "no-store" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
  });

  it("status 原样透出，含 404 与 500", () => {
    expect(writeJSON(404, {}).status).toBe(404);
    expect(writeJSON(500, {}).status).toBe(500);
  });
});

describe("ApiException 异常承载", () => {
  // handlers 抛、index 捕获后转 Response：三者一个都不能丢，
  // status 决定响应码、code 决定响应体、headers 决定 Allow / Retry-After。
  it("携带 status、code 与可选 headers", () => {
    const err = new ApiException(429, ERR_CODES.rateLimited, { "Retry-After": "1" });
    expect(err.status).toBe(429);
    expect(err.code).toBe("rate_limited");
    expect(err.headers).toEqual({ "Retry-After": "1" });
    expect(err.message).toBe("rate_limited");
    expect(err.name).toBe("ApiException");
  });

  it("可省略 headers，且仍是 Error 实例可被捕获", () => {
    const err = new ApiException(404, ERR_CODES.notFound);
    expect(err.headers).toBeUndefined();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiException);
  });

  // toResponse 是 index 层唯一的转译入口：状态、错误体、头都在这里落地，
  // 装配层不手拼 JSON。体形态必须仍是单键 error，与 writeError 同源。
  it("toResponse 按抛出点给定的 status 产出错误响应", async () => {
    const err = new ApiException(400, ERR_CODES.invalidOffset);
    const res = err.toResponse();
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe(jsonContentType);
    expect(await res.json()).toEqual({ error: "invalid_offset" });
  });

  it("toResponse 保留抛出点给出的头（429 的 Retry-After）", async () => {
    const res = new ApiException(429, ERR_CODES.rateLimited, { "Retry-After": "1" }).toResponse();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  // 抛出点给的 status 优先：即便码在表里映射到别的状态（这里 data_unavailable
  // 映 500），异常路径也不回查 ERR_STATUS，避免两处状态来源打架。
  it("toResponse 不回落 ERR_STATUS 查表，status 以抛出点为准", () => {
    expect(new ApiException(418, ERR_CODES.dataUnavailable).toResponse().status).toBe(418);
  });

  // 抛出后能被 catch 拿到，且 instanceof 判定必须在对手写 Error 重生后仍成立：
  // 转译目标是 ES2022，不存在降级到 ES5 丢原型链的问题，这里锁住即可。
  it("抛出与捕获保持类型，且可直接转响应", async () => {
    try {
      throw new ApiException(405, ERR_CODES.methodNotAllowed, { Allow: "GET" });
    } catch (caught) {
      expect(caught).toBeInstanceOf(ApiException);
      expect((caught as ApiException).status).toBe(405);
      expect((caught as ApiException).headers).toEqual({ Allow: "GET" });
      const res = (caught as ApiException).toResponse();
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
    }
  });
});
