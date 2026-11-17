/// <reference types="node" />
// 部署配置的契约测试：跑在 node 项目里读 wrangler.jsonc，断言「路由层」的
// 关键字段。
//
// 文件级的 node 类型引用必须在最顶部（在任何 import 之前）：本项目
// （tsconfig.app.json）不列 types，@types/node 的全局声明因此不会自动进来，
// 而 node:fs 需要它。写成文件级而不是往 app 项目的 types 里加 node，是因为
// 只有这一个测试需要读磁盘——把 node 全局塞进整个前端项目会让「Node 才有的
// API 在前端代码里不报错」成为既成事实。
//
// 为什么必须有这一组：wrangler.jsonc 里 assets.run_worker_first 决定平台是否
// 先把请求交给 Worker 脚本。它默认为关闭，此时命中的静态文件直接由 Asset
// Worker 服务，Worker 代码根本不执行——六条安全头不铺、公共限流不生效、
// 访问日志不写。而这条**任何 workerd 测试都测不到**：SELF.fetch 直接代理到
// 默认导出的 fetch，天然绕过 assets 路由层，所以装配链全绿也证明不了线上成立。
// 只能靠读配置来钉。
//
// 放在 frontend 项目而不是 worker 项目，是因为 workerd 里没有 node:fs
// （实测 readFileSync 在 worker 项目里报 no such file or directory）。
// 配置是部署事实、不属于运行时行为，归 node 项目语义上也更对。
//
// 解析用 JSONC 的最小处理：剥注释、去尾逗号。不引第三方解析器，也不 import
// wrangler 的内部函数——wrangler 只导出 unstable_readConfig，而它会做完整的
// 配置校验并可能触发副作用，对一条断言太重。这里要的只是几个字段的字面值，
// 剥注释的代价远小于引入一个不稳定 API。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CONFIG_PATH = "wrangler.jsonc";

// stripJSONC 把 JSONC 转成可 JSON.parse 的文本。
//
// 只处理两种 JSONC 特性：行注释与尾逗号。块注释刻意不处理——本仓的
// wrangler.jsonc 不用块注释，写一个半吊子的块注释剥离器反而会在字符串里
// 出现 /* 时误伤。真要支持块注释时一并补上引号内字符串的跳过逻辑。
function stripJSONC(source: string): string {
  const withoutLineComments = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    // 行尾注释：只在此行不含引号时才剥，避免把字符串里的 // 当成注释起点
    // （例如 "https://..." 这类值）。当前配置里没有这种行，但这道闸门成本极低。
    .map((line) => (line.includes('"') ? line : line.replace(/\/\/.*$/, "")))
    .join("\n");
  // 尾逗号：JSON 不接受 ] 或 } 之前的逗号。
  return withoutLineComments.replace(/,\s*([}\]])/g, "$1");
}

// loadConfig 读取并解析 wrangler.jsonc。
function loadConfig(): Record<string, unknown> {
  const raw = readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(stripJSONC(raw)) as Record<string, unknown>;
}

// assets 字段的形状。用结构化断言而不是 any：字段名写错会编译失败。
interface AssetsConfig {
  directory?: string;
  binding?: string;
  run_worker_first?: boolean | string[];
}

describe("wrangler.jsonc 部署契约", () => {
  const config = loadConfig();
  const assets = config.assets as AssetsConfig | undefined;

  // 这是本组最重要的一条，理由见文件头。用 === true 而不是真值断言：
  // run_worker_first 的合法值是 boolean 或字符串数组，「数组」也算配置了
  // 白名单路由，但与「所有请求先进 Worker」不是同一件事，因此不接受。
  it("assets.run_worker_first 必须为 true（否则静态资源绕过 Worker）", () => {
    expect(assets, "缺少 assets 配置").toBeDefined();
    expect(assets?.run_worker_first).toBe(true);
  });

  // run_worker_first 为 true 而没有 binding 时，Worker 拿不到 env.ASSETS，
  // 静态回退那条分支会变成 TypeError。wrangler 对此只会给一条警告。
  it("assets 同时声明了 binding（否则 Worker 无法回退静态资源）", () => {
    expect(assets?.binding).toBe("ASSETS");
  });

  // 入口必须指向装配层：cloudflareTest 与 deploy 都从这里取 main。
  it("main 指向 worker 装配层", () => {
    expect(config.main).toBe("src/worker/index.ts");
  });

  // 兼容日期必须存在且在 cloudflareTest 要求的下界之后
  // （官方文档：2022-10-31 或更晚，否则 ES module 格式不被支持）。
  it("compatibility_date 不早于 2022-10-31", () => {
    const date = config.compatibility_date;
    expect(typeof date).toBe("string");
    // 日期是 ISO 形态字符串，字典序比较即时间序比较。
    expect(String(date) >= "2022-10-31").toBe(true);
  });

  // 绑定契约：Env 接口里声明的四个绑定必须在配置里都有对应项，
  // 否则部署后 env.X 读到 undefined。
  it("声明了 ROSTER / API_RATE_LIMITER / VERSION 三个绑定", () => {
    const kv = config.kv_namespaces as Array<{ binding?: string }> | undefined;
    expect(kv?.some((entry) => entry.binding === "ROSTER")).toBe(true);

    const rateLimits = config.ratelimits as Array<{ name?: string; simple?: { limit?: number; period?: number } }> | undefined;
    const limiter = rateLimits?.find((entry) => entry.name === "API_RATE_LIMITER");
    expect(limiter, "缺少 API_RATE_LIMITER 限流绑定").toBeDefined();
    // period 只接受 10 或 60（wrangler schema 的枚举），写错值会在部署期报错。
    expect([10, 60]).toContain(limiter?.simple?.period);
    expect(limiter?.simple?.limit).toBeGreaterThan(0);

    // VERSION 走 vars：健康检查与 503 都回显它，缺了会答 undefined。
    const vars = config.vars as Record<string, string> | undefined;
    expect(vars?.VERSION).toBeDefined();
  });

  // ADMIN_TOKEN 刻意不在这里断言：它是 secret，不该以明文进仓库。
  // 断言「配置里没有它」反而把「走 secret 供给」这条约定钉住。
  it("ADMIN_TOKEN 不出现在配置文件里（应走 secret 供给）", () => {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    expect(raw).not.toContain("ADMIN_TOKEN");
  });
});
