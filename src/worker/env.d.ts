// cloudflare:test 的 env 类型入口。
//
// @cloudflare/vitest-plugin/types 把 cloudflare:test 的 env 声明为 Cloudflare.Env，
// 而 Cloudflare.Env 是 workers-types 留出的空接口，由项目自行合并。这里把它接到
// src/worker/index.ts 导出的 Env 上，使「绑定契约」在全仓只有一份声明：
// 装配层的 Env、测试里 env 的类型、wrangler.jsonc 的绑定三者不会各写一份字面量
// 后悄悄分叉（漏一个绑定会在这里编译失败，而不是在运行时读出一个 undefined）。
import type { Env as WorkerEnv } from "./index";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends WorkerEnv {}
  }
}
