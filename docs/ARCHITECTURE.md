# FindMyClassmate 架构指引

> 本文件是项目的唯一架构文档，描述稳定不变的逻辑骨架与契约。实现细节会演进，本文只记录不会过期的部分。改动架构时必须同步更新本文。
>
> 活文档按可过期速度分工：本文答「module 划分与接缝为什么是这样」，`CONTEXT.md` 管领域术语，`CLAUDE.md` 管纪律与历轮评审结论。同一事实只在一处说，其余位置指向它。

## 1. 总体形态

单个 Cloudflare Worker，一个部署单元：

- 前端：React + TypeScript + Vite，构建产物输出到 `dist/`
- Worker：`src/worker/index.ts` 是 `fetch` 入口，同时托管 `/api`、管理端点与页面
- 静态资源：`dist/` 挂成 Workers Assets binding（`env.ASSETS`），
  `wrangler.jsonc` 的 `run_worker_first` 为 `true`，所有请求先过 Worker
- 名单：Workers KV，一校一个 key（`roster:{校名}`）+ 一个索引 key（`roster:index`）

由此决定的三个边界：

1. **无常驻状态**。没有进程内缓存、没有跨请求可变字段、没有后台线程。限流计数、名单读取的一致性全部由平台组件决定，Worker 每次请求都可能落在不同的执行实例上。
2. **页面与 API 同源同域名**。静态资源由 Assets 服务，但请求仍穿过 Worker（否则安全头与限流只覆盖 API），见 §5。
3. **名单的可见性是最终一致**。KV 写入后各边缘位置各自按读缓存过期刷新，见 §8。

`run_worker_first` 必须是 `true` 而不是 `["/api/*"]`：白名单形态会让静态请求绕过 Worker，六条安全头、公共限流与访问日志同时失效。最直接的后果是 429 与 404 变成「只有 API 才有」的行为，而迁移前的全站契约是对所有响应生效。

## 2. 数据模型与隐私边界

名单源文件仍然是 `data/` 下上游 `build_hierarchy_json.py --no-credential` 输出的纯净名册（无账号密码、无 id 字段），上传时整份原文按字符串存进 KV。结构：

```json
{
  "区县": "福清市",
  "学校": [{
    "校名": "福清一中",
    "年级": [{
      "年级名": "高一",
      "班级": [{
        "班名": "一班",
        "学生": [{ "姓名": "张三" }]
      }]
    }]
  }]
}
```

KV 布局：

- `roster:index` → 学校名数组。它是唯一的事实源：index 里没有的学校不会被加载，即使 `roster:{校名}` 的 key 还留在 KV 里。
- `roster:{校名}` → 单校名单原文，本层不做任何改写。

加载与校验的语义（单一 owner 是 `src/shared/roster.ts` 的 `parseRosterDocument`）：

- 校名取自 JSON 内 `校名` 字段，`roster:index` 里的条目名只是 KV 键与错误文案的来源标识
- 跨文件校名重复直接拒绝（跨文件共享同一份 `RosterLoadState`）
- 年级、班级名来自 JSON 内容；班级名须可解析为正班号（阿拉伯或汉字数字）
- 剥离 UTF-8 BOM；校验结构完整、校名非空、年级名非空、班名可解析、学生姓名非空
- 去重键 = 学校 + 年段 + **班号** + 姓名匹配键，用 NUL 分隔。用班号而非班名，因为「1班」与「一班」是同一个班
- 类型错误与语义错误分两阶段判定，顺序与迁移前的 `json.Unmarshal` + `loadStudents` 同构；顺序本身是语义——同一份文件有多处错误时，最先到达的那处决定文案

领域形状 `RosterStudent`（`src/shared/student.ts`）比 wire 形状多四个派生字段：`nameKey`、`classNo`、`gradeIdx`、`schoolIdx`。派生字段在加载期一次算好，排序热路径直接读，不重复解析。

**隐私红线（不可破坏）**：

- 对外 API 只输出 `name`、`school`、`grade`、`class` 四个字段。TS 没有 `json:"-"`，所以这条靠 `handlers.ts` 的 `toWireStudent` 显式逐字段取值守住——不能解构后 spread，spread 会让将来新增的派生字段静默泄漏。
- 纯净名册源文件本身不含账号密码、schoolId/gradeId/classId。
- 前端不写 localStorage，不把查询词或结果写入 URL。
- 访问日志不记查询参数；客户端 IP 只保留前缀（IPv4 前两段、IPv6 前两组）。
- 真实名单不进 git：`data/*.json` 在 `.gitignore` 里，CI 另有零数据守卫（见 §11）。

## 3. 查询契约（解析与执行）

接口拆成两半，各有唯一 owner：

- **解析**：`src/shared/query.ts` 的 `parseQuery` 把输入解释成条件。前端也用它，`hasNameCondition` 供界面决定「纯年段/班级查询」提示。
- **执行**：`src/worker/search.ts` 的 `searchCore` 做匹配、排序、分页。前端零镜像。

解析契约：

