#!/usr/bin/env node
// 迁移期对拍脚手架：并行请求旧 Go 服务与 wrangler dev 的 Worker，逐字段比较响应。
//
// 用途：在删掉 Go 之前，用同一批查询打两个服务，把「行为等价」从口头承诺变成
// 可复现的差异表。它不是生产代码，价值在「能真跑出差异」，所以宁可粗糙也要
// 把差异摆到台面上。
//
// 用法：
//   node scripts/local-dev.mjs                       # 默认 Go=3078、Worker=8787
//   node scripts/local-dev.mjs --go-port 3078 --worker-port 8787
//   node scripts/local-dev.mjs --self-test           # 只跑比较逻辑自测，不联网
//
// 退出码：
//   0  所有查询完全一致
//   1  存在差异（差异按类别标注：behavior 行为差异 / data-missing 数据缺失 / env 环境限制）
//   2  有一侧服务没起来（连接失败）——绝不把「没起来」静默当成「一致」
//
// 前置：Go 侧需 data/*.json；Worker 侧需本地 KV 里有名单（wrangler dev 的本地 KV
// 是本地持久化目录，重启不清空，但新 worktree 里是空的）。灌数据见报告里的命令。
//
// 注意：Worker 的公共端点带限流（60 请求/60 秒）。本脚本一轮 26 条查询，单轮不会
// 触发；短时间内重复跑会看到 429，脚本把它标成 env 而不是行为差异。

import assert from "node:assert/strict";

const DEFAULT_GO_PORT = 3078;
const DEFAULT_WORKER_PORT = 8787;
// 单请求超时：Go 的 writeTimeout 是 15 秒，这里留一半余量避免对拍自己挂死。
const REQUEST_TIMEOUT_MS = 10_000;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

// 查询集：覆盖纯分隔符、降级样本、年段、连写、校名过滤、分页边界、超长查询、
// 未知路径与方法，以及两条真实数据检索（姓名精确 / 姓名前缀）。
// label 进差异表，params 用 URLSearchParams 编码，method 缺省 GET。
function buildCases() {
  // 81 个字符：契约上限是 80（src/shared/contract.ts 的 MAX_QUERY_LENGTH），
  // 多一个字用来踩 invalid_query 这条边界。
  const longQuery = "陈".repeat(81);
  return [
    // 纯分隔符 / 空查询：两端都必须退化为空结果，而不是全校全量
    { label: "空查询 q=", path: "/api/search", params: { q: "" } },
    { label: "纯顿号 q=、", path: "/api/search", params: { q: "、" } },
    { label: "纯加号 q=+++", path: "/api/search", params: { q: "+++" } },
    { label: "混合分隔符 q=，,、+", path: "/api/search", params: { q: "，,、+" } },

    // 降级样本：解析不出班号的连写要降级成姓名条件，不能放大成整年段
    { label: "降级样本 q=一一班", path: "/api/search", params: { q: "一一班" } },

    // 年段 / 连写：真实名单用「一班」「十班」写法，数字与汉字两种连写都试
    { label: "年段 q=高一", path: "/api/search", params: { q: "高一" } },
    { label: "连写 q=高一1班", path: "/api/search", params: { q: "高一1班" } },
    { label: "连写 q=高一10班", path: "/api/search", params: { q: "高一10班" } },
    { label: "连写 q=高一一班", path: "/api/search", params: { q: "高一一班" } },
    { label: "年段带班字 q=高一班", path: "/api/search", params: { q: "高一班" } },
    { label: "年段+班级分写 q=高一、一班", path: "/api/search", params: { q: "高一、一班" } },
    { label: "年段+学校 q=高一 school=福清一中", path: "/api/search", params: { q: "高一", school: "福清一中" } },
    { label: "连写+学校 q=高一10班 school=福清一中", path: "/api/search", params: { q: "高一10班", school: "福清一中" } },

    // 校名过滤：只有学校、没有任何条件时必须返回空，而不是整个学校全量
    { label: "仅学校 school=福清一中", path: "/api/search", params: { q: "", school: "福清一中" } },
    { label: "未知学校 school=不存在", path: "/api/search", params: { q: "高一", school: "福州市第一中学" } },

    // 真实数据检索：精确姓名与姓名前缀（前缀会走排序打分）
    { label: "姓名精确 q=陈瑾欣", path: "/api/search", params: { q: "陈瑾欣" } },
    { label: "姓名前缀 q=陈", path: "/api/search", params: { q: "陈" } },

    // 分页边界
    { label: "limit=0", path: "/api/search", params: { q: "高一", limit: "0" } },
    { label: "limit=51", path: "/api/search", params: { q: "高一", limit: "51" } },
    { label: "limit=50", path: "/api/search", params: { q: "高一", limit: "50" } },
    { label: "offset=-1", path: "/api/search", params: { q: "高一", offset: "-1" } },
    { label: "offset=99999", path: "/api/search", params: { q: "高一", offset: "99999" } },

    // 超长查询
    { label: "超长 q（81 字）", path: "/api/search", params: { q: longQuery } },

    // 契约端点与错误路径
    { label: "学校列表 /api/schools", path: "/api/schools" },
    { label: "未知路径 /api/nope", path: "/api/nope" },
    // 裸 /api 是已知差异：Go 的 ServeMux 自动 307 到 /api/，Worker 的路径判定
    // 直接落到兜底 404 且不带 body。入表的目的是把这条口头认知变成差异表里的
    // 一行，删 Go 之前必须由人来决定「要不要跟从 Go 的自动补斜杠」。
    // /api/ 带斜杠的版本两侧一致（都是 404 not_found），一并入表防回归。
    { label: "裸路径 /api", path: "/api" },
    { label: "路径 /api/", path: "/api/" },
    { label: "方法 POST /api/search", method: "POST", path: "/api/search" },
  ];
}

