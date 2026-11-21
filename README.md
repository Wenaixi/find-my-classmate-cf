# FindMyClassmate

> 校园学生档案检索台

FindMyClassmate 是一个面向校园场景的班级查询工具。React + TypeScript 前端构建后由 Cloudflare Worker 托管，名单存放在 Workers KV，页面、接口与静态资源由同一个 Worker 对外服务，无需常驻服务器或容器。

## 功能

- 支持高一、高二、高三名单查询：姓名、班级、年段自由组合（年段在名单里存在即可查，不必三份都有）
- 输入框支持空格 / 中文逗号 / 英文逗号 / 顿号分隔多条件
- 结果按完整、前缀、包含匹配排序，支持分页加载（结果容器带液体合并视觉）
- 胶囊搜索框带彩色光束动画，搜索时思维球反馈
- 隐私设计：不写 localStorage，不把查询词写入 URL，API 只返回姓名 / 学校 / 年级 / 班级

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19 + TypeScript + Vite |
| 运行时 | Cloudflare Workers（单 Worker 同时托管页面、接口与静态资源） |
| 存储 | Workers KV（`roster:{校名}` 一校一键，名单不进仓库） |
| 动效 | border-beam 1.4.1 / thinking-orbs 0.3.2 / liquid-gooey 0.2.2 |
| 字体 | Mona Sans / Instrument Sans / IBM Plex Mono |
| 测试 | Vitest（前端 + workerd 集成，双项目；25 文件 / 623 条） |

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
```

管理端凭据 `ADMIN_TOKEN` 的写入时机见下一节：**Worker 还不存在时 `secret put` 无法成功**，首次要跟 `--secrets-file` 一起部署。

`wrangler.jsonc` 里的 `kv_namespaces` 只声明 binding 名 `ROSTER`、不写 id——id 是账号内的资源标识，写死会把「哪个账号部署」绑进仓库。

**首次 `secret put` 不能排在部署之前。** `wrangler` 在 Worker 还不存在时无法给它写 secret（worker 不存在就没有可写 secret 的目标），官方给出的出路是 `--secrets-file`：

```bash
# 首次：用 --secrets-file 一并带上 secret，Worker 与 secret 在同一次部署里落地
# gen-secrets-file.mjs 从环境变量 ADMIN_TOKEN 取值，写成 0600 的 JSON 文件
ADMIN_TOKEN='<随机串>' node scripts/gen-secrets-file.mjs ./fmc-secrets.json
npx wrangler deploy --secrets-file ./fmc-secrets.json
rm ./fmc-secrets.json
```

Worker 已经存在之后，`npx wrangler secret put ADMIN_TOKEN` 才是可用的（日常轮换走 `deploy.yml` 注入，见下）。

首次部署**在本地跑** `npx wrangler deploy`，wrangler 会按 binding 名创建 KV namespace 并把 `id` 回写进 `wrangler.jsonc`，**把那一行 id 提交进仓库**。这样之后 CI 与本地读的是同一份显式事实。

若首次部署走 GitHub Actions 也可以跑通：资源同样会被创建，但 id 只出现在 dashboard，不会回写仓库，仓库里永远不会出现 id。官方文档的说法是「即便不把资源 id 加进配置文件，资源在后续部署之间仍保持关联」，所以不会每次新建 namespace；但 workers-sdk 有过「Builds 下自动供给非幂等」的 issue（#14284），本机 wrangler 4.163.0 是否已修复未验证。因此本地首发是更稳的那条路，也让「绑定指向哪个 namespace」在仓库里可查。

### 部署与灌名单

```bash
# 上线：首发在本地跑一次（把回写的 KV id 提交进仓库，见上），之后本地或打 tag
# 让 deploy.yml 跑，两条路等价——命令都是这一条
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
