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
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
//
// 校名含孤立代理项（如 "\uD800"，露骨的 U+FFFD 替换字符或某些导出工具的坏数据）
// 时 encodeURIComponent 抛 URIError: URI malformed。这个抛错存在，调用点就必须
// 自己兜住——见 uploadOne：拼接在 try 内，URIError 与网络失败同路收敛成结论对象，
// 否则它会绕过 classifyResponse 与汇总契约，让整轮崩掉且一行汇总都不打印。
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
// 「能不能拆」的最小判定——内容合法性（年级/班级/姓名）是服务端校验层的职责，
// 脚本复刻一遍只会得到第二份会漂移的规则。
//
// 重名校不在这里判：它要跨文件看（同一校名可能出现在两个不同文件名里），
// 单一文件的视野不够。那条判定归 run 里的 checkSchoolNameConflict。
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
//
// 符号链接要单独判：`entry.isFile()` 对 symlink 恒为 false（readdir 报的是
// 链接自身而不是目标），于是「运维用 symlink 把名单挂进 data/」会被报成
// 「没有 roster 文件」并 exit 2。跟着链接 stat 一次，按目标的真实类型判定。
//
// 断链与目录目标的 symlink 不能静默过滤，返回 { skipped } 让调用点报出来：
//
//   - 只剩一个坏链接时，静默过滤仍会得到「目录里没有 roster 文件」+ exit 2，
//     这条还算可见；
//   - 但它混在正常文件里时，静默过滤就是「少传一整校」而 exit 0 ——
//     与「全部成功」 indistinguishable，正好是本仓最忌的静默错数据。
//
// 所以这里只负责「发现」，处置（打印 + 计入 failures）归调用点。
// 返回的文件名与跳过项都带原因，调用点不需要再 stat 一次。
async function listRosterFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.name.endsWith(ROSTER_FILE_SUFFIX));

  const files = [];
  const skipped = [];
  for (const entry of candidates) {
    if (entry.isFile()) {
      files.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) {
      // 既不是普通文件也不是链接（目录、设备等）：同样不能静默吞掉，
      // 否则「把名单目录挂成子目录」会表现为「少传一所」。
      skipped.push({ name: entry.name, reason: "不是普通文件（目录或其他类型）" });
      continue;
    }
    try {
      const target = await stat(path.join(dir, entry.name));
      if (target.isFile()) {
        files.push(entry.name);
        continue;
      }
      skipped.push({ name: entry.name, reason: `符号链接指向的不是普通文件` });
    } catch (error) {
      const detail = error instanceof Error && error.code ? `${error.code}` : "读不到目标";
      skipped.push({ name: entry.name, reason: `符号链接已断（${detail}）` });
    }
  }
  return { files: files.sort((a, b) => a.localeCompare(b, "zh-Hans-CN")), skipped };
}