// 解析命令行：只认三个开关。位置参数不在支持范围内，避免「传了端口却落到默认值」
// 这种静默错。未知开关直接报错退出，不猜。
function parseArgs(argv) {
  const args = { goPort: DEFAULT_GO_PORT, workerPort: DEFAULT_WORKER_PORT, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--self-test") {
      args.selfTest = true;
      continue;
    }
    if (key === "--go-port" || key === "--worker-port") {
      const raw = argv[++i];
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`端口不合法：${key} ${raw}`);
      }
      if (key === "--go-port") args.goPort = port;
      else args.workerPort = port;
      continue;
    }
    throw new Error(`未知参数：${key}（可用：--go-port / --worker-port / --self-test）`);
  }
  return args;
}

// baseUrl 固定走 127.0.0.1 而不是 localhost：本机有 http_proxy 环境变量，
// localhost 在部分解析路径上会被代理接管，直连 IP 不必依赖 no_proxy 配置。
function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

// request 打一次请求，把「连不上」与「答了什么」分开表达。
// connected=false 是唯一表示连接失败的方式：调用方据此报「服务未启动」，
// 而不是把 fetch 抛错当成一个 200 空响应去比较。
async function request(port, item) {
  const url = new URL(item.path, baseUrl(port));
  if (item.params) {
    for (const [key, value] of Object.entries(item.params)) {
      url.searchParams.set(key, value);
    }
  }
  let response;
  try {
    response = await fetch(url, {
      method: item.method ?? "GET",
      // 超时用 AbortSignal：fetch 默认没有超时，服务半死时脚本会一直挂着。
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // redirect: "manual" 是刻意的：不跟随重定向，把真实的 3xx 原样拿来比较。
      // 两端的重定向行为本身就是 wire 契约的一部分（实测 Go 对裸路径 /api 答
      // 307 -> /api/，Worker 答 404），跟随之后这条差异会被自动吞掉，
      // 比较器只会看到两个 404。
      redirect: "manual",
    });
  } catch (error) {
    return { connected: false, reason: `${error.name}: ${error.message}` };
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应保持 json=null，比较时退化为原始文本比对。
  }
  return {
    connected: true,
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text,
    json,
  };
}

