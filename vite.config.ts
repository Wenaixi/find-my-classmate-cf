import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "server/web",
    emptyOutDir: true,
    // Vite 8 的 Rolldown 分包：以正则 test 匹配模块路径，同名 group 合并进同一 chunk。
    // 与旧 manualChunks 函数等价：react 与 scheduler 同入 vendor-react，border-beam 单独成组；
    // liquid-gooey 与 thinking-orbs 不单独分组，按默认规则随引用方落位。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { test: /node_modules\/react/, name: "vendor-react" },
            { test: /node_modules\/scheduler/, name: "vendor-react" },
            { test: /node_modules\/border-beam/, name: "vendor-beam" }
          ]
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3078" }
  },
  preview: { port: 4173 }
});
