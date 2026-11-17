import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Vite 8 的 Rolldown 分包：以正则 test 匹配模块路径，同名 group 合并进同一 chunk。
    // 与旧 manualChunks 等价：react 与 scheduler 同入 vendor-react，border-beam 单独成组；
    // liquid-gooey 与 thinking-orbs 不单独分组，按默认规则随引用方落位。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { test: /node_modules[\\/]react/, name: "vendor-react" },
            { test: /node_modules[\\/]scheduler/, name: "vendor-react" },
            { test: /node_modules[\\/]border-beam/, name: "vendor-beam" }
          ]
        }
      }
    }
  },
  server: {
    port: 5173,
    // dev 时代理到本地 Worker（`npx wrangler dev --port 8787`）。此前指向 Go 服务的
    // 3078，Go 删除后没有第二个后端可指，端口跟随 Worker 的默认本地端口。
    proxy: { "/api": "http://localhost:8787" }
  },
  preview: { port: 4173 }
});
