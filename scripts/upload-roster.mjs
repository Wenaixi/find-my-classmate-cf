#!/usr/bin/env node
// 名单上传脚本：把本地数据目录里的每份 roster 文件拆成「单校文档」，逐校上传到管理 API。
//
// 用法：
//   node scripts/upload-roster.mjs <endpoint> <token> [dir]
//   node scripts/upload-roster.mjs --self-test        # 只跑纯逻辑自测，不联网
//
// 例：
//   node scripts/upload-roster.mjs http://127.0.0.1:8787 dev-token data
//
// 为什么必须按校拆分：
//   迁移后的存储是「一校一个键」——src/worker/rosterStore.ts 的 roster:{校名}，
//   一次 PUT 只写一所学校。而上游 build_hierarchy_json.py 的输出允许一份文件里
//   放多所学校（顶层 学校 是数组）。整份原样上传会让服务端把「多校文档」当成
//   「URL 里点名那所学校的名单」：目标校的键里塞进别的学校的学生，搜索命中与
//   学校下拉都会串数据，且没有任何报错——静默错数据比拒收更糟。
//   所以这里对每个文件遍历 学校 数组，逐校构造 { 区县, 学校: [该学校对象] }
//   再上传。拆分只涉及数组过滤与重新序列化，没有取舍空间。
//
// 退出码：
//   0  全部学校上传成功
//   1  存在失败项（文件读不了 / JSON 坏了 / 400 / 5xx / 网络不通 / 401）
//   2  用法或环境问题（参数缺失、endpoint 非法、目录不存在、目录里没有名单文件）
//
// 401 一律中止整轮：token 不对时后面每一所都会 401，继续打只是把一个认证配置
// 错误淹没在一屏重复失败里。

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// 命中的文件名后缀。与上游导出脚本的产物命名一致（校名_人数_roster.json）。
const ROSTER_FILE_SUFFIX = "_roster.json";

// 单请求超时。管理端的高频路径是 KV 写，正常几十毫秒；10 秒足够覆盖冷启动与
// 一次 KV 写扩散的等待，同时避免网络不通时整轮挂死。
const REQUEST_TIMEOUT_MS = 10_000;

// 失败时回显响应体的截断长度：够看出错误码与文案，又不至于把 HTML 错误页整屏倒出来。
const BODY_PREVIEW_MAX = 300;

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