- 分隔符：中文逗号、英文逗号、顿号、加号、连续空白，均视为 token 分隔
- 班级 token：阿拉伯数字或汉字数字（一~九十九，含十位组合如十一、二十、二十一），可带可省略「班」字
- 年段 token：`高一/高二/高三`、`高1/高2/高3` 为别名
- 姓名匹配键：删除与 Go `unicode.IsSpace` 相同的空白集合并统一大写。**空白集合必须逐码位枚举，不得用 JS 的 `\s` 近似**：两者的差集恰为两个码位且方向相反——U+0085（NEL）是 Go 的空白而 `\s` 不含；U+FEFF 自 Unicode 4.0.1 起不在 White_Space 内，Go 不认而 `\s` 认。用 `\s` 会在 U+FEFF 上静默分叉，而 `trim()` 还会削掉首尾的 U+FEFF。字符集 `goSpaceChars` 的单一 owner 在 `src/shared/classparse.ts`，三处用途（切分 `goSpaceSplit`、删空白 `goSpace`、首尾剥除 `goSpaceTrim`）全部由它派生。
- 超长数字串按姓名处理，不作为班级条件
- **年段值域是单点事实源**：`src/shared/grades.ts` 声明 `Grade` 联合、`gradeValues`、`gradeAliases`。年段派生有三个 owner——`splitGradeClass`（年级+班级连写切分，最长前缀）、`parseGradeInToken`（查询侧，精确匹配）、`gradeOrder`（声明序用于排序）。**扩展年段只改 `grades.ts` 一处**，`query.ts` 的遍历逻辑不用动。
  - 两个方向各由一处强制：正向（列表里的值必须属于 `Grade`）由 `as const satisfies readonly Grade[]` 承担；反向（`Grade` 联合里的值必须已在列表中声明）由同文件的 `gradeDomainExhaustive` 编译期检查承担，报错形态刻意把缺失项名字带出来（缺「高四」时退化为 `{ missing: "高四" }`），而不是让 `Exclude` 直接变 `never`。
  - 该检查落在生产代码而非测试文件：`tsconfig.app.json` 的 include 是 `src`，测试文件本来也在类型检查范围内，把约束放进测试文件会让它依赖「测试文件恰好被 tsc 检查」这个巧合——挪动 exclude 或换一个编译项目，它就静默失效了。
  - **查询侧与标题侧曾经是两个语义，现在只剩一个**。`parseGradeInTitle`（子串匹配，服务文件名与年级标题的一致性校验）随 Go 一起退役：KV 里没有文件名，校名是 index 里的一项，也没有「标题」可校验。因此名单加载不再反向依赖年段值域的标题匹配，前端也因此只消费 `parseGradeInToken` 一个精确语义。
  - 精确与子串不可合并的教训保留下来：二者曾共用一个子串实现，代价是含年段串的姓名（真实人名「高一鸣」）在查询侧被读成年段条件，姓名条件消失、一次精确检索被放大成整个年段的全量返回。语料里「高一同学」曾把该缺陷行为锁成期望值，修复时已改为按姓名处理并补 `$comment` 记录裁决。语料另有「高一班」作为纯年段对照组，防止该判断退化为「一律按姓名」。
- **分配纪律已退役**。迁移前有一条 `TestSearchAllocsBudget` 拦「把正则编译放进热路径」（实测整年段查询分配从 6 涨到 117）。Go 退役后预算测试一并消失，`splitGradeClass` 仍是遍历 `gradeValues` 与 `gradeAliases` 做最长前缀匹配、不编译正则，但这个约束现在只靠代码现状与注释，没有测试守着。新增解析逻辑时若引入正则编译，`npm test` 不会报警。

执行契约：

- 匹配规则：所有姓名 token 都必须包含匹配（AND 语义），年段精确匹配，班级按班号匹配，学校按校名精确匹配
- 排序四键且稳定：匹配分（完全 0 < 前缀 1 < 包含 2）→ 学校加载序 → 年段声明序 → 班级号升序，末键用输入索引保稳定。**多 token 时按各 token 的三态得分求和**（`nameScoreSum`）——总分衡量与全部查询词的总距离，不区分「一个 token 完全匹配 + 另一个勉强包含」与「两个 token 都只是包含」。这是有意的简化：求和把匹配质量压成可加标量，用户预期上等价于「越贴近查询词越靠前」，逐 token 比较需要一套词典序规则且难以向用户解释。
- 分页：`{ items, total, limit, offset, hasMore }`；limit 默认 10，上限 50。`searchCore` 自守分页前置约定：offset 归一到 `[0, 匹配条数]`，负 limit/offset 归零，越界按最近有效边界处理，调用方无需先行校验。负向钳制放在任何提前返回之前，空查询路径也不例外——否则响应会原样回显调用方传入的负值，自守就变成有条件的。

`searchCore` 之外还有一条**安全不变量**：任何让全部查询条件落空的输入都必须退化为空结果集，绝不能退化为全校检索。三个实例曾分别以不同形态出现——无法解析的班级 token（v0.9.1 修复前「一一班」返回全校 1047 条）、溢出的班级 token、纯分隔符输入（2026-09-26 修复，实测返回全校 2091 条）。当前由两处共同保证：

- 解析层：`classCondition` 收拢「无法解析/溢出 → 降级为姓名条件」的策略与理由，`parseQuery` 只表达「拿到什么条件」，不复述降级理由
- 执行层：`searchCore` 的判空依据是「解析后是否存在任何条件」而非「原始串剥空白后是否为空」。两者必须一致——`tokenize` 会把分隔符替换为空白，若判空只剥空白，纯分隔符输入既非空查询也无条件可施加

注意判空**不可**简化为 `nameTokens.length === 0`：契约语料中有相当一部分合法查询（高1 / 18班 / 六班 / 高二三班等）nameTokens 为空但带年段或班级条件。此处刻意不写具体条数——它在语料增删时必然漂移，语义由语料条目本身逐条守住；需要统计当前量级时读 `docs/query-contract.json` 的 cases 数组。