// uploadOne 发一次 PUT 并归类。
//
// 网络层失败（连不上、超时、DNS）同样收敛成一个结论对象，让调用点只有一条分支
// 要看——但它与 HTTP 失败分开标记（kind 为 network），因为「服务没起来」与
// 「服务拒了这份名单」的处置完全不同。
//
// URL 拼接必须在 try 内：encodeURIComponent 对含孤立代理项的校名抛 URIError，
// 这个异常若逃出去就绕过了 classifyResponse 与汇总契约——整轮崩掉、后续一次
// PUT 都不发、连汇总行都不会打印。移进 try 后它落进下面的 catch，被收敛成一条
// 逐校失败（kind 为 invalid-name），其余学校照常上传。
async function uploadOne(endpoint, token, schoolName, payload) {
  try {
    const url = buildRosterUrl(endpoint, schoolName);
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
    // 校名无法编码是这一所学校的请求问题，不是链路问题：它不该中止整轮，
    // 也不该被说成「请求无法到达服务」。单独成类，逐校继续。
    if (error instanceof URIError) {
      return {
        ok: false,
        kind: "invalid-name",
        detail: `校名无法编码进 URL（${error.name}: ${error.message}）；该名含孤立代理项或不完整字符，请修正源文件`,
        url: null,
      };
    }
    // fetch 的网络失败只有一句 "fetch failed"，真因（ECONNREFUSED、ENOTFOUND、
    // 超时）藏在 cause 里。不取 cause 的话「端口没开」与「代理把请求吞了」
    // 在日志上长得一模一样。
    const reason = describeFetchError(error);
    return { ok: false, kind: "network", detail: `请求失败：${reason}`, url: null };
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

// fingerprint 是内容比对用的短哈希。用它而不是比全文：名单动辄几百 KB，
// 逐字比较要留两份全文在内存里；而这里只需要回答「两次出现是不是同一份内容」。
//
// 用 node:crypto 的 sha256 而不是手写摘要：摘要算法不该自己发明。截到 64 位
// （16 位十六进制）是够用的：它只用来区分同一目录里人工导出的几份名单，
// 不是抗碰撞的完整性校验。真要一个刻意的伪碰撞输入，后果也只是「不同内容被
// 当成幂等重传」——而这两份文件本身仍然各自合法，服务端行为与现在一致。
const FINGERPRINT_LENGTH = 16;

function fingerprint(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, FINGERPRINT_LENGTH);
}

// checkSchoolNameConflict 判定「这次要上传的学校」是不是与之前某一份重名。
//
// 为什么必须拦：真实目录里的文件名是 校名_人数_roster.json，同一所学校不同人数
// 会得到两个不同的文件名，两个都匹配 *_roster.json、都会被上传。服务端 putRoster
// 是覆盖语义，两次都 201 —— 后一份静默覆盖前一份，而脚本打印全绿、exit 0。
// 运维看到「全部成功」，KV 里却是被覆盖后的某一版：少了一整校或存的是旧名单，
// 且没有任何信号。这条路径是「全绿但数据错」，比报错更难发现。
//
// 三种结论：
//   null     从未见过这个名字 → 正常上传。
//   "same"   重名且内容逐字节相同 → 幂等重传，照常上传，不改变任何状态。
//   "differ" 重名但内容不同 → 后一份会覆盖前一份，必须报错并计入 failures。
//
// 用内容指纹而不是「谁说重复」的计数：同一份文件重跑一遍是幂等（"same"），
// 而改了内容再跑（"differ"）会变成可见的失败，两者因此不会互相冒充。
//
// seen 由调用点持有，形状是 Map<校名, { file, fingerprint }>；本函数只读它、
// 不改它——写入发生在调用点判定之后，避免「判定失败却已登记」的残留。
function checkSchoolNameConflict(seen, schoolName, payload) {
  const previous = seen.get(schoolName);
  if (previous === undefined) return null;
  return fingerprint(payload) === previous.fingerprint ? "same" : "differ";
}

// printConflict 打印重名冲突。措辞要能让运维一眼看出「后一份会覆盖前一份、
// 所以本次没传」，而不是「重复上传所以跳过」——后者会让人以为没传。
//
// 两只指纹都打出来：运维据此把两份文件拿去对比，判断该留哪一份。
// 当前内容作为入参传入而不是让函数自己从 previous 里取，保证打印的指纹与
// 判定用的指纹同源。
function printConflict(schoolName, currentFile, currentPayload, previous) {
  console.log(
    `[冲突] ${schoolName}：已在 ${previous.file} 上传过（指纹 ${previous.fingerprint}），` +
      `本次来自 ${currentFile}（指纹 ${fingerprint(currentPayload)}）内容不同——` +
      `服务端是覆盖语义，后一份会覆盖前一份，本次未上传；请确认哪一份是最终版`,
  );
}

// run 是整轮上传的主体：逐文件读、拆、逐校上传，401 与网络故障时中止。
async function run(args) {
  const summary = { schools: 0, successes: 0, failures: 0, files: 0, aborted: false, remaining: 0 };

  // 校名 → 已上传的 { file, fingerprint }。整轮共享，用来识别跨文件重名。
  const seen = new Map();

  let listed;
  try {
    listed = await listRosterFiles(args.dir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`读取目录失败（${args.dir}）：${reason}`);
    return { ...summary, usageError: true };
  }
  const { files, skipped } = listed;

  // 被跳过的 symlink / 非常规文件先报出来，再决定是继续还是退出。
  // 它们计入 failures：混在正常文件里时，静默少传一份会得到 exit 0，
  // 与「全部成功」 indistinguishable —— 那正是这条路径最危险的地方。
  for (const entry of skipped) {
    summary.failures += 1;
    console.log(`[失败] ${entry.name}：${entry.reason}，未上传`);
  }

  if (files.length === 0) {
    // 有跳过项时不能说「没有 roster 文件」：文件确实在，只是用不了，
    // 原因已经逐条打印在上面。这时退出码仍是 1（有失败项），不是 2（用法错）——
    // 「目录里什么都没有」是环境没准备好，「给了东西但用不了」是要去修那份文件，
    // 两者的处置完全不同。
    if (skipped.length > 0) {
      console.log(`目录 ${args.dir} 里没有可用的 ${ROSTER_FILE_SUFFIX} 文件（上面逐条列了不可用的原因）`);
      return summary;
    }
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

      // 重名判定先于上传：不先判的话后一份已经把前一份覆盖了，再来报错也晚了。
      // "differ" 计入 failures（→ exit 1）但不发 PUT：让运维先决定哪一份是最终版，
      // 比脚本自己挑一份覆盖下去更安全。错误数据一旦落进 KV，服务端下次加载就会
      // 拿它服务，而现场（哪次上传、谁传的）已经丢了。
      const conflict = checkSchoolNameConflict(seen, document.schoolName, document.payload);
      if (conflict === "differ") {
        summary.failures += 1;
        printConflict(document.schoolName, fileName, document.payload, seen.get(document.schoolName));
        continue;
      }

      const verdict = await uploadOne(args.endpoint, args.token, document.schoolName, document.payload);
      if (verdict.ok) {
        summary.successes += 1;
        // 只有真的成功才登记：失败的那一份没有写进 KV，不该让后续同名项被它
        // 判定成「重名」。登记的是本次内容指纹，后续同内容的再次出现算幂等重传。
        seen.set(document.schoolName, { file: fileName, fingerprint: fingerprint(document.payload) });
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

// runSelfTest 覆盖全部纯逻辑：拆分、URL 编码、响应归类、退出码、参数、文件形态、
// 跨文件同名校冲突、校名不可编码。不联网、不用真实 data/，因此能在任何机器上跑
// （包括 CI）。
async function runSelfTest() {
  const roster = (region, schools) => JSON.stringify({ 区县: region, 学校: schools });
  let failures = 0;

  // pending 收集每条用例的返回值。同步用例在这里就已得出结果，async 用例留一个
  // promise 待末尾统一 await——同步 try/catch 抓不住 async 的 rejection，
  // 不这么做那条 URIError 用例会「永远通过」，测的是空气。
  const pending = [];
  const check = (label, fn) => {
    try {
      pending.push({ label, result: fn() });
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

  check("跨文件同名校：同内容算幂等重传，不算冲突", () => {
    const seen = new Map();
    const payload = JSON.stringify({ 区县: "福清市", 学校: [schoolA] });
    assert.equal(checkSchoolNameConflict(seen, "福清一中", payload), null);
    // 模拟第一份已成功登记（指纹同源，都由 fingerprint 算）。
    seen.set("福清一中", { file: "福清一中_173_roster.json", fingerprint: fingerprint(payload) });
    assert.equal(checkSchoolNameConflict(seen, "福清一中", payload), "same");
  });

  check("跨文件同名校：不同内容判为冲突（后一份会覆盖前一份）", () => {
    const seen = new Map();
    const first = JSON.stringify({ 区县: "福清市", 学校: [schoolA] });
    const second = JSON.stringify({ 区县: "福清市", 学校: [{ ...schoolA, 年级: [] }] });
    seen.set("福清一中", { file: "福清一中_173_roster.json", fingerprint: fingerprint(first) });
    assert.equal(checkSchoolNameConflict(seen, "福清一中", second), "differ");
    // 换一所学校不受影响：判定按校名分桶，不是全局「见过任何名单」。
    assert.equal(checkSchoolNameConflict(seen, "福清二中", second), null);
  });

  check("冲突计入 failures 并让退出码非 0（不发 PUT 也不改变汇总口径）", () => {
    assert.equal(exitCodeFor({ failures: 1, aborted: false }), EXIT_FAILED);
    // 只有成功项（幂等重传）时退出码仍是 0：重复跑同一批文件不该被当成失败。
    assert.equal(exitCodeFor({ failures: 0, aborted: false }), EXIT_OK);
  });

  check("校名含孤立代理项时 URIError 被 uploadOne 收敛成结论对象", async () => {
    // 直接调用即可：buildRosterUrl 在 try 内，抛错落进 catch。
    const badName = "坏\uD800校";
    // 先证明这个输入确实会触发 URIError，否则下面的断言测的是空气。
    assert.throws(() => encodeURIComponent(badName), URIError);

    const verdict = await uploadOne("http://127.0.0.1:8787", "t", badName, "{}");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.kind, "invalid-name");
    assert(verdict.detail.includes("校名无法编码进 URL"));
    // 它既不该被说成网络故障，也不该中止整轮。
    assert.notEqual(verdict.kind, "network");
  });

  check("listRosterFiles：断链 symlink 进 skipped 而不是被静默丢弃", async () => {
    // 用真实临时目录跑：这条语义（readdir 报链接自身、stat 才能看穿）只有
    // 真文件系统能验证，伪造的 Dirent 测不出 isSymbolicLink 的真实行为。
    const dir = path.join("tmp_selftest_list", "case");
    await rm("tmp_selftest_list", { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    // 一份正常文件 + 一条断链 + 一条指向目录的链接。
    await writeFile(path.join(dir, "正常校_1_roster.json"), "{}", "utf8");
    try {
      await symlink("../不存在的目标.json", path.join(dir, "断链校_1_roster.json"));
      await mkdir(path.join(dir, "子目录"), { recursive: true });
      await symlink("子目录", path.join(dir, "目录校_1_roster.json"));
    } catch (error) {
      // Windows 未开开发者模式时 symlink 需要提权。这种情况下跳过本条断言，
      // 但要明确说出来，不静默当成通过。
      console.log(`（symlink 不可用，跳过该断言：${error.message}）`);
      await rm("tmp_selftest_list", { recursive: true, force: true });
      return;
    }

    const { files, skipped } = await listRosterFiles(dir);
    assert.deepEqual(files, ["正常校_1_roster.json"]);
    assert.equal(skipped.length, 2, `跳过项数不对：${JSON.stringify(skipped)}`);
    assert(skipped.some((item) => item.name === "断链校_1_roster.json" && item.reason.includes("已断")));
    assert(skipped.some((item) => item.name === "目录校_1_roster.json" && item.reason.includes("不是普通文件")));
    // 关键：被跳过的项必须能被调用点看见并计入失败——静默丢弃正是这条路径的病。
    assert(skipped.every((item) => typeof item.reason === "string" && item.reason !== ""));

    await rm("tmp_selftest_list", { recursive: true, force: true });
  });

  // 统一收口：同步用例这里才打印结论，async 用例先 await 再判定。
  // 顺序按登记顺序，日志因此与代码顺序一致，逐条核对时不会错位。
  for (const item of pending) {
    try {
      await item.result;
      console.log(`自测通过：${item.label}`);
    } catch (error) {
      failures += 1;
      console.log(`自测失败：${item.label} -> ${error.message}`);
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} 条自测失败`);
  }
  console.log(`自测全部通过（${pending.length} 条）`);
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
      await runSelfTest();
      return EXIT_OK;
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      return EXIT_FAILED;
    }
  }

  const summary = await run(args);
  if (summary.usageError) return EXIT_USAGE;

  // 「已尝试」而不是「已上传」：summary.schools 在发 PUT 之前自增，重名冲突项
  // 与失败项都算进去，实际写进 KV 的数量是 summary.successes。两处用词必须分开，
  // 否则一行汇总会把「试了 3 所、只成功 1 所」说成「上传了 3 所」。
  //
  // summary.failures 里可能含「文件级」失败（symlink 不可用、JSON 坏）：它们不对应
  // 任何一所学校，因此失败数可以大于「已尝试学校数 - 成功数」。差的这一块就是它们，
  // 逐条原因已经在上面打印过。
  const unattempted = summary.aborted ? `（未尝试 ${summary.remaining} 项：本文件剩余学校 + 后续未处理文件）` : "";
  console.log(
    `汇总：文件 ${summary.files} 个，已尝试学校 ${summary.schools} 所；成功 ${summary.successes}，失败 ${summary.failures}${unattempted}`,
  );
  return exitCodeFor(summary);
}

process.exitCode = await main();
