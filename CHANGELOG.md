# Changelog

本项目所有值得记录的变更都记录在这个文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [v0.1.0] - 2026-11-17

从 FindMyClassmate v0.12.0 派生，独立维护，版本号从 0.1.0 重新起算。原仓库的版本历史保留在 FindMyClassmate。

### Added

- `src/shared/` 单一 owner 层：年段值域、班级解析、查询解析、契约常量、学生模型，前端与 Worker 共用同一份实现，不再维护两套镜像。
- `src/worker/search.ts`：匹配、排序、分页的 TypeScript 实现，逐条消费契约语料。
- `docs/cloudflare-migration-design.md`：Cloudflare 全托管迁移设计稿。

### Changed

- 依赖升级：React 19.3.1、TypeScript 7.0.2、Vite 8.3.8、Vitest 5.1.0、@vitejs/plugin-react 6.3.0、jsdom 31.0.1、动效库 1.4.1 / 0.2.2 / 0.3.2。
- CI/Release 的 actions 升至当前主版本：checkout v7、setup-node v7、setup-go v7、artifacts v7 / v8、docker 系列 v4–v7、action-gh-release v3。
- CHANGELOG 重写为 Keep a Changelog 格式。

### Notes

- 迁移进行中：Go 服务仍是可运行的实现，Worker 尚未装配路由与 KV 存储，`/api/*` 契约与响应形状在此期间保持不变。

[Unreleased]: https://github.com/Wenaixi/find-my-classmate-cf/compare/v0.1.0...HEAD
[v0.1.0]: https://github.com/Wenaixi/find-my-classmate-cf/releases/tag/v0.1.0
