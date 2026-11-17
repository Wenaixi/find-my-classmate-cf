// 把 ADMIN_TOKEN 写成 wrangler deploy --secrets-file 需要的 JSON。
//
// 为什么单独成一个脚本而不是在 workflow 里内联 node -e：
//   - 值里有引号、反斜杠、$、换行时，行内拼接在 YAML 的 run 块里会同时受
//     YAML 引号规则与 shell 展开规则影响，写错与读错都很难被发现。
//     这里由 JSON.stringify 负责转义，调用方只传路径。
//   - 放在文件里就能用 --self-test 本地验证往返（含刁钻字符），
//     不必等到打 tag 那一刻才发现 secret 变成了别的值。
//
// 用法：
//   node scripts/gen-secrets-file.mjs <输出路径>
//   node scripts/gen-secrets-file.mjs --self-test
//
// 输出路径必须由调用方给出（CI 里用 RUNNER_TEMP），本脚本不猜位置：
// 猜一个默认路径等于默认往工作区里写凭据。
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// serialize 生成 secrets 文件的文本内容。单独抽出来是为了让自测与真实写入
// 走同一条代码，而不是让自测验证一份与生产不同的实现。
function serialize(token) {
  return JSON.stringify({ ADMIN_TOKEN: token });
}

// selfTest 用含各种需要转义的字符验证写入-读取往返完全一致。
//
// 断言的是「往返」，不是「文件里有什么」：前者才是调用方真正依赖的性质
// （wrangler 会读回同一个值），后者只锁定当前实现的字节形态。
function selfTest() {
  const tricky = 'a"b\\c$d${HOME}\nef 中文 \t end';
  const file = join(tmpdir(), `fmc-secrets-selftest-${process.pid}.json`);
  try {
    writeFileSync(file, serialize(tricky), { mode: 0o600 });
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed.ADMIN_TOKEN !== tricky) {
      throw new Error("往返失败：写入后再读出的值与原值不同");
    }
    if (Object.keys(parsed).length !== 1) {
      throw new Error("往返失败：文件里出现了多余的键");
    }
    console.log("自测通过：引号/反斜杠/美元符号/换行/制表符/中文均原样往返");
  } finally {
    // 删掉临时文件：即使断言失败也不留凭据。只吞掉 ENOENT，其余异常照常抛出，
    // 否则清理失败会掩盖上面的断言失败。
    try {
      unlinkSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function main(argv) {
  if (argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const outputPath = argv[2];
  if (outputPath === undefined || outputPath === "") {
    console.error("用法：node scripts/gen-secrets-file.mjs <输出路径> | --self-test");
    process.exit(2);
  }
  const token = process.env.ADMIN_TOKEN;
  // 缺失时明确失败而不是写一个空串：空 token 会被部署上去，而 admin.ts 对空
  // expected 一律拒绝（那是刻意的），结果是管理端全 401，排查方向会被引向代码。
  if (token === undefined || token === "") {
    console.error("错误：环境变量 ADMIN_TOKEN 未设置或为空。");
    process.exit(1);
  }
  writeFileSync(outputPath, serialize(token), { mode: 0o600 });
  console.log(`已写入 secrets 文件：${outputPath}`);
}

main(process.argv);
