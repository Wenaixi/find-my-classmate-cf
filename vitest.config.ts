// Vitest 双项目配置：全仓测试体系在本任务第一次结构性分叉。
//
// 分叉的理由不是「多一个环境好玩」，而是两类测试对运行时有不兼容的要求：
// 前端与纯逻辑测试跑在 Node 里（需要 DOM 时用 @vitest-environment jsdom 单文件
// 声明），而 worker 的集成测试必须跑在 workerd 里才有 KV 绑定、Rate Limiting
// 绑定与 SELF.fetch。把它们塞进同一环境任意一边都不成立——Node 里没有
// cloudflare:test，workerd 里没有 jsdom 与 Node 模块。
//
// 用 projects 而不是两份独立 config + 两个 npm 脚本：项目归属写在同一处，
// 「哪个测试归哪个项目」因此只有一份事实源。独立 config 的形态会让
// `npm test` 必须串两个脚本，任一方漏跑都没有信号——而漏跑一个项目正是这次
// 迁移最需要防的失误（新增的集成用例会静默不执行，套件仍然全绿）。
//
// include 划分是硬约束（评审定案）：
// - 前端项目收 src 下全部 *.test.{ts,tsx}，显式排除 src/worker/index.test.ts。
//   不做排除的后果是同一条测试被两个项目各跑一遍，前端那份会因为解析不了
//   cloudflare:test 而报模块缺失——错误信息看起来像插件配置坏了，实际是归属
//   划错。
// - worker 项目只收 src/worker/index.test.ts。
//
// exclude 用 configDefaults.exclude 展开再追加，而不是只写一条：Vitest 的
// exclude 是整体替换而不是合并，只写自己那条会把 node_modules / dist 的默认
// 排除一并丢掉，测试收集器就会走进依赖树。
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // 前端与纯逻辑：保持迁移前的形态，environment 由根配置给出（node），
        // 需要 DOM 的文件自行声明 jsdom。
        test: {
          name: "frontend",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: [...configDefaults.exclude, "src/worker/index.test.ts"]
        }
      },
      {
        // workerd 集成：入口与绑定全部从 wrangler.jsonc 读，因此测试里的
        // env 与真实部署同源（同一份 kv_namespaces / ratelimits / assets 声明）。
        //
        // ADMIN_TOKEN 走 miniflare 覆盖而不写进 wrangler.jsonc：它是要部署的
        // 配置文件，明文写一个管理端凭据进去等于把真凭据交给仓库（部署配置补全环境变量的迁移提交会
        // 用 secret 供给）。测试在 miniflare 层注入固定值，既让管理端全链路
        // 可跑，又不动部署配置。
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                ADMIN_TOKEN: "test-admin-token"
              }
            }
          })
        ],
        test: {
          name: "worker",
          include: ["src/worker/index.test.ts"]
        }
      }
    ]
  }
});