解析契约的**可执行事实源**是 `docs/query-contract.json`，消费方是两个 TS 测试：`src/shared/query.test.ts`（解析层）与 `src/worker/search.test.ts`（搜索层）。迁移期它同时被 Go 侧消费、两侧"对拍"；Go 退役后对拍关系不存在了，语料退回它本来的角色——**唯一权威**，不再是两份实现之间的中介。语料里的期望值当前以 TS 侧的实测结果为准。

## 4. 契约常量与共享声明的单一 owner

跨端共享的数值常量只有一处声明：`src/shared/contract.ts`。`src/config.ts` 只 re-export 并额外持有前端私有的 `REQUEST_TIMEOUT_MS`。

- 查询串 rune 上限：80（`MAX_QUERY_LENGTH`，`App.tsx` 输入框 `maxLength` 同值）
- 分页：limit 默认 10（`PAGE_SIZE`）、上限 50（`MAX_LIMIT`）
- 前端请求超时 10s（`REQUEST_TIMEOUT_MS`，仅前端消费）

**跨端对拍机制整体退役**。迁移前 `server/contract_constants_test.go` 读前端 `src/config.ts` 抽取字面量、断言与后端 `config.go` 一致，`contract_grade_test.go` 双向比较年段清单——这些 Go 侧测试的整个存在理由是「同一份事实在两个语言里各持一份」。现在两个消费者读的是同一份声明，对拍没有可对的两端。

取而代之的覆盖机制：

| 声明 | 位置 | 覆盖机制 |
| --- | --- | --- |
| 年段规范名值域 | `grades.ts` `gradeValues` + `Grade` | `satisfies` 正向 + `gradeDomainExhaustive` 反向，均在编译期 |
| 年段别名映射 | `grades.ts` `gradeAliases` | `satisfies readonly (readonly [string, Grade])[]`，指向未声明年段即编译报错 |
| 数值常量 | `contract.ts` | 单点声明，`config.ts` 只转发 |
| 汉字数字形态 | `classparse.ts` `chineseNumberPattern` | 由 `chineseDigitOnes` 派生；解析行为归契约语料 |
| 完整班号形态 | `classparse.ts` `classNumberPattern` / `classToken` | 由 `chineseNumberPattern` 派生 |
| 连写守门字符集 | `classparse.ts` `classHeadChars` / `classNumberHead` | 由 `chineseDigitOnes` 派生 |
| 空白集合 | `classparse.ts` `goSpaceChars` | 单点声明，三处用途全部派生；契约语料锁住两个差集码位 |
| 查询分隔符 | `query.ts` `separators` | 契约语料（形态有限，可穷举） |
| 解析算法本身 | `query.ts` / `classparse.ts` | `docs/query-contract.json` 逐条断言 |

**这张表也有结构性上限，而且单一 owner 之前它真的漏过东西。** `classNumberHead` 曾以「零对拍」形态留在表外：第十八轮变异实验把守门字符集里的「四」与「七」同时从两端删掉，Go 全量测试与前端全部用例零翻红——语料只在首字符为 `{0,1,2,三,十,一,9}` 的连写样本上取样，这七字恰好都不在被删集合内。**两端一致地错时，任何跨语言机制都表达不出来**（对拍与语料同时静默）。当时的结论是「唯一能拦住这种漂移的是单一 owner」，现在单一 owner 已是既成事实。

**现在删字会翻红，但覆盖强度不对称**（条数分两类来源：`删一 / 删五 / 改七 / 改十` 是我自己跑的，其余引自复审的逐值实测）：

- `classHeadChars` 的等式断言把它钉在 `"[0-9" + chineseDigitOnes + "十]"` 上，删任何一个字都会命中这条等式。
- **删字的实际翻红数分三档**：删「四」3 条（等式 + 守门直断 `classNumberHead.test("四")`/`("四班")` + 端到端 `parseQuery("高一四班")`）；我自跑删「一」翻红 **8 条**（3 条在 `classparse.test.ts`、语料 `query.test.ts` 与搜索层 `search.test.ts` 各若干，走的是语料样本那条路），删「五」翻红 **1 条**（只有等式）；删「十」零翻红——「十」是 `chineseNumberToInt` 里的字面分支（`runes[0] === "十"`），从不经 `chineseDigitOnes`。
- **值表 `classDigits` 的覆盖接近齐、不是接近空**：`classparse.test.ts` 的「一~九十九 与 十~十九 逐值映射」把每个单字与十位组合都枚举成直断，所以改值会翻红（复审逐值实测：二→8 十条、六→8 七条、八→9 六条、五→8 四条、九→8 与 四→8 各四条/两条；我自跑 七→6 是 **1 条**）。**但「十」这个表项是死项**：我自跑改「十」→5，`classparse.test.ts` 33 条全过、全量 614 条全过（**零翻红**），因为那条字面分支永远不读 `classDigits["十"]`。
- 因此真正没被覆盖的是两处具体形态，而不是「值表」这个整体：**「十」那一个死表项**，以及**「七」的值只有单条直断、没有端到端**（改「七」只翻红 1 条，删「七」也只翻红 1 条）。

想让某条回归可被发现，路径是加直断或语料样本；单一 owner 只能保证「只有一份声明」，不能保证「那份声明被检验过」。这一段本身踩过两轮、三次改写：第一版说「删四七零翻红」、第二版说「值表几乎无覆盖」，都是没跑变异就下的结论。

E2E 契约（错误码、分页响应结构、脱敏格式）在 §5.1 与 §10 声明。

## 5. 请求生命周期

链顺序（由外到内）：`securityHeaders → rateLimit → accessLog → mux`，由 `src/worker/index.ts` 的 `handler` 单点装配。三条由顺序推出的政策：

