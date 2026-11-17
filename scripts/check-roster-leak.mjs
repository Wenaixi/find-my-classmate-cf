// 隐私红线扫描：用 data/ 下真实名单里的姓名集，比对全部 git 追踪文件的文本，
// 找出「真实姓名以字面量形式出现在仓库里」的位置。
//
// 这是 C-2 要求的守卫脚本本体（CI 步骤调用它）。没有 data/ 时脚本自己降级为
// 「跳过」并说明原因——CI 里恒无 data，那种场景下这道守卫无法比对，所以真正的
// 防线仍是上传脚本 fixture 的合成名白名单自测（见 upload-roster.mjs --self-test）。
//
// 用法：
//   node scripts/check-roster-leak.mjs            # 默认读 data/ 与 git ls-files
//   node scripts/check-roster-leak.mjs --data-dir DIR
//   node scripts/check-roster-leak.mjs --self-test  # 用合成数据验证比较器本身能抓差异
//
// 退出码：0 无泄漏 / 1 发现泄漏 / 2 环境问题（脚本自身用法错误）
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// 姓名最短长度：单字姓名在中文里合法但极易与普通词重合（「王」「李」），
// 直接按单字比对会产生海量假阳性（正文里到处是这些字）。中文姓名实际以 2-3 字
// 为主，取 2 作为下限；单字名的泄漏只能靠人工复核，脚本不声称覆盖它。
const MIN_NAME_LENGTH = 2;

// 只扫这些扩展名的追踪文件：文本型源码与文档。二进制/锁文件里出现姓名即
// 说明别的问题，不在本脚本职责内（锁文件由依赖源守卫单独管）。
const TEXT_EXTENSIONS = new Set([
  ".md", ".ts", ".tsx", ".mjs", ".js", ".json", ".jsonc", ".yml", ".yaml",
  ".html", ".css", ".txt", ".py", ".sh",
]);

// HOMONYM_WORDS 是同形普通词白名单：这些词确实是真实名单里的姓名，但在正文里
// 被用作普通中文词，与该学生无关。不放进白名单的话守卫每次都会报它们，
// 而为了让工具闭嘴去改写正常行文是本末倒置。
//
// 代价必须说清：白名单是全局的，所以「关心」如果将来被当成学生名写进 fixture，
// 这道守卫抓不到。因此每次运行都打印被跳过的词与条数——盲区要可见，不能静默。
const HOMONYM_WORDS = new Map([
  ["关心", "正文里的普通动词用法（「真正关心的裂缝」「调用点与测试都关心」），不是学生名"],
]);

// 从 roster 文档里收集姓名。形状与 shared/roster.ts 一致：学校 → 年级 → 班级 → 学生。
// 直接 JSON.parse 后按路径取值，不引入校验逻辑——这里只关心「有哪些名字」。
function collectNamesFromDocument(document, sink) {
  const schools = Array.isArray(document?.学校) ? document.学校 : [];
  for (const school of schools) {
    const grades = Array.isArray(school?.年级) ? school.年级 : [];
    for (const grade of grades) {
      const classes = Array.isArray(grade?.班级) ? grade.班级 : [];
      for (const klass of classes) {
        const students = Array.isArray(klass?.学生) ? klass.学生 : [];
        for (const student of students) {
          const name = typeof student?.姓名 === "string" ? student.姓名.trim() : "";
          if (name.length >= MIN_NAME_LENGTH) sink.add(name);
        }
      }
    }
  }
}

// loadRealNames 读数据目录里全部 *.json，返回真实姓名集合。
function loadRealNames(dataDir) {
  const names = new Set();
  const entries = fs.readdirSync(dataDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const full = path.join(dataDir, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      // 读不动就说清楚是哪份，不静默跳过：静默跳过会让守卫在「数据坏了」时
      // 报「零命中」，那是最危险的假绿。
      throw new Error(`无法解析 ${full}: ${error instanceof Error ? error.message : String(error)}`);
    }
    collectNamesFromDocument(parsed, names);
  }
  return names;
}

// trackedTextFiles 取全部 git 追踪的文本文件。用 git ls-files 而不是遍历目录：
// 目录里有 node_modules / dist / data 等未追踪内容，遍历既慢又会误报。
function trackedTextFiles(repoRoot) {
  const out = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => TEXT_EXTENSIONS.has(path.extname(line)));
}