// normalizeEndpoint 把用户给的 endpoint 归一到「无尾斜杠」形态，并拒绝非 http(s)。
//
// 尾斜杠必须去掉：拼 URL 时模板是 `${endpoint}/api/admin/roster/...`，留着尾斜杠
// 会拼出双斜杠 `//api/...`。多数服务容忍它，但路径规范化的行为属于平台细节，
// 不该让运维的输入习惯决定请求长什么样。
//
// 协议白名单是为了早失败：漏写 http:// 的 `127.0.0.1:8787` 会被 fetch 当成
// 非法 URL 抛出，错误文本埋在第一次请求里，不如在这里就说清楚。
function normalizeEndpoint(raw) {
  const value = String(raw ?? "").trim();
  if (value === "") throw new Error("endpoint 不能为空");
  if (!/^https?:\/\//i.test(value)) throw new Error(`endpoint 必须以 http:// 或 https:// 开头（收到：${value}）`);
  const trimmed = value.replace(/\/+$/, "");
  // 只留下根斜杠的输入（"http://h/"）会被压成 "http://h"，仍是合法 endpoint。
  return trimmed;
}

// buildRosterUrl 拼出单校上传的 URL。校名必须整体走 encodeURIComponent：
// 校名是自由文本（含中文、空格，理论上也可能含 / ? # &），其中 / 会直接切开
// 路径、? 与 # 会截断或改写 URL，& 会污染查询串。服务端用 decodeURIComponent
// 还原路径段（src/worker/admin.ts 的 decodeSchool），两端因此严格互逆。
function buildRosterUrl(endpoint, schoolName) {
  return `${endpoint}/api/admin/roster/${encodeURIComponent(schoolName)}`;
}

// extractSchoolDocuments 把一份 roster 文档拆成若干单校子文档。
//
// 返回 [{ schoolName, payload }]：schoolName 用于拼 URL 与打印，payload 是
// 已序列化好的子文档字符串（{ 区县: 原文档.区县, 学校: [该学校对象] }）。
//
// 顶层先做形态检查再拆分：这份文件不是 roster 时，报错必须点名文件与原因，
// 否则运维只会看到「上传了 0 所学校」这种无信息量的结果。检查口径与
// src/shared/roster.ts 的阶段一同源（顶层是对象、学校 是数组），但这里只做
// 「能不能拆」的最小判定——内容合法性（年级/班级/姓名、重复校名）是服务端
// 校验层的职责，脚本复刻一遍只会得到第二份会漂移的规则。
function extractSchoolDocuments(document, sourceLabel) {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${sourceLabel} 顶层不是对象，不是 roster 格式`);
  }
  const schools = document.学校;
  if (!Array.isArray(schools)) {
    throw new Error(`${sourceLabel} 缺少 学校 数组，不是 roster 格式`);
  }
  if (schools.length === 0) {
    throw new Error(`${sourceLabel} 的 学校 是空数组，没有可上传的内容`);
  }

  // 区县原样带走：它是文档级字段而不是校级字段，拆出去的子文档必须保留它，
  // 否则上传后的原文与本地文件不同形（运维对照 KV 内容时会对不上）。
  const region = document.区县;
  const documents = [];
  for (const [index, school] of schools.entries()) {
    const name = school !== null && typeof school === "object" && !Array.isArray(school) ? school.校名 : undefined;
    if (typeof name !== "string" || name === "") {
      throw new Error(`${sourceLabel} 第 ${index + 1} 个学校缺少 校名（无法确定上传到哪一所）`);
    }
    documents.push({
      schoolName: name,
      payload: JSON.stringify({ 区县: region, 学校: [school] }),
    });
  }
  return documents;
}

// classifyResponse 把一次 PUT 的响应归成三类结论，是「成功与否」判定的唯一 owner。
//
//   201  → created：成功，尽量取回服务端回显的 students 数（取不到就记 null，
//          不猜、不拿本地算出来的条数冒充服务端数字）。
//   401  → unauthorized：认证失败。调用点据此中止整轮。
//   400  → invalid：请求本身可修（校名不能用 / 名单内容不合法），message 是
//          服务端校验层的逐字文案（带来源名/校名/年级名），原样打印——
//          搬运文案而不是改写，才能保证运维看到的定位信息与上传时一致。
//   其余 → other：5xx、404（endpoint 指错服务）、429 等都归这里，带状态码原样回显。
function classifyResponse(status, text) {
  // 响应体不保证是 JSON（代理错误页、网关 502 都是 HTML）。解析失败不当成失败
  // 结论的一部分，只让 detail 退回到原文，避免一次 JSON 异常把「400 的文案」
  // 变成「脚本自己崩了」。
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (status === 201) {
    const students = typeof body?.students === "number" ? body.students : null;
    return { ok: true, kind: "created", students, school: typeof body?.school === "string" ? body.school : null };
  }
  if (status === 401) {
    return { ok: false, kind: "unauthorized", detail: "认证失败（401）：token 不对，或服务端没配置 ADMIN_TOKEN" };
  }
  if (status === 400) {
    const code = typeof body?.error === "string" ? body.error : "400";
    const message = typeof body?.message === "string" ? body.message : bodyPreview(text);
    return { ok: false, kind: "invalid", detail: `${code}：${message}` };
  }
  return { ok: false, kind: "other", detail: `${status}：${bodyPreview(text)}` };
}

// bodyPreview 截断响应体用于回显。空体给一句人话而不是空字符串：空体在排障时
// 是最难判断的形态（看不出是服务拒了还是链路断了）。
function bodyPreview(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return "（响应体为空）";
  return value.length > BODY_PREVIEW_MAX ? `${value.slice(0, BODY_PREVIEW_MAX)}...（已截断）` : value;
}

// exitCodeFor 由汇总计数决定退出码：只要有一项没成功就非 0，绝不把「部分成功」
// 当成成功——漏一所学校的名单，搜索就会静默缺人。
function exitCodeFor(summary) {
  return summary.failures === 0 && summary.aborted === false ? EXIT_OK : EXIT_FAILED;
}

// parseArgs 解析命令行。三个位置参数按顺序取，第三个可选，默认 data。
function parseArgs(argv) {
  if (argv.includes("--self-test")) return { selfTest: true };
  const unknown = argv.filter((item) => item.startsWith("--"));
  if (unknown.length > 0) throw new Error(`未知参数：${unknown.join(" ")}（可用：--self-test）`);
  const [endpoint, token, dir] = argv;
  if (endpoint === undefined || token === undefined) {
    throw new Error("缺参数。用法：node scripts/upload-roster.mjs <endpoint> <token> [dir]");
  }
  if (token.trim() === "") throw new Error("token 不能为空");
  return { selfTest: false, endpoint: normalizeEndpoint(endpoint), token, dir: dir ?? "data" };
}

// BOM 剥离：Windows 编辑器另存过的名单常带 UTF-8 BOM，JSON.parse 会把它当非法
// 字符报错。服务端加载侧同样剥（src/shared/roster.ts），脚本这一侧不剥就会在
// 「服务端明明能加载的文件」上报一条解析失败。
function stripBom(text) {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

// listRosterFiles 列出待上传的文件名（只留后缀匹配的），并按名字排序。
// 排序是为了让每轮输出顺序一致：同一批文件重复跑时，日志能逐行对照。
async function listRosterFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(ROSTER_FILE_SUFFIX))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

// uploadOne 发一次 PUT 并归类。网络层失败（连不上、超时、DNS）同样收敛成一个
// 结论对象，让调用点只有一条分支要看——但它与 HTTP 失败分开标记（kind 为
// network），因为「服务没起来」与「服务拒了这份名单」的处置完全不同。
async function uploadOne(endpoint, token, schoolName, payload) {
  const url = buildRosterUrl(endpoint, schoolName);
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    return { ...classifyResponse(response.status, text), url };
  } catch (error) {
    // fetch 的网络失败只有一句 "fetch failed"，真因（ECONNREFUSED、ENOTFOUND、
    // 超时）藏在 cause 里。不取 cause 的话「端口没开」与「代理把请求吞了」
    // 在日志上长得一模一样。
    const reason = describeFetchError(error);
    return { ok: false, kind: "network", detail: `请求失败：${reason}`, url };
  }
}

// describeFetchError 把 Undici 的错误链压成一行，逐层追 cause 最多三层。
// cause 可能被代理再包一层（fetch failed → 代理错误 → TCP 错误），只取最外层
// 拿不到 ECONNREFUSED 这类可操作的码。
function describeFetchError(error, depth = 0) {
  if (!(error instanceof Error)) return String(error);
  const head = `${error.name}: ${error.message}`;
  if (depth >= 3) return head;
  const cause = error.cause;
  if (cause === undefined) return head;
  const inner = describeFetchError(cause, depth + 1);
  return `${head}（原因 ${inner}）`;
}

// printResult 打印单校结果。成功带服务端回显的条数，失败带分类文案；
// 两种都带来源文件，运维据此知道该去改哪个文件。
function printResult(schoolName, sourceFile, verdict) {
  if (verdict.ok) {
    const count = verdict.students === null ? "条数未回显" : `${verdict.students} 名学生`;
    console.log(`[成功] ${schoolName}（来源 ${sourceFile}）：201 已写入 ${count}`);
    return;
  }
  console.log(`[失败] ${schoolName}（来源 ${sourceFile}）：${verdict.detail}`);
}

// run 是整轮上传的主体：逐文件读、拆、逐校上传，401 与网络故障时中止。
async function run(args) {
  const summary = { schools: 0, successes: 0, failures: 0, files: 0, aborted: false, remaining: 0 };

  let files;
  try {
    files = await listRosterFiles(args.dir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`读取目录失败（${args.dir}）：${reason}`);
    return { ...summary, usageError: true };
  }
  if (files.length === 0) {
    console.log(`目录 ${args.dir} 里没有 ${ROSTER_FILE_SUFFIX} 文件（后缀必须匹配，例如 福清一中_173_roster.json）`);
    return { ...summary, usageError: true };
  }

  console.log(`endpoint：${args.endpoint}；来源目录：${args.dir}；待上传文件：${files.length} 个`);

  for (const fileName of files) {
    summary.files += 1;
    const filePath = path.join(args.dir, fileName);

    let documents;
    try {
      const text = stripBom(await readFile(filePath, "utf8"));
      documents = extractSchoolDocuments(JSON.parse(text), fileName);
    } catch (error) {
      // 文件级失败：整份跳过。它与「某一所学校被服务端拒收」是两件事，
      // 前者改文件、后者改内容，日志里必须能分开。
      summary.failures += 1;
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`[失败] ${fileName}：无法拆分为单校文档（${reason}）`);
      continue;
    }

    for (const [index, document] of documents.entries()) {
      summary.schools += 1;
      const verdict = await uploadOne(args.endpoint, args.token, document.schoolName, document.payload);
      if (verdict.ok) {
        summary.successes += 1;
      } else {
        summary.failures += 1;
      }
      printResult(document.schoolName, fileName, verdict);

      // 认证失败或链路不通时中止：继续打下去每一所都会撞同一堵墙，
      // 而一屏重复失败会掩盖真正的根因（token 配错 / 服务没起来）。
      // 剩余数量按「本文件里还没发的 + 之后还没读的文件」报上界：后面的文件
      // 还没解析，学校数未知，报文件数才诚实。
      if (verdict.kind === "unauthorized" || verdict.kind === "network") {
        summary.aborted = true;
        const reason = verdict.kind === "unauthorized" ? "认证失败，整轮中止" : "请求无法到达服务，整轮中止";
        const sameFile = documents.length - index - 1;
        const laterFiles = files.length - files.indexOf(fileName) - 1;
        console.log(`${reason}（本文件还有 ${sameFile} 所未传，另有 ${laterFiles} 个文件整份未处理）`);
        summary.remaining = sameFile + laterFiles;
        return summary;
      }
    }
  }

  return summary;
}

// runSelfTest 覆盖全部纯逻辑：拆分、URL 编码、响应归类、退出码、参数与文件形态。
// 不联网、不用真实 data/，因此能在任何机器上跑（包括 CI）。
function runSelfTest() {
  const roster = (region, schools) => JSON.stringify({ 区县: region, 学校: schools });
  let failures = 0;
  const check = (label, fn) => {
    try {
      fn();
      console.log(`自测通过：${label}`);
    } catch (error) {
      failures += 1;
      console.log(`自测失败：${label} -> ${error.message}`);
    }
  };

  const schoolA = { 校名: "福清一中", 年级: [{ 年级名: "高一", 班级: [{ 班名: "一班", 学生: [{ 姓名: "陈瑾欣" }] }] }] };
  const schoolB = { 校名: "福清二中", 年级: [{ 年级名: "高一", 班级: [{ 班名: "二班", 学生: [{ 姓名: "林安宁" }] }] }] };

  check("单校文件拆出 1 份子文档", () => {
    const docs = extractSchoolDocuments(JSON.parse(roster("福清市", [schoolA])), "single.json");
    assert.equal(docs.length, 1);
    assert.equal(docs[0].schoolName, "福清一中");
    assert.deepEqual(JSON.parse(docs[0].payload), { 区县: "福清市", 学校: [schoolA] });
  });

  check("多校文件拆出 N 份，每份只含自己那一所", () => {
    const docs = extractSchoolDocuments(JSON.parse(roster("福清市", [schoolA, schoolB])), "multi.json");
    assert.equal(docs.length, 2);
    const second = JSON.parse(docs[1].payload);
    assert.equal(second.学校.length, 1);
    assert.equal(second.学校[0].校名, "福清二中");
    assert.equal(second.区县, "福清市");
    // 串校是最严重的静默错误：子文档里绝不能出现别的学校。
    assert(!docs[1].payload.includes("福清一中"));
  });

  check("缺 区县 时子文档仍然合法（区县键缺省，不影响上传）", () => {
    const docs = extractSchoolDocuments(JSON.parse(roster(undefined, [schoolA])), "no-region.json");
    const parsed = JSON.parse(docs[0].payload);
    assert.equal(parsed.学校.length, 1);
    assert.equal(parsed.学校[0].校名, "福清一中");
  });

  check("校名含 / 时被编码成单个路径段", () => {
    const name = "福清一中/分校";
    const url = new URL(buildRosterUrl("http://127.0.0.1:8787", name));
    const segments = url.pathname.split("/");
    // ["", "api", "admin", "roster", "<一个编码后的段>"]
    assert.equal(segments.length, 5, `路径段数不对：${url.pathname}`);
    assert.equal(decodeURIComponent(segments[4]), name);
    assert(url.pathname.includes("%2F"));
  });

  check("校名含空格、#、?、& 时不破坏 URL 结构", () => {
    const name = "福清 华侨#中学?x=1&y=2";
    const url = new URL(buildRosterUrl("http://127.0.0.1:8787", name));
    assert.equal(url.search, "", `查询串被污染：${url.search}`);
    assert.equal(url.hash, "", `片段被截出：${url.hash}`);
    const last = url.pathname.split("/")[4];
    assert.equal(decodeURIComponent(last), name);
  });

  check("201 归类为成功并取回 students 数", () => {
    const verdict = classifyResponse(201, JSON.stringify({ school: "福清一中", students: 173 }));
    assert.equal(verdict.ok, true);
    assert.equal(verdict.students, 173);
  });

  check("201 但未回显 students 时记为 null，不猜数字", () => {
    const verdict = classifyResponse(201, "{}");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.students, null);
  });

  check("400 归类为失败并原样带 message", () => {
    const message = "解析 福清一中 失败: json: cannot unmarshal string into Go value of type array（字段 RosterDocument.学校）";
    const verdict = classifyResponse(400, JSON.stringify({ error: "invalid_roster", message }));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.kind, "invalid");
    assert(verdict.detail.includes(message));
  });

  check("401 归类为认证失败并点名 token", () => {
    const verdict = classifyResponse(401, JSON.stringify({ error: "unauthorized" }));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.kind, "unauthorized");
    assert(verdict.detail.includes("token 不对"));
  });

  check("5xx 与 404 归到 other 并带状态码", () => {
    const verdict = classifyResponse(502, "<html>bad gateway</html>");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.kind, "other");
    assert(verdict.detail.startsWith("502"));
    assert(verdict.detail.includes("bad gateway"));
  });

  check("空响应体被点名，而不是留一个空白", () => {
    assert(classifyResponse(500, "").detail.includes("响应体为空"));
  });

  check("退出码：全成功为 0，有失败项为 1，中止为 1", () => {
    assert.equal(exitCodeFor({ failures: 0, aborted: false }), EXIT_OK);
    assert.equal(exitCodeFor({ failures: 1, aborted: false }), EXIT_FAILED);
    assert.equal(exitCodeFor({ failures: 0, aborted: true }), EXIT_FAILED);
  });

  check("非法文件形态逐条拒绝", () => {
    assert.throws(() => extractSchoolDocuments([], "x.json"), /顶层不是对象/);
    assert.throws(() => extractSchoolDocuments(null, "x.json"), /顶层不是对象/);
    assert.throws(() => extractSchoolDocuments({}, "x.json"), /缺少 学校 数组/);
    assert.throws(() => extractSchoolDocuments({ 学校: [] }, "x.json"), /空数组/);
    assert.throws(() => extractSchoolDocuments({ 学校: [{ 年级: [] }] }, "x.json"), /缺少 校名/);
    assert.throws(() => extractSchoolDocuments({ 学校: [{ 校名: "" }] }, "x.json"), /缺少 校名/);
  });

  check("endpoint 归一：去尾斜杠、拒绝非 http(s)", () => {
    assert.equal(normalizeEndpoint("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
    assert.equal(normalizeEndpoint("  https://x.example//  "), "https://x.example");
    assert.throws(() => normalizeEndpoint(""), /不能为空/);
    assert.throws(() => normalizeEndpoint("127.0.0.1:8787"), /http/);
  });

  check("参数解析：缺参、空 token、未知选项都拒绝", () => {
    assert.throws(() => parseArgs([]), /缺参数/);
    assert.throws(() => parseArgs(["http://127.0.0.1:8787"]), /缺参数/);
    assert.throws(() => parseArgs(["http://127.0.0.1:8787", "  "]), /token 不能为空/);
    assert.throws(() => parseArgs(["http://127.0.0.1:8787", "t", "data", "--nope"]), /未知参数/);
    const args = parseArgs(["http://127.0.0.1:8787", "t"]);
    assert.equal(args.dir, "data");
  });

  check("BOM 剥离后仍可解析", () => {
    assert.equal(stripBom("\uFEFF{}"), "{}");
    assert.equal(stripBom("{}"), "{}");
  });

  if (failures > 0) {
    throw new Error(`${failures} 条自测失败`);
  }
  console.log("自测全部通过");
}

// main 是进程入口：自测只跑纯逻辑，正常模式跑整轮上传，最后统一翻译成退出码。
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    return EXIT_USAGE;
  }
  if (args.selfTest) {
    try {
      runSelfTest();
      return EXIT_OK;
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      return EXIT_FAILED;
    }
  }

  const summary = await run(args);
  if (summary.usageError) return EXIT_USAGE;

  // 「成功 + 失败」不等于「总学校数」只在中止时成立——中止后剩下的学校从未尝试，
  // 单列出来而不是混进失败数，否则一条 token 错误会看起来像「几十所学校内容都不合法」。
  const unattempted = summary.aborted ? `（未尝试 ${summary.remaining} 项：本文件剩余学校 + 后续未处理文件）` : "";
  console.log(
    `汇总：文件 ${summary.files} 个，已上传学校 ${summary.schools} 所；成功 ${summary.successes}，失败 ${summary.failures}${unattempted}`,
  );
  return exitCodeFor(summary);
}

process.exitCode = await main();
