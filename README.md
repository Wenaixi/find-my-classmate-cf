# FindMyClassmate

> 校园学生档案检索台

FindMyClassmate 是一个面向校园场景的班级查询工具。React + TypeScript 前端构建后由 Cloudflare Worker 托管，名单存放在 Workers KV，页面、接口与静态资源由同一个 Worker 对外服务，无需常驻服务器或容器。

## 功能

- 支持高一、高二、高三名单查询：姓名、班级、年段自由组合（年段按数据目录实际存在的文件自动识别）
- 输入框支持空格 / 中文逗号 / 英文逗号 / 顿号分隔多条件
- 结果按完整、前缀、包含匹配排序，支持分页加载（全员果冻融合动效）
- 胶囊搜索框带彩色光束动画，搜索时思维球反馈
- 隐私设计：不写 localStorage，不把查询词写入 URL，API 只返回姓名 / 年级 / 班级

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19 + TypeScript + Vite |
| 运行时 | Cloudflare Workers（单 Worker 同时托管页面、接口与静态资源） |
| 存储 | Workers KV（`roster:{校名}` 一校一键，名单不进仓库） |
| 动效 | border-beam 1.4.1 / thinking-orbs 0.3.2 / liquid-gooey 0.2.2 |
| 字体 | Mona Sans / Instrument Sans / IBM Plex Mono |
| 测试 | Vitest（前端 + workerd 集成，双项目） |

## 本地开发

前置：Node.js 26。

```bash
# 1. 安装依赖
npm install

# 2. 构建前端（产物输出到 dist/）
npm run build

# 3. 启动本地 Worker（默认端口 8787）
npx wrangler dev --port 8787

# 4. 浏览器打开 http://localhost:8787
```

只想改前端样式时可 `npm run dev` 起 Vite（端口 5173），`/api` 请求会代理到本地 Worker 的 8787，因此仍需先起 `wrangler dev`。

本地名单：Worker 的 KV 在 `.wrangler/` 下本地模拟，新克隆的仓库里是空的。放一份 `data/*_roster.json` 后用管理 API 灌入：

```bash
# 本地管理 token 写在 .dev.vars（该文件不进仓库）
node scripts/upload-roster.mjs http://127.0.0.1:8787 <token> data
```

## 部署

部署形态是单个 Worker：`wrangler deploy` 一次上传脚本 + `dist/` 静态产物，没有 Docker、没有常驻进程。

### 首次准备

```bash
# 登录（或改用 CLOUDFLARE_API_TOKEN 环境变量给 CI 用）
npx wrangler login

# 管理端凭据：值为任意长随机串，只写进 Cloudflare，不进仓库
npx wrangler secret put ADMIN_TOKEN
```

`wrangler.jsonc` 里的 `kv_namespaces` 只声明 binding 名 `ROSTER`、不写 id：首次 `deploy` 时 wrangler 会按名字自动创建命名空间并把 id 回写到该文件。

### 部署与灌名单

```bash
# 上线（生产）
npx wrangler deploy

# 线上名单：管理 API 上传，一校一 PUT，写入后全站生效
node scripts/upload-roster.mjs https://<你的 Worker 域名> "$ADMIN_TOKEN" data
```

`/api/admin/roster` 是管理端点（`GET` 列表、`PUT` 上传、`DELETE` 删除），全部要求 `Authorization: Bearer <ADMIN_TOKEN>`。名单存 KV，写入后各边缘节点最多约 60 秒刷新，不是秒级生效。

### GitHub Actions

- `.github/workflows/ci.yml`：依赖源守卫 → 类型检查 → 构建 → 测试 → dry-run。
- `.github/workflows/deploy.yml`：打 `v*` tag 时部署，需要仓库 secrets `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`（或 `CF_ACCOUNT_ID`）、`ADMIN_TOKEN`。
- `.github/workflows/release.yml`：同一 tag 触发，按 CHANGELOG 生成 GitHub Release 记录。发布包不含二进制、镜像或名单数据。

`ADMIN_TOKEN` 的唯一事实源是仓库 secret：每次部署都会按它覆盖线上值，因此在 Cloudflare 控制台改这个 secret 会被下一次部署静默回退。

## 站点文案配置

页脚展示的内容（数据来源、运营团队）通过 `src/site.config.ts` 集中配置，无需改动业务代码：

```ts
const siteConfig = {
  /** 页脚：数据来源说明 */
  dataSource: "福清一中公示数据提取",
  /** 页脚：运营团队名称 */
  team: "福清一中信息社",
};
```

隐私说明里曾有一段「数据处理：福清一中信息社」，因与页脚的「运营团队」是同一串
文字、页面上等于同一个机构名说了两遍，已去掉。配置里的 `dataController` 字段留着，
目前不渲染——需要单独标注时改它即可。

## 数据格式

名单数据为 JSON 文件（**真实名单不随仓库发布**，部署时自行放置）。支持多学校：data/ 目录下每校一个 `*.json`，文件名不参与语义（可任意命名），学校身份取自文件内的 `校名` 字段。推荐使用 `build_hierarchy_json.py --no-credential` 导出的纯净名册（无账号密码、无 id 字段）结构如下：

```json
{
  "区县": "福清市",
  "学校": [{
    "校名": "福清一中",
    "年级": [{ "年级名": "高一", "班级": [{ "班名": "一班", "学生": [{ "姓名": "张三" }] }] }]
  }]
}
```

- 顶层仅 `区县` 与 `学校` 两个键；`学校` 为数组，每项含 `校名` 与 `年级`（数组）。
- 年级项含 `年级名` 与 `班级`（数组）；班级项含 `班名` 与 `学生`（数组）；学生仅 `姓名` 一个字段。
- 文件内可含多个学校、多个年级；跨文件校名重复会被拒绝加载。
- API 返回 `name/school/grade/class` 四个字段；学校下拉（`/api/schools`）只列出包含高中年级（高一~高三）的学校。
