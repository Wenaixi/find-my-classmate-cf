# Changelog

本项目所有值得记录的变更都记录在这个文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [v0.1.0] - 2026-11-16

从 FindMyClassmate v0.12.0 派生，独立维护，版本号从 0.1.0 重新起算。功能与数据格式沿用原项目，原仓库的版本历史保留在 FindMyClassmate。

### 新增

- 查询解析、班级解析、年段值域、契约常量、学生模型收进 `src/shared/`，前端与 Worker 共用同一份实现，不再维护两套镜像。
- `src/worker/search.ts`：匹配、排序、分页的 TS 实现，逐条消费契约语料，Go 侧测试同时保持通过。
- `docs/cloudflare-migration-design.md`：迁移设计规格。

### 变更

- 依赖升级到最新：React 19.3、Vite 8.3、TypeScript 7.0、Vitest 5.1、jsdom 31，三个动效库同步更新。

### 说明

- 迁移进行中。Go 服务仍是可运行的实现，Worker 尚未装配路由与 KV 存储，`/api/*` 契约与响应形状在此期间保持不变。