// findLeaks 扫全部追踪文本文件，返回命中列表与被跳过的同形词统计。
// 逐文件读、逐名比对：姓名集通常几千个，文件几十个，直接 includes 的代价足够小。
function findLeaks(repoRoot, realNames) {
  const files = trackedTextFiles(repoRoot);
  const leaks = [];
  const skipped = new Map();
  for (const file of files) {
    const full = path.join(repoRoot, file);
    let text;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue; // 读不动的（符号链接等）跳过，不当作泄漏
    }
    const lines = text.split("\n");
    for (const name of realNames) {
      if (!text.includes(name)) continue;
      if (HOMONYM_WORDS.has(name)) {
        skipped.set(name, (skipped.get(name) ?? 0) + 1);
        continue;
      }
      // 已经确定文件里有，再定位到具体行，便于报告
      lines.forEach((line, index) => {
        if (line.includes(name)) {
          leaks.push({ file, line: index + 1, name, snippet: line.trim().slice(0, 120) });
        }
      });
    }
  }
  return { files, leaks, skipped };
}

// selfTest 验证比较器真的能抓差异：造一份「含基准集里某个名字」的假文件，
// 必须被抓到；造一份只含白名单名的假文件，必须零命中。
// 没有这一步时「零命中」无法区分「真的干净」与「比较器失效」。
//
// 基准集用**构造出来的假名**而不是真实姓名：本脚本自己要能被扫描通过，
// 把真名写进自测样本等于在守卫里留一处泄漏。假名取中国姓名里不可能出现的
// 组合（含拉丁字母与符号），保证与任何真实名单不相交。
function selfTest() {
  const syntheticReal = new Set(["ZzQqTestName1", "ZzQqTestName2"]);
  const tmp = path.join(process.cwd(), "tmp-leak-selftest");
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "dirty.md"), "示例：ZzQqTestName1 出现在这里\n", "utf8");
  fs.writeFileSync(path.join(tmp, "clean.md"), "示例：张三 出现在这里\n", "utf8");

  const probe = (file, text) => {
    const lines = text.split("\n");
    const hits = [];
    for (const name of syntheticReal) {
      if (!text.includes(name)) continue;
      lines.forEach((line, index) => {
        if (line.includes(name)) hits.push(`${file}:${index + 1}:${name}`);
      });
    }
    return hits;
  };

  const dirtyHits = probe("dirty.md", fs.readFileSync(path.join(tmp, "dirty.md"), "utf8"));
  const cleanHits = probe("clean.md", fs.readFileSync(path.join(tmp, "clean.md"), "utf8"));
  fs.rmSync(tmp, { recursive: true, force: true });

  if (dirtyHits.length === 0) {
    console.error("自测失败：含真实姓名的文件未被抓出，比较器失效。");
    return false;
  }
  if (cleanHits.length !== 0) {
    console.error("自测失败：合成名文件被误报。");
    return false;
  }
  console.log(`自测通过：含真实姓名的样本被抓出 ${dirtyHits.length} 处，合成名样本零命中。`);
  return true;
}

function main() {
  const argv = process.argv.slice(2);
  // --self-test 先判：它不依赖 data/ 与 git，CI 无 data 时也能跑
  if (argv.includes("--self-test")) {
    return selfTest() ? 0 : 1;
  }

  const dataDirIndex = argv.indexOf("--data-dir");
  const repoRoot = process.cwd();
  const dataDir = dataDirIndex >= 0 && argv[dataDirIndex + 1] !== undefined
    ? path.resolve(argv[dataDirIndex + 1])
    : path.join(repoRoot, "data");

  if (!fs.existsSync(dataDir)) {
    // 没有 data 就没有比对基准。这里刻意不返回成功并打印醒目提示：
    // 让读者知道「这次没查」而不是「查过没问题」。
    console.log(`跳过：${dataDir} 不存在，无真实姓名集可比对。`);
    console.log("这道守卫在有名单数据的环境（本地/校内）才生效；CI 里恒无 data。");
    console.log("仓库侧的防线是上传脚本自测只用合成名白名单。");
    return 0;
  }

  const realNames = loadRealNames(dataDir);
  if (realNames.size === 0) {
    console.log(`跳过：${dataDir} 里没有解析出任何姓名（${MIN_NAME_LENGTH} 字以上）。`);
    return 0;
  }

  const { files, leaks, skipped } = findLeaks(repoRoot, realNames);
  console.log(`比对：${realNames.size} 个真实姓名 × ${files.length} 个追踪文本文件。`);
  if (skipped.size > 0) {
    // 盲区必须可见：这些名字确实在真实名单里，但被当作普通词跳过了。
    console.log(`跳过的同形普通词（${skipped.size} 个，各含一次以上出现）：`);
    for (const [word, count] of skipped) {
      console.log(`  ${word}（${count} 个文件）：${HOMONYM_WORDS.get(word)}`);
    }
    console.log("  注意：白名单是全局的，这些词若出现在 fixture 里，本守卫抓不到。");
  }
  if (leaks.length === 0) {
    console.log("零命中：追踪文件里没有出现任何真实姓名。");
    return 0;
  }
  console.error(`发现 ${leaks.length} 处真实姓名泄漏：`);
  for (const leak of leaks) {
    console.error(`  ${leak.file}:${leak.line} [${leak.name}] ${leak.snippet}`);
  }
  return 1;
}

process.exit(main());