// describe 把任意值压成一行可读文本，供差异表打印。
// 换行必须压掉：响应体里带 \n（HTML 页面、格式化 JSON）会把一行表格撑成多行，
// 差异表的对齐就此崩掉。压成 " / " 而不是删掉，读者仍能看出这里有换行。
function describe(value) {
  if (value === undefined) return "<缺失>";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = text.replace(/\r?\n/g, " / ");
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

// joinPath 拼接字段路径。根路径为空串时不要带出前导点，否则差异表里会出现 ".total"。
function joinPath(base, key) {
  return base === "" ? key : `${base}.${key}`;
}

// isPlainObject 排除 null 与数组：JSON 里的对象比较只对真正的对象生效。
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// diffValue 递归比较两个 JSON 值，把每一处不同压成 {path, go, worker}。
//
// 用通用递归而不是按 items/total/limit/offset/hasMore 手写五个比较器：手写版本
// 对 wire 契约的新增字段一无所知（比如派生字段 nameKey 泄漏进 items，手写版
// 每个字段都「相等」，整体却已泄漏）。递归版顺带把对象键集合也比了，泄漏会
// 直接以「Worker 多出 items[0].nameKey」的形式出现在表里。
//
// 数组按位置比较，item 顺序不同会逐条报字段差异——排序是行为的一部分，
// 顺序漂移必须可见。长度不等时只比到较短的一侧，剩下由长度差异本身说明。
function diffValue(a, b, path, out) {
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray || bIsArray) {
    if (!(aIsArray && bIsArray)) {
      out.push({ path, go: describe(a), worker: describe(b) });
      return;
    }
    if (a.length !== b.length) {
      out.push({ path: `${path}.length`, go: a.length, worker: b.length });
    }
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i++) {
      diffValue(a[i], b[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!(isPlainObject(a) && isPlainObject(b))) {
      out.push({ path, go: describe(a), worker: describe(b) });
      return;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const childPath = joinPath(path, key);
      if (!(key in a)) {
        out.push({ path: childPath, go: "<缺失>", worker: describe(b[key]) });
        continue;
      }
      if (!(key in b)) {
        out.push({ path: childPath, go: describe(a[key]), worker: "<缺失>" });
        continue;
      }
      diffValue(a[key], b[key], childPath, out);
    }
    return;
  }
  if (a !== b) {
    out.push({ path, go: describe(a), worker: describe(b) });
  }
}

// classify 给一条差异定类别，决定它在总结里算哪一类。三类事实必须分开：
//
//   data-missing  一侧正常出数据（200）、另一侧明确说「数据不可用」
//                 （500 data_unavailable / 503 degraded）。典型场景是 Worker 的
//                 本地 KV 没灌名单——这证明不了行为不等价，只说明环境没准备好。
//   env           一侧被限流（429）。重复跑脚本会撞上，也不是行为差异。
//   behavior      其余情况：两端都答了真实结果却不一样，这才是要抓的。
//
// 「一侧有数据、另一侧没数据」是这条判据的全部内容，不能用「任一侧出现
// data_unavailable」近似：两侧都报错（比如 Go 答 data_unavailable、Worker 答
// internal_error）时，差异的根因在错误处置上，属行为层；把它归进数据缺失
// 会让一条真实缺陷消失在「环境没准备好」的提示里。
//
// 判定依据是「两侧的状态与错误码」，不看业务体：数据缺失时两侧 items 都空，
// 按业务体比较会得到「完全一致」的假绿。
function classify(go, worker) {
  const dataUnavailable = (res) =>
    res.status === 503 || (res.status === 500 && res.json?.error === "data_unavailable");
  const rateLimited = (res) => res.status === 429;
  const healthy = (res) => res.status === 200;
  if ((dataUnavailable(go) && healthy(worker)) || (dataUnavailable(worker) && healthy(go))) {
    return "data-missing";
  }
  if (rateLimited(go) || rateLimited(worker)) return "env";
  return "behavior";
}

// compare 比较一轮对拍的两侧响应，返回差异数组（每条带 kind）。
// 比较面：HTTP 状态、Content-Type、响应体（递归逐字段）。
// Content-Type 也算契约：前端按它决定是否按 JSON 解析。
function compare(go, worker) {
  const diffs = [];
  if (go.status !== worker.status) {
    diffs.push({ path: "status", go: describe(go.status), worker: describe(worker.status) });
  }
  if (go.contentType !== worker.contentType) {
    diffs.push({ path: "content-type", go: describe(go.contentType), worker: describe(worker.contentType) });
  }
  if (go.json !== null && worker.json !== null) {
    diffValue(go.json, worker.json, "", diffs);
  } else if (go.text !== worker.text) {
    // 至少一侧不是 JSON：退化为原始文本比较，并把结果标成 body。
    diffs.push({ path: "body", go: describe(go.text), worker: describe(worker.text) });
  }
  const kind = classify(go, worker);
  return diffs.map((diff) => ({ ...diff, kind }));
}

// isHealthEnvelope 判定一个探针响应是不是本服务的健康体。
// 两端 /api/health 的成功与降级体都带 status 字段（ok / degraded），
// 且都是 JSON。用这两条当指纹，端口填错时（别的 web 服务答 HTML）立刻露馅。
function isHealthEnvelope(res) {
  if (!res.connected) return false;
  if (!res.contentType.includes("application/json")) return false;
  return typeof res.json?.status === "string";
}

// probeVerdict 判定一次探活的结果，是探活路径上唯一的判据 owner。
//
// 抽成纯函数是为了能被 --self-test 直接覆盖：探活的三条分支（连不上、
// 被限流、不是本服务）此前只长在 main 里，自测碰不到，于是 429 那条写错过
// 一次却没有任何用例能发现。
//
// 三条分支必须分开报，因为处置动作完全不同：
//
//   unreachable  连不上 → 服务没起来，去启动它。
//   rate-limited 429 → 服务在跑、但桶已被前几轮打满，等一分钟再跑。
//                 这条**不能**落进「不是本服务」：429 的响应体是
//                 {"error":"rate_limited"}，没有 status 字段，若只靠
//                 isHealthEnvelope 判定就会掉进 fail 分支，把用户引向
//                 「查端口占用」这个完全错误的方向。classify 早已把 429
//                 单独归到 env，探活路径复用同一认知即可。
//   not-service  有响应、不是 429、也不是健康体 → 端口填错或别的服务占着。
//
// 返回 { ok, kind, message }；ok 为 true 时 message 是就绪描述。
function probeVerdict(name, port, probe) {
  if (!probe.connected) {
    return { ok: false, kind: "unreachable", message: `${name} 服务未启动（${baseUrl(port)}，${probe.reason}）` };
  }
  if (probe.status === 429) {
    return {
      ok: false,
      kind: "rate-limited",
      message: `${name} 被限流（60 请求/60 秒），等一分钟再跑（${baseUrl(port)}）`,
    };
  }
  if (!isHealthEnvelope(probe)) {
    return {
      ok: false,
      kind: "not-service",
      message:
        `${name} 端口 ${port} 上不是本服务（/api/health 答的不是 JSON 健康体，` +
        `实际为 ${describe(probe.contentType || probe.text)}）`,
    };
  }
  return {
    ok: true,
    kind: "ready",
    message: `${name} 服务就绪：${baseUrl(port)}（/api/health ${probe.status} ${probe.json?.status}）`,
  };
}

// countByKind 数某一类差异项有多少条。抽出来是因为汇总行与两条提示各用一次，
// 三处各写一遍 reduce 会让「类别键名」散在三个地方。
function countByKind(rows, kind) {
  return rows.filter((row) => row.kind === kind).length;
}

// padRight 按显示宽度补齐（中文按一个字符宽度算即可，差异表只求不挤在一起）。
function padRight(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

// printDiffTable 打印差异表。只输出有差异的查询——一致的行在总结里计数即可，
// 逐条打印「一致」会把这 26 条查询的差异淹掉。
function printDiffTable(rows) {
  const widths = [26, 16, 34, 34, 13];
  const headers = ["查询", "字段", "Go", "Worker", "类别"];
  console.log(headers.map((header, i) => padRight(header, widths[i])).join("| "));
  console.log(widths.map((width) => "-".repeat(width)).join("+-"));
  for (const row of rows) {
    console.log(
      [
        padRight(row.label, widths[0]),
        padRight(row.path, widths[1]),
        padRight(row.go, widths[2]),
        padRight(row.worker, widths[3]),
        padRight(row.kind, widths[4]),
      ].join("| "),
    );
  }
}

// runSelfTest 是不联网的自测：用构造的响应验证比较逻辑与探活判据本身。
//
// 为什么必须有它：对拍脚本的价值全在「差异能被抓出来」，而一段永远返回
// 「一致」的比较器看起来和对拍成功一模一样。下面的用例把每种差异形态、
// 以及探活的三条分支各踩一遍，逻辑退化会立刻在这里失败，而不必依赖两个
// 服务都活着。
function runSelfTest() {
  const ok = (body) => ({
    connected: true,
    status: 200,
    contentType: JSON_CONTENT_TYPE,
    text: JSON.stringify(body),
    json: body,
  });
  const err = (status, code) => ({
    connected: true,
    status,
    contentType: JSON_CONTENT_TYPE,
    text: JSON.stringify({ error: code }),
    json: { error: code },
  });
  const envelope = (items, total, limit, offset, hasMore) => ({ items, total, limit, offset, hasMore });
  const student = (name, cls) => ({ name, school: "福清一中", grade: "高一", class: cls });

  const base = envelope([student("陈瑾欣", "一班")], 1, 10, 0, false);

  let failures = 0;
  const check = (label, fn) => {
    try {
      fn();
      console.log(`自测通过：${label}`);
    } catch (error) {
      failures++;
      console.log(`自测失败：${label} -> ${error.message}`);
    }
  };

  check("完全一致时差异为 0", () => {
    assert.equal(compare(ok(base), ok(structuredClone(base))).length, 0);
  });

  check("total 不同被抓出", () => {
    const diffs = compare(ok(base), ok({ ...base, total: 2 }));
    assert.deepEqual(diffs.map((d) => d.path), ["total"]);
    assert.equal(diffs[0].kind, "behavior");
  });

  check("items 字段差异被抓出（class）", () => {
    const diffs = compare(ok(base), ok({ ...base, items: [student("陈瑾欣", "二班")] }));
    assert.deepEqual(diffs.map((d) => d.path), ["items[0].class"]);
  });

  check("items 顺序漂移被抓出", () => {
    const a = envelope([student("陈瑾欣", "一班"), student("陈昕怡", "一班")], 2, 10, 0, false);
    const b = envelope([student("陈昕怡", "一班"), student("陈瑾欣", "一班")], 2, 10, 0, false);
    const paths = compare(ok(a), ok(b)).map((d) => d.path);
    assert(paths.includes("items[0].name") && paths.includes("items[1].name"));
  });

  check("派生字段泄漏被抓出（多键）", () => {
    const leaked = envelope([{ ...student("陈瑾欣", "一班"), nameKey: "陈瑾欣" }], 1, 10, 0, false);
    const diffs = compare(ok(base), ok(leaked));
    // 泄漏只应报一条：Worker 多出的 items[0].nameKey，Go 侧记为缺失。
    assert.deepEqual(diffs.map((d) => d.path), ["items[0].nameKey"]);
    assert.equal(diffs[0].go, "<缺失>");
    assert.equal(diffs[0].worker, "陈瑾欣");
  });

  check("错误码不同被抓出", () => {
    const diffs = compare(err(400, "invalid_limit"), err(400, "invalid_offset"));
    assert.deepEqual(diffs.map((d) => d.path), ["error"]);
    assert.equal(diffs[0].kind, "behavior");
  });

  check("状态不同被抓出", () => {
    const diffs = compare(err(400, "invalid_limit"), err(429, "rate_limited"));
    assert(diffs.some((d) => d.path === "status"));
    assert.equal(diffs[0].kind, "env");
  });

  check("数据缺失型差异被单独归类", () => {
    const goSide = ok(base);
    const workerSide = err(500, "data_unavailable");
    const diffs = compare(goSide, workerSide);
    assert(diffs.length > 0);
    assert(diffs.every((d) => d.kind === "data-missing"));
  });

  check("两侧都降级时不算数据缺失（如实报行为差异）", () => {
    // 空 KV 场景的另一半：真实行为差异即便发生在降级状态上，也不该被
    // data-missing 吞掉。两侧同为 500 data_unavailable 时，差异（如果有）
    // 属于行为层——这里用同一状态 + 不同错误码构造。
    const diffs = compare(err(500, "data_unavailable"), err(500, "internal_error"));
    assert.equal(diffs[0].kind, "behavior");
  });

  // 以下三条守探活判据（probeVerdict）。这是修复轮 1 补的回归：
  // 探活分支此前只长在 main 里，自测碰不到，429 那条因此写错过——
  // 429 响应体是 {"error":"rate_limited"}，没有 status 字段，
  // 只靠 isHealthEnvelope 会把它当成「端口上不是本服务」，
  // 把用户引向查端口占用这个完全错误的方向。

  check("探活：429 识别为被限流，不是「不是本服务」", () => {
    const verdict = probeVerdict("Worker", 8787, err(429, "rate_limited"));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.kind, "rate-limited");
    // 文案必须提限流与等待，不得出现「不是本服务」这种误导性措辞。
    assert(verdict.message.includes("限流"));
    assert(!verdict.message.includes("不是本服务"));
  });

  check("探活：答 HTML 的端口判为「不是本服务」", () => {
    const verdict = probeVerdict("Worker", 9999, {
      connected: true,
      status: 200,
      contentType: "text/html",
      text: "<!doctype html>",
      json: null,
    });
    assert.equal(verdict.kind, "not-service");
    assert(verdict.message.includes("不是本服务"));
  });

  check("探活：降级体 503 仍算就绪（数据缺失不该中止对拍）", () => {
    const degraded = {
      connected: true,
      status: 503,
      contentType: JSON_CONTENT_TYPE,
      text: JSON.stringify({ status: "degraded", reason: "data" }),
      json: { status: "degraded", reason: "data" },
    };
    const verdict = probeVerdict("Worker", 8787, degraded);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.kind, "ready");
  });

  if (failures > 0) {
    console.log(`自测失败 ${failures} 项`);
    process.exit(1);
  }
  console.log("自测全部通过");
}

