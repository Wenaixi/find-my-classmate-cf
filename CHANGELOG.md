# Changelog

本项目所有值得记录的变更都记录在这个文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 测试锚点折叠模块 `src/od.ts`：`data-od-id` 在源码中保留、生产产物中不存在。

### Changed

- 结果行去掉逐行形状物理（`morph.shape` → `observe`），保留容器级液体合并；`ResultCard` 用 `memo` 包裹，打字时不再逐行重渲染。
- 学校选择器面板改为 `aria-labelledby="results-title"` 语义、结果列表不再声称 `role="list"`（`Liquid.Item` 的中间层使 owned-children 契约不成立）。
- 首屏预载 `Mona Sans` 字体；`color-scheme: dark` 与滚动条配色让原生浏览器 UI 跟随深色主题。
- **运行形态：Go 单二进制 + Docker → 单个 Cloudflare Worker。** `server/` 的 12 个模块、Dockerfile、docker-compose.yml 与 `scripts/local-dev.mjs` 全部删除，共 -7339 行；页面、`/api`、管理端点与静态资源由同一个 Worker 提供，部署命令是 `npx wrangler deploy`。
- 名单存储：`data/` 文件热重载 → Workers KV（`roster:index` + 一校一个 `roster:{校名}`），写入走管理 API。
- 热更新语义：文件变更 1 秒内生效 → KV 最终一致，其他边缘位置最多约 60 秒可见。
- 限流：进程内 per-IP 令牌桶（突发 60、每秒回补 1）→ Workers Rate Limiting binding（每边缘位置独立计数、近似限流，窗口 60 秒 60 次）。这是迁移后唯一与迁移前不等价的行为项。
- 查询解析与执行收进 `src/shared/`（前端与 Worker 共用一份实现），跨语言对拍机制随之退役；契约语料 `docs/query-contract.json` 从「两侧对拍基准」改为「唯一权威」，消费方是 `src/shared/query.test.ts` 与 `src/worker/search.test.ts`。
- 测试：Go 测试套件 → Vitest 双项目（前端 node/jsdom + worker workerd），24 个文件 / 614 条用例。
- `docs/ARCHITECTURE.md` 重写：module 表改为 shared/worker 结构，热更新、限流、CPU 边界、健康检查语义全部按新形态描述；`CONTEXT.md` 的年段值域、数据可用性、契约三组术语同步。

### Fixed

- 学校下拉的键盘导航此前无法选中任何学校：焦点从不进入面板，`onPanelKeyDown` 不可达（WCAG 2.1.1 A 级）。现改为面板打开即接收焦点，关闭时归还触发按钮。
- 状态行与结果区此前都是 `aria-live="polite"`，同一次结果播报两遍；现收敛为仅状态行。
- 测试基线：新增 `SchoolPicker.test.tsx`（5 条）与 `od.test.ts`（2 条），总数为 25 文件 / 623 条。

### Removed

- 退役纪律四条，原因逐条记录：分配预算（`TestSearchAllocsBudget`，JS 无对应物）、`go test -race`（无共享内存可竞）、`gofmt`（无 Go）、Go↔TS 常量对拍（单一 owner 取代）。这些约束现在都没有测试守着，`docs/ARCHITECTURE.md` 与 `CLAUDE.md` 写明了各自的后果。
- 名单标题校验（`parseGradeInTitle`）：KV 里没有文件名，校名只是索引里的一项，没有标题可校验。名单加载因此不再反向依赖年段值域。

### Notes

- 迁移期的行为等价性验证只写在迁移工作区的未入库目录 `.superpowers/sdd/2026-11-15-cloudflare-migration/task-15-report.md` 里：三份真实名单共 7088 名学生、26 条查询在旧 Go 服务与 Worker 上逐字段一致，并另造一次单字段变异验证比较器真能抓差异。该报告**故意不入库**（含真实姓名与命中数，属隐私红线），因此这条基线没有任何可执行断言守着；重验前需从存有该报告的本地迁移工作区取回报告（克隆内没有）。

## [v0.1.0] - 2026-11-17

从 FindMyClassmate v0.12.0 派生，独立维护，版本号从 0.1.0 重新起算。原仓库的版本历史保留在 FindMyClassmate。

### Added

- `src/shared/` 单一 owner 层：年段值域、班级解析、查询解析、契约常量、学生模型，前端与 Worker 共用同一份实现，不再维护两套镜像。
- `src/worker/search.ts`：匹配、排序、分页的 TypeScript 实现，逐条消费契约语料。
- `docs/cloudflare-migration-design.md`：Cloudflare 全托管迁移设计稿。

### Changed

- 依赖升级：React 19.3.1、TypeScript 7.0.2、Vite 8.3.8、Vitest 5.1.0、@vitejs/plugin-react 6.3.0、jsdom 31.0.1、动效库 1.4.1 / 0.2.2 / 0.3.2。
- CI/Release 的 actions 升至当前主版本：checkout v7、setup-node v7、`setup-go` v7、artifacts v7 / v8、docker 系列 v4–v7、action-gh-release v3。**其中 `setup-go` 与 docker 系列属 Go 侧与镜像流水线的历史条目，已在 Unreleased 里随迁移退役——现在的工作流只有 checkout、setup-node 与 action-gh-release。**
- CHANGELOG 重写为 Keep a Changelog 格式。

### Notes

- 迁移进行中：Go 服务仍是可运行的实现，Worker 尚未装配路由与 KV 存储，`/api/*` 契约与响应形状在此期间保持不变。（此状态已由 Unreleased 结束。）

[Unreleased]: https://github.com/Wenaixi/find-my-classmate-cf/compare/v0.1.0...HEAD
[v0.1.0]: https://github.com/Wenaixi/find-my-classmate-cf/releases/tag/v0.1.0