- **429 不写访问日志**：限流位于 accessLog 之外，被拒请求不进入日志层，避免攻击流量放大日志写入量。
- **429 仍带安全响应头**：`withSecurityHeaders` 在响应产生之后统一铺头，因此 429、404、401 与异常转换出的 500 全都带全站安全头，限流拒绝路径不必手工重放。安全头定义只有 `setSecurityHeaders` 一处（`middleware.ts`）。
- **管理端不走公共限流**：管理端是单管理员低频写入，每次都要过 Bearer 认证，再叠一层 IP 限流收益很小，却会让管理员在网络抖动时被自己的限流器挡住上传。除管理端外的一切请求都过限流，**包括 `/api/health`**——健康检查只跳过访问日志，不跳过限流。给 health 开一条免限流的口子，等于把最常被外部调用的路径留成无限频入口。
- **限流语义（与 Go 令牌桶不等价）**：平台 binding 是**每个 Cloudflare 边缘位置独立计数、近似限流**（后台异步同步），不是旧实现的全局平滑令牌桶——突发可能短暂超过阈值，且同一用户命中不同边缘位置时计数不互通。防御目标（防刷名单/爬虫）不受影响，但「精确的每 IP 均匀限速」不再成立。键取 `cf-connecting-ip`；缺失时给空串（所有无该头的请求共用一个桶）而非放行，否则伪造一个头即可整个绕过。这是「行为 + 纪律全保留」承诺下唯一的例外，理由与换算记录见 `docs/cloudflare-migration-design.md` §3.6 与项目记忆库「限流」条。

```
浏览器输入 → 前端 parseQuery（即时校验/提示）
  → GET /api/search?q=&school=&limit=&offset=
  → Worker：安全头 → 限流 → 路由 → 参数校验（limit 1-50、offset ≥0、q ≤80 字符）
  → 读 KV（index + 批量 roster）→ shared/roster 校验 → searchCore → 分页 JSON
  → toWireStudent 收窄四字段 → 前端校验响应结构 → 渲染
```

前端要点：

- 提交前用 AbortController 取消旧请求（防竞态）；竞态编排集中在 `searchSession.ts`（requestId + abort）
- 查询响应返回即渲染（无最短展示延迟），思维球反馈在 loading 期间稳定展示
- 首屏查询替换结果；加载更多只追加、不改变阅读位置
- **输入法组合期间 Enter 不提交、Escape 清空**：由 `useSearchInput` 统一收口。组合状态取自两个来源——`onKeyDown` 事件的 `nativeEvent.isComposing` 与控制器 state 的 `isComposing`，任一为真都不得提交。组件只透传回调，不手写组合判断。
- **状态与提示文案必须一致**：`input-change` 切到 `editing` 时同步刷新 `statusText`，否则会显示 editing 状态配上上一轮的错误或结果文案
- **只有查询词变化才作废在途请求**：`onChange` 触发 `invalidate()`；IME `composition-start/end` 不触发。组合开始不是「查询已过时」的信号，若在此作废请求且组合未产生输入变化，状态会卡在 loading 且提交按钮持续 disabled

### 5.1 错误契约