// main 是正常对拍流程：先确认两侧都活着，再逐条比较。
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const cases = buildCases();
  const sides = [
    { name: "Go", port: args.goPort },
    { name: "Worker", port: args.workerPort },
  ];

  // 连通性探针：判据唯一 owner 是 probeVerdict（三条分支见其注释）。
  // 这里只负责打印与收集失败。
  const down = [];
  for (const side of sides) {
    const probe = await request(side.port, { path: "/api/health" });
    const verdict = probeVerdict(side.name, side.port, probe);
    if (verdict.ok) {
      console.log(verdict.message);
    } else {
      down.push(verdict);
    }
  }
  if (down.length > 0) {
    for (const verdict of down) console.log(verdict.message);
    // 限流是「等一等就好」，不是「去启动服务」，提示必须分开写。
    const hint = down.every((verdict) => verdict.kind === "rate-limited")
      ? "对拍中止：一侧被限流，等一分钟再跑。"
      : "对拍中止：两侧都必须在跑（Go：go run .；Worker：npx wrangler dev --port 8787）";
    console.log(hint);
    process.exit(2);
  }

  const rows = [];
  let identical = 0;
  let connectionLost = false;

  for (const item of cases) {
    const goResult = await request(args.goPort, item);
    const workerResult = await request(args.workerPort, item);
    if (!goResult.connected || !workerResult.connected) {
      // 中途掉线：报出来并归到「服务未启动」，绝不静默跳过。
      const which = !goResult.connected ? "Go" : "Worker";
      console.log(`${which} 服务未启动（查询「${item.label}」途中连接失败）`);
      connectionLost = true;
      break;
    }
    const diffs = compare(goResult, workerResult);
    if (diffs.length === 0) {
      identical++;
      continue;
    }
    for (const diff of diffs) {
      rows.push({
        label: item.label,
        path: diff.path,
        go: diff.go,
        worker: diff.worker,
        kind: diff.kind,
      });
    }
  }

  // 差异表必须先打印，再判断掉线。脚本的全部产出就是这张表：若把它排在
  // process.exit(2) 之后，中途掉线会把前面已经抓到的真实差异整段丢掉，
  // 只剩一句「服务未启动」——用环境问题覆盖已发现的证据，是把验证做废。
  // 退出码仍是 2（环境问题成立），但证据先落地。
  console.log("");
  const diffQueries = new Set(rows.map((row) => row.label)).size;
  if (rows.length > 0) {
    // 量纲分开写：差异查询数 与 差异项数 不是同一个数（一条查询可出多个字段差异），
    // 并排打印会得到「20 ≠ 0+136+0」的算术外观。
    console.log(
      `差异表：有差异查询 ${diffQueries} 条 / 差异项 ${rows.length} 项` +
        `（行为 ${countByKind(rows, "behavior")} / 数据缺失 ${countByKind(rows, "data-missing")} / 环境 ${countByKind(rows, "env")}）`,
    );
    printDiffTable(rows);
    console.log("");
  }

  if (connectionLost) {
    console.log("对拍中止：一侧服务在中途掉线，上表为掉线前已捕获的差异。");
    process.exit(2);
  }

  console.log(
    `对拍 ${cases.length} 条查询：一致 ${identical} 条，有差异查询 ${diffQueries} 条 / 差异项 ${rows.length} 项`,
  );

  if (countByKind(rows, "data-missing") > 0) {
    console.log(
      "提示：数据缺失型差异说明有一侧拿不到名单。Worker 侧本地 KV 需先灌数据" +
        "（wrangler kv key put --binding ROSTER --local --persist-to .wrangler/state），" +
        "灌完再对拍，这条差异才会消失。",
    );
  }
  if (countByKind(rows, "env") > 0) {
    console.log("提示：环境型差异说明撞到限流（60 请求/60 秒），等一分钟后再跑。");
  }

  process.exit(rows.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.log(`对拍脚本异常：${error.message}`);
  process.exit(2);
});