| 状态码 | 错误码 | 场景 |
| --- | --- | --- |
| 400 | invalid_limit | limit 非数字/越界（1-50） |
| 400 | invalid_offset | offset 非数字/负数 |
| 400 | invalid_query | q 或 school 超过 80 个字符（rune 计） |
| 404 | not_found | 未知 /api/* 路径；管理端点 DELETE 一个 index 里没有的学校 |
| 405 | method_not_allowed | 方法不匹配（带 `Allow` 头） |
| 429 | rate_limited | 限流（JSON + `Retry-After`） |
| 500 | data_unavailable | 名单读取失败或 KV 故障 |
| 503 | degraded | /api/health 数据不可用或部分不可见（`status=degraded`, `reason=data\|partial`, `version`） |

- 错误响应统一为 `{"error": "<code>"}`。管理端另有 `401 unauthorized`（带 `WWW-Authenticate: Bearer`）与 `400 invalid_roster`（带 `message`，文案逐字来自校验层）。这两个码刻意不进公共错误码表：公共端的错误码表是前端与排障手册共同依赖的契约，多一个只有管理端会发的码没有收益。
- 状态与错误码的映射唯一登记在 `src/worker/errors.ts` 的 `ERR_STATUS`。发射点只挑码，`writeError` 自己查表带出状态，未登记的码回落 500。调用点若自己索引这张表，漏写兜底就会把错误答成 200 + 空体。
- 空 q 返回 200 + 空分页（`{items:[], limit, offset}`）。只有学校没有其他条件时同样返回空结果，学校选择器只用于缩小范围。

## 6. 前端状态机

搜索区状态（SearchState）是 UI 的唯一事实来源：

`idle → editing → loading → success | duplicate | empty | error`

- 输入变化 → editing（**IME 组合期间只更新 query、保留原状态**：组合中的候选文字不是一次新的编辑意图）
- 提交 → loading（清空旧结果）
- 查询落定由单个 `submit-result` action 收编三分支，与 `load-more-result` 同形：
  成功 → success / duplicate / empty（按条数派生）；真实失败 → error（保留重试入口）；
  **作废（stale）→ editing**
- 清空（Escape / 清空按钮）→ 回到 idle

**作废分支不可省略**：组合期的输入变化会 `session.invalidate()` 作废在途请求，若 stale 无分支可走，state 永远停在 loading，而 submit 的守卫正是「loading 中不发起新请求」——形成死角：状态行显示「正在检索完整名单」、提交按钮禁用，按 Enter 没有任何反应。目标用户正是中文输入法人群。

结果区仅在非 idle/editing 状态渲染，滚动定位由 state 变化触发。
**loading 必须真的上屏**：hook 壳对 Promise 型动作分两段渲染（启动态 + 终态），缺前一段则整段请求期间零重渲染，加载界面成为不可达的死代码。

## 7. 前端模块边界

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| src/App.tsx | 页面组装；只消费查询控制器的 state/controller 两面与 `present` 展示派生，不理解 reducer/session、不手写组合判断 | 全部 |
| src/config.ts | 契约常量的前端入口，re-export `shared/contract.ts` 并持有 `REQUEST_TIMEOUT_MS` | shared/contract |
| src/od.ts | 测试锚点：源码保留 `data-od-id` 以让测试定位节点；生产构建由 vite 的 `__OD_ID__` 常量折叠为 `() => ({})`，展开后该属性在产物中完全不存在（不是「值为空」，是键不存在） | 无 |
| src/types.ts | 领域类型与状态枚举；`Grade` 与 `ParsedQuery` 只 re-export 自 shared | shared/grades, shared/query |
| src/lib/api.ts | 网络适配与响应结构校验（`decodeItem` 只认 canonical class 单字段） | types, config |
| src/lib/searchReducer.ts | 搜索状态机纯 reducer（状态派生/错误文案/纯年段与班级整段命中提示/`present` 展示派生含错误区段文案切分） | types, api, shared/query（hasNameCondition）, resultSummary, searchSession, config |
| src/lib/searchSession.ts | 请求竞态编排（requestId + abort）；竞态骨架由私有 `perform` 单点承载，submit/loadMore 只差 id 来源与 offset | types |
| src/lib/useSearchController.ts | 查询控制器深模块（`createSearchOrchestrator` 纯逻辑 + hook 壳），state + controller 两面消费。**hook 壳对 Promise 型动作分两段渲染** | types, searchReducer, searchSession |
| src/lib/useSearchInput.ts | 交互语义（IME 组合守卫、Enter 提交、Escape 清空）；组合状态取自两个来源，任一为真都不得提交 | useSearchController |
| src/lib/resultSummary.ts | 结果摘要单点派生（进度/计数/剩余文案） | 无 |
| src/lib/testActEnv.ts | 挂载测试的 act 环境开关 | 无 |
| src/site.config.ts | 站点展示文案（数据来源/运营团队；`dataController` 保留但当前不渲染） | 无 |
| src/components/ | 展示组件：ResultList / SchoolPicker / StatusOrb / ErrorBoundary | types |

查询解析不在前端模块表里——它在 `src/shared/query.ts`，前端与 Worker 共用同一份实现，见 §8。

**展示派生单点（`present`）**：`present(state)` 一次性折出视图需要的全部派生——结果区段（`section`）、是否滚动（`scroll`）、提交禁用（`busy`）、按钮标签（`sendLabel`）、提示色（`tone`）、是否渲染加载指示（`showOrb`）。`App.tsx` 只按返回值选择 JSX 与属性，不再自己判断状态。

归位前组件须分别 import `resultSectionOf` / `shouldScrollToResults` / `deriveStatusHint` 三个派生并另调控制器取 state，界面知识横跨两个模块；既有测试分别打三个函数，**没有任何断言锁住它们对同一状态给出一致的组合**。收成一次派生后，一致性成为该接缝上可直接断言的事实——这才是归位解决的真问题（不是代码重复）。变异验证：滚动判定改坏 3 条断言翻红，提示色恒定值 1 条翻红。

**状态派生归位 reducer**：`submit-success` 载荷为 `{ items, total, hasMore, query }`，`submit-error` 为 `{ cause }`；`state` 与 `statusText` 由 reducer 内部依 `getState`/`statusTextFor`/`hasNameCondition`/`errorMessage` 算出。调用点只提供原始事实，派生规则因此可被直接测试。

动效依赖（border-beam / thinking-orbs / liquid-gooey）全部是表现层，不承载逻辑；若替换，禁止改变查询与状态语义。

## 8. Worker 模块边界

`src/shared/` 是前端与 Worker 共用的纯逻辑层，不含任何平台绑定：

| 模块 | 职责 |
| --- | --- |
| shared/grades.ts | `Grade` 联合、`gradeValues`、`gradeAliases` 与双向完整性检查；年段值域的唯一声明处 |
| shared/classparse.ts | 班级解析基础设施（班名 → 班号三态）、`goSpaceChars` 空白集合、`trimGoSpace`、`normalizeName`、`classCondition` 降级策略 |
| shared/query.ts | 查询解释：`tokenize`、`splitGradeClass`、`parseGradeInToken`、`parseQuery`、`hasNameCondition` |
| shared/contract.ts | 跨端数值常量（PAGE_SIZE / MAX_LIMIT / MAX_QUERY_LENGTH） |
| shared/student.ts | `RosterStudent` 领域形状、`newStudentSchool` 构造入口、`gradeOrder`、`schoolSortKey` |
| shared/roster.ts | 名单加载守门：`parseRosterDocument`、`parseSingleDocument`、`newRosterLoadState`、`errNoRosterMessage` |

`src/worker/` 是平台层：

| 模块 | 职责 |
| --- | --- |
| worker/index.ts | 装配层：链顺序单点（`handler`）、`Env` 绑定声明、限流判定 `checkRateLimit`/`clientKey`、安全头后处理与静态缓存头 `withSecurityHeaders`、路由分派 `dispatch`、错误边界 `asResponse` |
| worker/middleware.ts | 横切关注点：`setSecurityHeaders`（安全头唯一事实源）、`accessLog`（访问日志，跳过 health）、`clientIP`/`maskedIP`（IP 归一与脱敏） |
| worker/handlers.ts | HTTP 翻译：`healthHandler`/`searchHandler`/`schoolsHandler`/`notFoundHandler`；`toWireStudent` 是隐私红线的唯一关口 |
| worker/admin.ts | 管理端点：`verifyBearer` 恒时比较、`isAdminPath`、集合与单项路径的方法分派、错误分类 |
| worker/rosterStore.ts | KV 存储层：`loadAll`/`listSchools`/`putRoster`/`deleteRoster`、校名归一与键名限制 |
| worker/search.ts | 查询执行：`searchCore` 的匹配、排序、分页；`Search` 与 `SearchInSchool` 两个入口只差有无学校过滤 |
| worker/schools.ts | 学校下拉派生 `schoolList`：只列至少有一名高中生的学校，顺序按加载序 |
| worker/errors.ts | `ERR_CODES`/`ERR_STATUS`/`writeJSON`/`writeError`/`ApiException`；错误体与状态映射的唯一登记处 |

依赖方向单向：生产模块里 `shared/` 不 import `worker/`，`worker/` 不互相实现对方的职责。`classparse → query → classparse` 这种循环依赖已用「归一化函数定义在 classparse、由 query re-export」消掉。**测试例外**：`shared/roster.test.ts` 会 import `../worker/schools`（用 `schoolList` 校验「小学不入下拉」这条边界），这类测试侧的跨层 import 是刻意的——它断言的是两层之间的一致性，收在任一层里都看不到另一层。

**热更新语义（KV 最终一致，不再是文件探测）**：迁移前是「写文件即生效，1 秒节流探测 + 2 秒失败冷却 + 读写锁」，那套机制随进程内数据视图一起消失。现在：

- 每次请求都读 KV，不引入模块级缓存与版本 key。名单约 400KB，`cacheTtl: 60` 已把冷读摊薄。
- `cacheTtl: 60` 是每个边缘位置各自的读缓存。写入后同一位置立刻可见（读自己的写），**其他位置最多约 60 秒**才刷新。这是「1 秒内生效」→「最多约 60 秒生效」的确定变化。
- 一校读不到（`null`）时跳过该校、其余照常服务，而不是整批 503：读缓存扩散有窗口，把「某校此刻还没扩散到」等同于「数据坏了」会让一次正常写入触发全站降级。跳过发生在分配 `SchoolIdx` 之前，因此下次该校数据就绪时顺序与「从未跳过」一致。
- 全部读不到仍然 fail-closed，抛 `errNoRosterMessage`。它描述的是管理员该做的动作，而不是数据存在的位置。
- `roster:index` 的读-改-写没有跨请求互斥，两个并发写者会各写一份 index、后者覆盖先者，丢掉对方的新增项。窗口被 `cacheTtl` 放大到约一个缓存周期。要强一致得把写入收进一个 Durable Object 串行化——当前是单管理员低频写入，不做。丢的只是 index 里的一行，重传即可补回。

**健康检查语义**（`/api/health`）：进程存活 + 数据可用性。判据不是「有没有加载到任何一份名单」，而是「`roster:index` 声明的每一所学校本次是否都读到了」。

- `200 {status:"ok", version}` — 声明集合全读到了
- `503 {status:"degraded", reason:"partial", version}` — 差集非空，有学校此刻不可见。这个窗口是 KV 写扩散的必然产物；答 ok 就等于向编排层声称一份不完整的名单完整可用，而这正是「静默少一所」的不可观测形态。
- `503 {status:"degraded", reason:"data", version}` — 一所都不可用，或 index 内容损坏读不出来，或 `loadAll` 抛错。`partial` 与 `data` 分开是因为处置动作不同：前者等缓存扩散或查写入，后者查上传。
- 503 也带 `version`，否则降级响应在编排层与日志里无法指认部署。`version` 来自 `VERSION` 环境变量（`wrangler.jsonc` 的 vars 是本地默认 `dev`，部署时 `--var VERSION:<tag>` 覆盖）。

**CPU 10ms 边界**：免费层每次调用 10ms CPU，付费层 30s。KV 读是网络等待、不计 CPU；实际计算是 400KB 的 `JSON.parse` 配全量匹配过滤，量级在数毫秒。留有余量但没有余量监测——平台只在超限时给错误，本地与 CI 都测不出。若实测逼近上限，升级路径是先加模块级缓存 + `roster:version` 版本 key（也是唯一能压掉「每请求重复 parse」的手段），仍超限再考虑付费层。这条升级路径刻意没有提前实现：模块级缓存会让「上传后多久可见」变成两段不可预期延迟的叠加。

## 9. 部署与发布约定

- **无进程内状态**：限流计数由 Workers Rate Limiting binding 承担、名单在 KV，Worker 实例不持有任何跨请求状态，因此多副本横向扩展没有语义障碍（这与迁移前「单实例边界」相反）。
- 本地：`npm run build` → `npx wrangler dev --port 8787`。`npm run dev` 起 Vite（5173），`/api` 代理到 8787。
- 部署：`npx wrangler deploy`，一次上传脚本 + `dist/`。没有 Docker、没有常驻进程。
- **首次部署在本机跑**：`kv_namespaces` 只声明 binding 名 `ROSTER`、不写 id（id 是账号内资源标识，写死会把「哪个账号部署」绑进仓库）。本机跑 `wrangler deploy` 会按 binding 名创建 namespace 并把 id 回写进 `wrangler.jsonc`，把那一行提交进仓库，之后 CI 与本地读同一份显式事实。走 CI 首次部署也能跑通，但 id 只留在 dashboard。
- `assets.directory` 是 `./dist`，与 `vite.config.ts` 的 `build.outDir` 必须同名（`wrangler-config.test.ts` 有一条用例把这两个字段钉在一起）。
- CI（`.github/workflows/ci.yml`）：依赖源守卫 → `npm audit --audit-level=high` → typecheck → **build** → test → 两个脚本的 `--self-test` → `wrangler deploy --dry-run`。**build 必须早于 test**：worker 集成测试从 `dist` 的真实产物里取哈希路径（`firstAssetPath()` / `firstFontPath()`），而 `dist` 在 `.gitignore` 里、`npm ci` 不产出它——顺序反了会红 5 条，失败信息看起来像「静态资源分支坏了」。
- 部署（`deploy.yml`）：`v*` tag 触发，`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`（兼容 `CF_ACCOUNT_ID`）走 secrets，`ADMIN_TOKEN` 经 `scripts/gen-secrets-file.mjs` 生成临时 JSON 传给 `--secrets-file`。用普通文件而不是进程替换：wrangler 用 `path.resolve` + `readFileSync` 读它。
- 发布（`release.yml`）：同一 tag 触发，按 CHANGELOG 生成 GitHub Release。**tag 与 CHANGELOG 的 `## [` 行首精确匹配，匹配不到 exit 1**——用子串包含会让 `v0.1` 命中 `## [v0.10.4]`。发布包不含二进制、镜像或名单数据。
- `ADMIN_TOKEN` 的唯一事实源是仓库 secret。每次部署都会按它覆盖线上值，**在 Cloudflare 控制台改这个 secret 会被下一次部署静默回退**，且没有任何信号——看起来像「token 失效」而不是「被部署覆盖」。

## 10. 记录与可观测性

没有启动自举这一步：Worker 没有 main、没有目录创建、没有「数据目录为空就退出」的守卫（KV 为空时是 `/api/health` 答 503 + 管理端点答空列表，而不是拒绝启动）。

日志约定：

- 写 `console.log` / `console.error`，由平台收集，没有文件、没有轮转、没有分级开关。迁移前的 `FMC_LOG_LEVEL` 与日志文件双写已退役。
- 访问日志：每个请求记录「方法 路径 状态 耗时 脱敏 IP」。`/api/health` 不记——探针每 30s 一次，记它是每天近三千行噪音。该守卫在 `accessLog` 内部，横切层自己负责，不指望装配层记得。
- **查询参数永不入日志**（隐私红线）。路径取 URL 的 `pathname`，不带查询串。
- IP 脱敏规则：IPv4 保留前两段（`a.b.*.*`），IPv6 保留前两组（`a:b:::*`），归一失败的畸形输入一律 `unknown`。归一失败绝不把疑似端口漏进日志。IPv4 字面量拒绝前导零，与 `net.ParseIP` 同判——否则同一地址会得到「脱敏」与「unknown」两种形态。
- 耗时格式照搬 `time.Duration.String()` 的形态（`0s` / `Nms` / `N.s`）：为的是历史日志能直接对比，不是为了美观。**一处已知偏离**：`formatDuration` 满 60 秒写 `60s`，而 Go 会写 `1m0s`。代码里有 `ponytail:` 标注说明取舍——单请求超过一分钟属于该单独排查的异常，两者指向同一事实；真要机器对拍这段日志时补分钟分支。
- 异常边界：`asResponse` 把未预期异常一律转 500 `internal_error`，**异常文本只进日志、绝不进响应体**——平台异常里常有上游细节，外泄就是信息泄露。`ApiException` 分支是**预留通道，当前生产代码无抛出点**（三条公共 handler 与管理端都直接 `return Response`），留着是为了将来新增抛出点不必同时改装配层。

## 11. 测试策略

双项目 Vitest（`vitest.config.ts` 的 `test.projects`），当前 25 个测试文件、623 条用例：

- **frontend 项目**（node，需 DOM 的文件头声明 `@vitest-environment jsdom`）：查询契约（`shared/query.test.ts`）、班级解析（`shared/classparse.test.ts`）、年段值域（`shared/grades.test.ts`）、名单加载（`shared/roster.test.ts`）、学生模型（`shared/student.test.ts`）、搜索语义与语料（`worker/search.test.ts`）、状态机、竞态编排、交互语义、页面装配、组件渲染、学校选择器键盘可达性（`components/SchoolPicker.test.tsx`）、测试锚点折叠（`od.test.ts`）。
- **worker 项目**（`@cloudflare/vitest-plugin`，workerd + miniflare KV/限流绑定）：只收 `src/worker/index.test.ts`，跑真实装配链、静态资源回退、管理端点认证与写入、`SELF.fetch` 的端点集成。入口与绑定全部从 `wrangler.jsonc` 读，因此测试 env 与真实部署同源；`ADMIN_TOKEN` 走 miniflare 覆盖而非写进配置文件。

分项目的理由不是环境好玩，而是两类测试的运行时要求不兼容：Node 里没有 `cloudflare:test`，workerd 里没有 jsdom。用 `projects` 而不是两份 config + 两个脚本，因为「哪个测试归哪个项目」只有一处事实源，漏跑一个项目正是这种结构最需要防的失误（`include` 划分是硬约束，`src/worker/index.test.ts` 必须从前端项目里显式排除，否则同一条测试被跑两遍、前端那份报模块缺失）。

- 纯逻辑测试默认 node 环境，需要 DOM 的用文件头 `@vitest-environment jsdom`；挂载测试须置 `IS_REACT_ACT_ENVIRONMENT=true`，否则 `act()` 的更新不会 flush，会读到假阴性的旧快照。该开关集中在 `src/lib/testActEnv.ts`。
- **变异实验仍是断言有效性的唯一判据**：破坏实现后测试必须翻红，否则该测试不承重。已用此法剔除过零承重的推测性防御（`useSearchInput` 的本地 composing ref）与恒不发作的编译期检查（`classDigits` 的键集检查：`Object.fromEntries` 把键类型拓宽成 `string`，`Exclude<X, string>` 对任何 X 都是 `never`，实测把值表整个换掉 `tsc -b` 仍 CLEAN）。
- Go 的 `go clean -testcache` + `-count=1` 在 vitest 下没有对应物（没有测试结果缓存）。等效纪律是**改坏实现后跑全量 `npm test`**，不挑文件——挑着跑会漏掉间接消费者，而「只有它的消费者会翻红」恰恰是要观察的东西。
- 编译期检查的承重判据与运行时不同：它靠「故意改坏那一处声明、看 `npm run typecheck` 报不报」。`npx tsc --noEmit` 不检查任何东西，类型检查只用 `npm run typecheck`（`tsc -b` + worker 项目）。
- 测试 fixture 的外部 seam：需要模拟名单变化时直接构造 `RosterKV` 的内存 fake（`RosterKV` 接口刻意不引用 `KVNamespace` 类型，就是为了能在 node 里注入），不得从 `RosterStore` 私有字段反向读取。
- CI 数据边界守卫：校验真实名单不随仓库分发（`data/*.json` 零数据检查）。名单结构与字段白名单由 `src/shared/roster.test.ts` 与 `src/worker/rosterStore.test.ts` 以合成 fixture 覆盖，CI 不重复——仓库内本就不存在名单数据，无可校验。

**真实数据的数值基线不在仓库里。** 迁移期做过一次逐字段对拍：三份真实名单共 7088 名学生，26 条查询（纯分隔符、降级样本、年段连写、校名过滤、真实姓名、分页边界、超长查询、错误路径）在旧 Go 服务与 Worker 上逐字段完全一致，并另造一次单字段变异验证比较器真能抓差异。那次的结论只写在迁移工作区的未入库目录 `.superpowers/sdd/2026-11-15-cloudflare-migration/task-15-report.md`——**故意不入库**，因为报告里有真实姓名与查询命中数，属于隐私红线范围。因此「7088 / 26 条」这条基线**没有任何可执行断言守着**；半年后若要重验，先从存有该报告的本地迁移工作区取回报告（克隆内没有），按 `task-15-report.md` 复制名单、再按同一份查询集重跑。`scripts/upload-roster.mjs` 的 `--self-test` 与校内部署实测是目前仅有的真实形态把关。

写在这里的只有「三份名单、7088 人、26 条查询」这三个量，没有再写校名：校名本身在 README 的示例数据与 `src/site.config.ts` 的页脚文案里已公开（那是站点运营信息，不是名单内容），不算新增暴露；姓名与各查询的命中条数留在报告里，这才是不入库的理由。

## 12. 演进原则

- **单一 owner 优先**：同一份事实只声明一处，其余位置派生或 re-export。迁移前那套「两份声明 + 跨语言对拍」已经证明对「两端一致地错」结构性失明；现在的代价是单一 owner 写错就全错，所以每次收编都要配一条能翻红的断言。
- **隐私优先**：任何新字段、新存储、新接口都要过隐私红线检查。`toWireStudent` 是唯一关口，新增字段必须显式决定是否外泄。
- **无常驻状态**：不引入模块级缓存、不求跨请求可变状态。需要强一致时用 Durable Object 串行化，而不是在 Worker 里加锁。
- **活文档按可过期速度分工，不按主题切**：本文只答「module 划分与接缝为什么是这样」，领域术语在 `CONTEXT.md`（更慢变），纪律与历轮评审结论在 `CLAUDE.md`（最快变）。同一事实只在一处存在，其余位置指向它——三处各写一遍时，失真会自我复制。
- **`CLAUDE.md` 不入库**（`.gitignore` 排除，随克隆不携带）：它是项目记忆与本机工作副本，承载退役纪律的逐条原因、单一 owner 的上限、`gradeDomainExhaustive` 为什么必须在生产代码里这类判断。**关键决策在本文与 `CHANGELOG.md` 里有等价记录**——本文管结构与接缝理由，CHANGELOG 管「改了什么、为什么改」；读本文时不需要 `CLAUDE.md` 才能上手。唯一只存在于那份文件里的是历轮评审的定案摘要，它是方法论档案，不是操作依据。
- **文档不得描述不存在的能力**：声称某校验、某测试、某防线存在而实际没有，比不写更危险。这一条在本仓已经踩过两次（`classDigits` 的恒不发作检查、本期 ARCHITECTURE 的 11 节照做即失败的活指令）。

架构决策记录（ADR）存放于 `docs/adr/`，记录「已评估但未采纳」的方案及其重启条件，避免后续架构评审重复提议同一项。当前：

- ADR-0001：`RosterStudent` 不拆分为内部模型与 wire DTO。迁移前该决策的证据是 `json:"-"` 标签加 `TestSearchResponseKeys` 逐字段断言；迁移后 TS 没有标签机制，隐私由 `toWireStudent` 的显式取值守住，ADR 记录的重启条件（「标签被证明不足以约束新增字段」）因此已经部分成立——真要重开时请按新架构重新论证，不要引用旧代码位置（它们已不存在）。
