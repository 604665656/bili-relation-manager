## v2.4.1 修复二维码登录 405（紧急修复）

用户实测反馈：应用内「二维码扫码登录」弹窗报「生成失败：生成二维码失败（HTTP 405）」，点刷新/扫码均无响应。

### 根因
B 站 `x/passport-login/web/qrcode/generate` 与 `x/passport-login/web/qrcode/poll` 两个接口**只接受 GET**（权威文档 bilibili-API-collect 明确标注「请求方式:GET」）。原实现误用 `POST`，服务端直接返回 `405 Method Not Allowed`，导致二维码根本生成不出来；poll 也同样是 POST，即便生成成功，扫码确认阶段也会 405 失败。

### 修复
- `src/auth.js`：`generateQr` 改为 `GET`；`pollQr` 改为 `GET` 并通过 `qrcode_key` 查询参数传递；`fetchRequest` 新增 `query` 参数支持（仅 GET 拼 URL）。
- `renderer/app.js`：账号卡「续期」按钮点击不再误触发整卡重渲染（避免事件竞争），点击续期更稳。
- `test/auth.js`：新增 2 条断言锁定「generateQr/pollQr 必须用 GET」，防止回归。

### 验证
- 实弹真实网络调用：`generateQr()` 返回 `ok:true` + 合法 PNG `dataUrl`；`pollQr()` 正确返回 `waiting`（未扫码）。
- 单测 **175 项全绿**（原 173 + 2 条 GET 断言）。

## v2.4.0 竞品借鉴升级 · 死粉三段细分 · 文件级同步 · 风控面板化 · 四段式护栏

承接你「同类/同风格竞品穷尽对比、借鉴升级」的诉求，对市面同类产品（BilibiliFollowManage、bilibili-following-manager、kkmx/bili-follow-manager、wuko233/bili-follow-cleaner、CKylinMC FoMan，及 X 生态 XUnfollow / Superpowers for X / FRAOTIAC 等）做了系统拆解，把最值得借鉴的能力落到 brm：

### 1. 死粉三段细分（P0-A，借鉴 bilibili-following-manager 思路）
- 画像/活跃度分析后，在「活跃 / 偶尔」之上，把「值得清的沉默号」再拆成有决策意义的桶：**已注销/不可关注 · 内容变质(曾高产停更) · 停更(低产沉寂) · 沉寂临界 · 偶尔 · 活跃 · 从未投稿**。
- 顶部新增「死粉分段」筛选下拉，配合「分析画像/活跃度」即可按段秒筛（如只取关「停更」与「内容变质」）。
- 修复 `classifySegment` 原 `dormant(沉寂临界)` 阈值不可达的缺陷：改用 `SEG_DORMANT_MAX_DAYS=540` 天作为「临界/停更」分界，三段均可命中。
- 纯逻辑 `classifySegment` / `attachSegments` 已单测覆盖全部分段。

### 2. 四段式护栏 + 具名确认 + 强制 CSV 备份闸门（P0-B）
- 复用 kkmx「先出报告再执行」与 X 系「执行前强制备份」哲学：取关前先自动把「待操作名单」导出本地 CSV 备份（BOM 便于 Excel），再执行真实取关；备份路径回传界面提示。
- 确认弹窗升级为**具名表格**（昵称/UID/关系/活跃度/死粉分段），并明确提示「演示模式」「执行前备份」两种状态，让用户做的是决策而非盲点。

### 3. 风控参数面板化（P0-C，借鉴 wuko233 默认保守哲学）
- 账号配置新增 5 项默认保守、危险默认关闭的护栏：`sessionCap`(单次批量上限)、`skipRecentFollowDays`(最近关注豁免)、`autoWhitelistMutual`、`autoWhitelistSpecial`、`backupBeforeUnfollow`。
- 批量取关面板新增「本次上限 N 人」「最近关注 ≤ N 天保护」两个输入；`loadFollowings` 现从接口 `mtime` 计算 `followDays`，使「最近关注豁免」真正生效。

### 4. 文件级同步语义 · 集合求差（P1-D，借鉴 BilibiliFollowManage「从文件同步」）
- 新增「文件级同步」面板：把「当前关注」与「目标关注集(MID,昵称)」做集合求差 → 多余的取关、缺失的补关注。
- 新增 IPC `unfollow:syncPlan`（求差）/`unfollow:followBatch`（补关注，与取关对称）/`unfollow:exportBackup`（显式备份）；纯函数 `diffFollowLists` 已单测覆盖。

### 5. 演示/预览模式增强（P1-E）
- 批量取关的「演示模式」现在走真实预览：主进程逐条计算「将取关/跳过」并生成具名计划、导出预览备份，但**不发送任何真实请求**；界面与进度回调均标注「预览」。

### 6. 活跃度置顶陷阱修复（P1-F）
- `recentVideo` 现取「前 N 条投稿的最大 pubdate」而非 `list[0]`，规避 B 站把很旧的**置顶视频**顶在最前导致的「误判为近期活跃」。新增 `test/bilibili-archive.js` 用 mock 验证。

### 7. 平台适配器抽象（P2-G）与关系图谱数据模型（P2-H）
- 新增 `src/platforms/`：统一 `RelationAdapter` 接口（nav/followings/followers/modify/profile/recentPosts）+ 注册表，B 站已实现适配器包装既有 `BiliClient`；微博/抖音/小红书仅留**合规预留挂载点，不接入真实第三方**（不碰云端代登录/凭据托管）。
- `store.js` 新增 `relationGraph` 字段，为「超越待删列表的关系画像视图」奠基。

### 工程
- `main.js`：`unfollow:batch` 增强（previewOnly/sessionCap/skipRecentFollowDays/autoSpecial + `_batchSkipReason` + `writeUnfollowBackup`）；`unfollow:enrich` 算 segment；新增 `unfollow:exportBackup`/`unfollow:followBatch`/`unfollow:syncPlan`；注册平台适配器。
- `preload.js`：透传新参数 + 暴露 3 个新 API。
- `renderer/`：`index.html` 加死粉分段下拉、演示模式、导出备份、文件同步面板、本次上限/最近关注保护；`app.js` 接线全部新交互与预览回执；`styles.css` 加分段配色/同步面板/消息条样式。
- 测试 **173 项全绿**（新增 `test/bilibili-archive.js` 3 项；`test/batch.js` 扩充 12 项 classifySegment / diffFollowLists）。

## v2.3.0 多方式登录 · 官方API二维码扫码 · refresh_token自动续期

针对你「穷尽所有方式、也查一下开源有没有更合适的方案」的诉求，把登录/会话恢复做到极致，并对照 bilibili-API-collect、BiliTools、@renmu/bili-api 等开源方案取证取舍。

### 1. 官方 passport API 应用内二维码扫码登录（新增，更稳）
- 新增「**二维码扫码登录**」按钮：主进程直接调官方 `/x/passport-login/web/qrcode/generate`（返回 `qrcode_key` + `url`）→ 用 `qrcode` 包把 `url` 生成 PNG `data:` URL，渲染层 `<img src=dataURL>` 内联显示，**不依赖 Electron cookie 罐、不写临时文件**，打包后更稳。
- 轮询 `/x/passport-login/web/qrcode/poll`，状态：`86101` 未扫码 / `86090` 已扫码待确认 / `86038` 过期 / `0` 成功；成功时 `data.cookie_info.cookies` 给出完整 cookie 列表 + `data.refresh_token`，一并落库。
- 开源取证：bilibili-API-collect 与 BiliTools 均以该接口作为首选登录方式；相对 Electron BrowserWindow 弹窗扫码，应用内 API 扫码不依赖窗口/存储隔离，失败面更小。

### 2. refresh_token 免扫码续期（新增）
- 账号列表每个账号新增「**续期**」按钮 + 启动自动恢复编排：登录态失效（`nav.code!==0`）但存在 `refresh_token` 时，免重新扫码刷新登录态。
- 续期链路（与 B 站官方一致）：`GET /x/passport-login/web/cookie/info` 判 `refresh` → 用 B 站官方 **RSA 公钥**对 `refresh_{时间戳}` 做 **RSA-OAEP(SHA-256)** 加密得 `correspondPath` → `GET https://www.bilibili.com/correspond/1/{path}` 解析 `<div id="1-name">` 取 `refresh_csrf` → `POST /x/passport-login/web/cookie/refresh`（新 cookie 在 Set-Cookie 返回）→ `POST /x/passport-login/web/confirm/refresh` 失效旧 token。
- 开源取证：@renmu/bili-api 等库用相同 RSA-OAEP 方案续期；密码/短信登录在各开源库中普遍被风控拒绝（BiliTools 文档明确「密码登录因风控暂不可用」），故不做。

### 3. Cookie 导入加固 + 启动自动恢复编排
- 手动导入 Cookie 增加格式/必填字段校验与落库兜底，导入即 `nav` 校验有效性。
- 应用启动（whenReady 后约 2.5s）遍历账号：登录态失效且存在 refresh_token 则自动续期，成功静默落库（`sendLog('ok',...)`），失败计数并提示重登；最后 `bus:account` 刷新界面。

### 工程
- 新增 `src/auth.js`：纯 Node 登录协议模块（generateQr / pollQr / getCorrespondPath / parseRefreshCsrf / refreshCookie），所有 HTTP 走内部 `fetchRequest` 便于单测打桩；内嵌 B 站官方 RSA 公钥（PEM）。
- `src/store.js`：`_normalize` / `load` / `flush` 增加 `refreshToken` 字段，与 cookie 同密级加解密。
- `main.js`：新增 IPC `account:qrStart / qrPoll / qrCancel / refreshToken`；启动自动恢复编排；`BUILD_TAG` 升 v2.3.0。
- `preload.js`：暴露 `qrStart / qrPoll / qrCancel / refreshToken`。
- `renderer/`：`index.html` 顶栏新增「二维码扫码登录」按钮 + 二维码弹窗；`app.js` 接线扫码轮询循环、刷新/取消、账号续期按钮事件委托；`styles.css` 新增弹窗与续期按钮样式。
- `package.json`：version → 2.3.0，新增生产依赖 `qrcode@^1.5.4`，test 追加 `node test/auth.js`。
- 测试 **158 项全绿**（新增 `test/auth.js` 11 项：RSA-OAEP 输出格式、refresh_csrf 解析、Set-Cookie 解析、generateQr 返回 dataURL、pollQr 三状态 + 成功返回、refreshCookie 缺 token/refresh=false/完整流程/解析失败、store 加解密 refreshToken）。

## v2.2.3 三搜索路径可用化 · 公开搜索免登录 · 核对关注状态

针对你「都试试」的诉求，把批量取关的三种找人方式都做扎实；并先厘清一个关键事实：**本机 5 个账号的 cookie 全部 `nav=-101` 过期**，所以当前「搜索/载入/取关都不行」的根因是会话失效（不是布局 bug，那个 v2.2.2 已修；也不是搜索接口坏了，公开搜索本身是通的）。

### 1. 放开搜索的 nav 卡口（公开搜索不再被过期 cookie 拦死）
- 搜索走的是 B 站**公开**接口 `/x/web-interface/search/type`，本不需要登录。原 `unfollow:search` 在搜索前先卡 `nav.code!==0 → 报「登录态失效」`，等于用过期 cookie 直接把搜索也堵死。
- 改为：nav 校验**不再阻断**搜索；nav 失败时仅在结果里带 `authNote`，界面顶部提示「搜索结果可看，取关需重新登录」。这样即使没登录也能先看搜索结果。

### 2. 网页式搜 UP 主 → 取关（新增「核对关注状态」）
- 搜索接口不返回「我是否关注 TA」的关系位，原结果全是 `attribute=null`，导致「搜出来的人到底关没关注」分不清。
- 新增 `unfollow:resolveRelations`：对搜索结果逐个查 `/x/relation` 填充关系位；界面加「**核对关注状态**」按钮（搜索模式下可用），点完后每张卡片标出「已关注 / 未关注」，并让「仅我正关注的人」筛选真正生效，只取关真正关注的。

### 3. 列表内本地搜索 + 拉名单→勾选→取关（原样保留并加固）
- 本地关键字过滤（`filterCandidates` 昵称/UID 子串）、「我的关注列表 → 载入我的关注」模式均保留可用。
- 三处 `nav=-101` 失败统一给出可操作提示：「登录态已失效（nav=-101），请重新登录（点账号的「刷新资料 / 扫码登录」）」。

### 工程
- `main.js`：放松 `unfollow:search` 的 nav 卡口（`authNote` 透传）；新增 `unfollow:resolveRelations`；`loadFollowings`/`batch` 的 -101 提示更明确；`BUILD_TAG` 升 v2.2.3。
- `preload.js`：暴露 `unfollowResolveRelations`。
- `renderer/`：`index.html` 搜索行加「核对关注状态」按钮；`app.js` 新增 `doBatchResolveRelations` 并在 `updateBatchCounts`/`setBatchBusy` 管理按钮态；`authNote` 在搜索结果面板内提示。
- 测试 147 项全绿（新增 `test/search-gate.js` 6 项：本地关键字搜索 / attribute=null 不误杀 / 互关保护 / 仅关注筛选）。

## v2.2.2 修复：三栏布局防塌缩（真正的根因）

v2.2.1 已修复「返回 0 人 / 搜索载入失败无提示」，但发布后重测发现**取关 tab 大面积留白、批量取关 tab 文字逐字竖排**仍未解决。定位到真正的根因并非窗口宽度，而是 **CSS Grid 自动排布陷阱**：

### 根因
三栏栅格定义为 `grid-template-columns: 左栏 8px 中栏 8px 右栏`。当用户**未添加账号**时，中间「配置」面板带 `[hidden]`（`display:none`）被移出网格；此时剩余 4 个网格项按源序**自动填入第 1~4 列**，右侧「运行结果」面板被挤进**第 4 列 = 第 2 条 8px 分隔条轨道**，整栏宽度塌缩到约 8px，内部所有文本（按钮、计数、复选框标签）被迫逐字竖排。v2.2.1 的「视口比例钳制」是对错误假设的修复，未触及该问题。

### 修复
给每个面板显式锚定网格列与行，隐藏中间面板不再撼动其余列的位置：
```css
.accounts    { grid-column: 1; grid-row: 1; }
#resize-left { grid-column: 2; grid-row: 1; }
#cfg-panel   { grid-column: 3; grid-row: 1; }
#resize-right{ grid-column: 4; grid-row: 1; }
.logs        { grid-column: 5; grid-row: 1; }
```
- `main.js`：`BUILD_TAG` 升至 v2.2.2。
- 测试 141 项全绿。

## v2.2.1 修复：批量取关健壮性 · 错误可见 · 布局防塌缩

针对 v2.2.0 上线后反馈的三类问题（部分窗口下批量取关面板布局错乱、搜索/载入失败时界面仅显示「0 人」且无原因、对外说明文案口吻偏口语）进行修复与加固。

### 1. 布局防塌缩（逐字竖排 / 留白 / 表格挤压）
- 三栏栅格的侧栏宽度由「绝对像素上限」改为「按窗口比例动态钳制」：左栏 ≤ 窗口宽 32%（200~480px）、右栏 ≤ 42%（240~620px），并新增窗口缩放监听实时重新钳制。
- 保证中栏在任何窗口尺寸下都不被挤成 0 宽——此前在较窄或侧栏被拖宽时，面板宽度归零会导致 CJK 文字逐字竖排、表格被压成一条缝。
- `.layout` 增加 `overflow:hidden`，极端窄窗下不再出现横向滚动条或内容溢出。

### 2. 加载态与错误可见性（不再「0 人」无说明）
- 搜索 / 载入「我的关注」时面板内显示明确的加载提示 + 转圈（如「正在载入『我的关注』…（关注较多时可能需 10~30 秒）」），替代无反馈的等待。
- 首屏请求失败直接报错并展示原因（如「登录态失效」「搜索接口限流，请稍后重试」），不再静默返回空列表让界面误判为「无结果」。
- 中途某页失败：保留已采集部分，并在面板顶部以黄色提示条标注「第 N 页起请求失败（原因），已展示前 M 条」。

### 3. 文案规范化
- RELEASE_NOTES / README 对外说明改为正式 changelog 口吻，去除对话式表述。

### 工程
- `main.js`：`unfollow:search` 与 `unfollow:loadFollowings` 在首屏失败时返回 `{ok:false, error}`，中途失败返回部分结果 + `warning`；`BUILD_TAG` 升至 v2.2.1。
- `renderer/app.js`：`initLayout`/`makeResizer` 视口自适应钳制 + resize 监听；新增 `setBatchLoading`/`showBatchMessage`，`doBatchSearch`/`doBatchLoad` 在面板内呈现加载态与错误/警告。
- `renderer/styles.css`：新增 spinner、batch-msg、batch-warn 样式，`.layout` 加 `overflow:hidden`。
- 测试 141 项全绿。

## v2.2.0 新功能：粉丝画像 + 活跃度分析，穷举一键取关

将「批量取关」面板从单纯列表升级为「候选画像 + 智能筛选」工具，并解决此前取不出数据的体验问题。

### 1. 一键穷举「可一键取关的粉丝」（单向关注）
- 「我的关注列表 → 载入我的关注」现在不只列出关注，顶部直接给出 **可一键取关（单向关注）人数**，一眼看清该清谁。
- 载入时顺带抓取对方 **头像 / 简介 / 粉丝数**（关注列表接口本身带这些字段，之前被丢弃，现已利用）。

### 2. 昵称画像 + 活跃度（粉丝的「最近有没有投稿」）
- 新增「**分析画像 / 活跃度**」按钮：对当前筛选后的候选逐个查询 B 站空间，得出：
  - **最近投稿时间** → 活跃度分级：**活跃**（90 天内投稿）/ **偶尔**（90~365 天）/ **沉寂**（超 1 年）/ **从未投稿**
  - 昵称、粉丝数、简介（卡片直接展示）
- 只读取、不写操作；节流逐条查询并带进度条，可随时看到「分析 X/Y」。

### 3. 更聪明的筛选（可叠加）
在原有「关键字 / 仅不互关 / 仅我关注 / 粉丝数区间」基础上新增：
- **活跃度**：活跃 / 偶尔 / 沉寂 / 从未投稿
- **最近投稿 ≤ N 天**（从未投稿者自动排除）
- **等级下限**、**有简介**

典型用法：先「载入我的关注」→「仅不互关」→「分析画像」→ 再叠加「沉寂 / 从未投稿 / 低粉丝」，精准挑出该清理的单向沉默号，确认后一键取关。

### 4. UI 重做
- 列表由丑表格改为 **卡片网格**：头像 + 昵称 + UID + 关系/粉丝/活跃度 三色标签 + 简介，状态一目了然。
- 筛选栏分组更清晰，新增分隔与「分析画像」强调按钮。

### 工程
- `src/bilibili.js` 新增 `spaceProfile`（`/x/space/acc/info`）与 `recentVideo`（`/x/space/wbi/arc/search` 取最近投稿）。
- 新增 `unfollow:enrich` IPC（主进程节流查询 + `bus:unfollowEnrich` 进度推送，返回 mid→画像）。
- `src/batch-unfollow.js` 新增 `classifyActivity` 并按活跃度/等级/简介扩展 `filterCandidates`。
- `renderer` 卡片渲染 + 本地活动度分类与筛选，载入时恢复已算出的画像。
- 测试 141 项（smoke 27 + engine 57 + ui 37 + **batch 20**）全绿。

## v2.1.17 修复：侧边栏可拖动 + 热更新镜像自动加速

针对你反馈的两个体验问题（侧边栏拖不动、热更新经常失败）落地修复：

### 1. 侧边栏 / 日志面板宽度可拖动
- 左栏（账号面板）与右栏（运行结果 / 日志面板）之间各新增一条**分隔条**，鼠标按住即可拖动调整宽度（光标变 `col-resize`）。
- 布局由写死的 `268px 1fr 380px` 改为 **CSS 变量驱动**（`--left-w` / `--right-w`），拖动实时写入变量，松手后宽度记忆到本地（`localStorage`），下次启动恢复。
- 限制范围：左栏 200–480px、右栏 240–620px，避免拖成不可用。

### 2. 热更新自动探测镜像（不再直连被墙的 GitHub）
- 重写 `src/updater.js` 的下载链路：启动时**并行探测多个反代镜像**（ghproxy 系列等），按测速最快来源下载；某镜像失败自动**回退下一个**，带指数退避重试（最多 3 次）。
- 检查更新同样走多镜像回退，避免单点失败。
- 下载仍保留 RB1 的 **SHA256 校验**与**断点续传**：镜像下载完成后比对发布侧 `sha256sums.txt`，不匹配立刻中止并删除，绝不替换损坏文件。
- **全局设置新增「热更新下载镜像」** 三项：自动探测（默认）/ 直连 GitHub / 自定义前缀。改完即生效（实时注入更新器），也可填自己的代理地址（需 `https://` 开头并以 `/` 结尾，如 `https://ghproxy.com/`）。

### 工程
- `src/store.js` 全局设置新增 `updateMirror`（默认 `auto`）；`main.js` 在启动与「全局设置-保存」时同步注入更新器。
- 测试 133 项全绿（smoke 27 + engine 57 + ui 37 + batch 12），无回归。
- 构建期继续用 npmmirror 镜像绕过 electron 下载超时。

## v2.1.16 新功能：一键批量取关 + 多维筛选

新增「批量取关」标签页（右侧运行结果区），把"我主动取关"做成带筛选器的工具，覆盖你提的三类需求：**搜索关键字 / 排查不关注名单 / 对方粉丝数区间，一键取关**。

### 两种名单来源
1. **关键字搜索**（默认）— 输入昵称/关键词 → 调 B 站搜索接口，结果自带「对方粉丝数」和「关系位」，因此**粉丝数区间筛选**与**不互关筛选**即时可用。
2. **我的关注列表** — 一键载入"我的关注"前 1000 条，自动标记"我关注但 TA 未回关"的人，适合无关键字、整体排查单向关注。

### 四类筛选（可叠加）
- **结果内关键字** — 在已加载名单里按昵称/UID 再次过滤
- **仅「我关注但 TA 未回关」** — 即"不关注名单"（单向/不互关），已自动排除互关
- **仅「我正关注的人」**（默认开）— 取关前提，未关注 TA 的人无法取关
- **对方粉丝数区间** — 最小~最大（搜索模式可用；关注列表模式接口不返回粉丝数，已禁用并提示）

### 安全护栏（批量写操作必带）
- **二次确认弹窗** — 显示将取关人数 + 预览名单（前 30 人），确认后才发请求
- **自动跳过** — 白名单 / 互关（默认保护）/「不再关注名单」/ 已注销·不可关注者，主流程 `canUnfollow` 逐条校验
- **节流 + 看门狗** — 沿用账号配置的延迟区间随机抖动；单批总耗时 > 20 分钟强制停止防卡死
- **每日上限** — 尊重账号「每日操作上限」，达到即停
- 每取关成功一人即写入「不再关注名单」，下次不会被自动重新关注

### 工程
- 新增 `src/batch-unfollow.js`：纯函数筛选/护栏逻辑（`filterCandidates` / `computeOneWay` / `canUnfollow`），主进程与渲染进程共用同一套语义，便于单测
- 新增 3 个 IPC：`unfollow:search` / `unfollow:loadFollowings` / `unfollow:batch`，进度经 `bus:unfollowProgress` 推回界面（逐条结果 + 顶部进度条）
- 测试 133 项（smoke 27 + engine 57 + ui 37 + **batch 12**）全绿

## v2.1.15 修复：顶栏重叠 + 统计排版 + 缺基线不再显示 0

### 修复
1. **顶栏文字换行 / 重叠** — v2.1.14 的构建标记过长，把「B站关注管理台」标题挤成两行并顶到「+扫码登录账号」按钮上。现：
   - 构建标记缩短为 `2026-11-01 审计修复 RB1-RB23`（详细说明见 Release 正文与 README）
   - CSS 改为「左侧可压缩 + 右侧按钮不换行」，`.ver` 超长时省略号截断、`hover` 可看全；最小窗口 1020px 下不再重叠
2. **统计指标换行被拆散** — 「待核验 806」之前会把标签和数值拆成两行。现每个「标签+数值」包成 `.mi` 组，换行只在组之间发生。
3. **缺基线不再谎报 0** — 新增粉丝统计在「没有更早快照」时（如刚装、或只有今天一条）之前显示 `0`，看着像「全年没涨」。现显示 `—`，鼠标悬停提示「基线不足：需至少 2 天粉丝快照」。

### 说明：为什么「今日新增粉」是 0
当前 `followerLog` 只有 10-31、11-01 两天，且两天粉丝数都是 8708 → 今日净增 = 8708 − 8708 = 0，属实。周/月/年更早没有基线，现改为显示 `—`。等快照积累到 3 天以上，各周期就会有真实数字。

### 数据
- 测试 121 项全绿（smoke 27 + engine 57 + ui 37）
- 兼容历史数据，直接覆盖升级

## v2.1.14 审计修复：全量 23 项（RB1–RB23）

针对第三方只读穷举审计报告的 23 项问题逐项落地。标注 🔴 为高危。

### 🔴 安全
1. **RB1 热更新 SHA256 校验** — 发布侧生成并上传 `sha256sums.txt`；`updater` 下载前取期望哈希，下载后校验文件 SHA256，不一致立即删除并中止，绝不替换进程。发布未附带校验文件时退化为体积校验并显式提示。
2. **RB15 CSV 公式注入（操作记录）** — `escapeCell` 对以 `= + - @` 或 tab/CR 开头的单元格前置单引号，防 Excel/WPS 将昵称当公式执行。
3. **RB18 取关名单 CSV** — 复用同一 `escapeCell`（引号转义 + 包裹 + 公式前缀），修复此前未转义双引号导致列错位的问题。
4. **RB23 油猴脚本 CSV** — 同步补公式前缀防护（三处导出口径统一）。

### 🟡 存储与数据
5. **RB2 Cookie 加密** — 新增 `Store` codec：主进程用 Electron `safeStorage`（Windows DPAPI）加密 cookie 后落盘，读取时解密；旧版明文无前缀自动兼容，下次落盘即转密文。内存仍明文供请求使用。
6. **RB3 操作明细落盘** — 明细改为写入 `data.json` 的 `records`（上限 3000），界面启动即加载历史，CSV 导出改读落盘明细，重启不再丢。
7. **RB8 高频字段延迟落盘** — `bumpDaily` / `setLive` / `withFollowStats` / `patchAccount` 改为标记脏 + 主进程 3s 定时 flush，与 `setUpHealth` 策略一致，减少全量重写 data.json 的写入放大。
8. **RB9 本地日期统一** — 新增 `localDate()`，每日上限、粉丝快照、取关名单节流、明细日期全部改用本地时区，消除 UTC/本地跨天错位 8 小时（本地 0–8 点不计入新一天的问题）。
9. **RB6 bySource 清理** — 来源统计写入 `at` 时间戳，`pruneFollowStats` 清理 30 天未更新条目并限制来源总数 500。
10. **RB7 pendingVerify 上限** — 待核验队列硬上限 5000，核验时丢弃超过 30 天仍未成功的条目。

### 🟡 引擎与界面
11. **RB5 已注销/隐私判断** — 优先按错误码（22001 / -404）判断，文案正则收窄为兜底，降低 B 站改文案导致的漏判。
12. **RB12 大会员过滤** — 新增 `skipVip` 配置项（默认关），`_skipReason` 在接口返回 `vip.vipStatus=1` 时跳过，避免取关开会员的 UP。
13. **RB17 渲染节流** — 新增 `scheduleRender`（rAF 合并），`onRecord` / `onStats` 不再每条事件全量重建 DOM。
14. **RB20 每日休息窗口** — 全局「休息时段」（如 23:00-08:00）+「每周休息日」，命中后自动循环暂停到窗口结束（可随时手动停止）。

### 🟢 运行态与发布
15. **RB4 登录 partition 清理** — 登录窗口关闭时清理临时会话存储与缓存，避免每次扫码累积磁盘占用。
16. **RB10 打包产物清理** — 删除 `dist-v2`~`dist-v6` 历史快照与旧版 exe/blockmap，仅保留当前版本（详见 README 磁盘说明）。
17. **RB11 单实例锁** — `requestSingleInstanceLock`，防止安装版与旧便携版并发全量写同一 data.json；第二次启动会聚焦已有窗口。
18. **RB19 主进程异常日志** — `uncaughtException` / `unhandledRejection` 写入按天日志 + 落盘 + 通知界面，不再只 console。
19. **RB21 多账号 UA 隔离** — `BiliClient` 按账号 UID 从真实 Windows Chrome UA 池稳定选取，降低同 UA 多账号并发的关联风险。
20. **RB22 状态栏提示** — 去掉硬编码「单次 ≤ 50 / 间隔 ≥ 3 秒」，改为「按你配置的间隔/上限执行」。

### 文档与测试
21. **RB16** — 校正 v2.1.12 测试数内部矛盾（改为 27 + 57 + 18 = 102）。
22. **RB13** — 更新实现 SHA256 校验 + HTTP Range 断点续传；差分（仅下载差异段）未做，因便携版单文件需自建差分包与校验链，收益/风险比不高，已在 README 说明。
23. **RB14** — 新增单测：本地日期、dirty-flush（记录进内存但不立即落盘）、`sha256File`/`parseChecksums`/`findHash` 真实文件校验，以及 23 项修复的静态断言。

### 数据
- 测试 119 项全绿（smoke 27 + engine 57 + ui 35）
- asar 校验 PASS（含 `"version": "2.1.14"` 与本期构建标记）
- 兼容历史数据：旧 cookie 明文自动迁移为加密；旧 followerLog 键保留，新增键使用本地日期

## v2.1.12 统计增强：新增粉丝统计 + 操作明细 / 统计时间戳

### 新增
1. **新增粉丝统计（今日 / 本周 / 本月 / 本年）** — 账号卡片「今日操作」下方新增「新增粉丝」一行，绿涨红跌显示四个周期的净增粉丝数：
   - 数据来自新增的每日粉丝快照 `followerLog`（`store.setLive` 每次刷新写入 `{ 'YYYY-MM-DD': follower }`，自动留存最近 400 天），**重启不丢、跨天自动累计**，无需重新跑任务。
   - 计算口径：当前粉丝数 − 周期起点基线（今天 00:00 取「昨天」最后值 / 本周一 / 本月 1 号 / 本年 1 月 1 日）。无更早基线则该周期显示 0。
2. **操作明细 + 统计补时间戳** — 用户反馈「日志有时间戳、明细和统计没有」：
   - 「操作明细」表新增「时间」列，显示每条记录的发生时刻（与日志一致的 `HH:MM:SS`）。
   - 「统计」每个账号卡片头部新增「更新于 HH:MM:SS」，取自每次刷新实时数时写入的 `live.at`。
   - CSV 导出本就含完整日期时间，此次与界面补齐一致。

### 顺带澄清
- 「今日 N」= 今日操作总数（关注 + 取关 + 回粉），**不是**涨粉数；想看涨粉用新增的「今日新增粉」。

### 数据
- 测试 102 项全绿（smoke 27 + engine 57 + ui 18，新增 ui 断言覆盖新增粉丝指标与时间戳）
- asar 校验 PASS（19 条目 / 9 关键文件 / 含 `"version": "2.1.12"` 与本期构建标记）
- 兼容历史数据，直接覆盖升级

## v2.1.11 修复：界面滚动 / 溢出（「今日」不再被截断、面板可拖动）

### 病根
用户反馈「今日显示不完全也没办法拖动」。根因是经典 flexbox 滚动陷阱：

1. **可滚动子元素缺 `min-height: 0`** — 账号列表、配置面板、日志/明细/统计三个 tab 都是 `flex` 子元素，
   默认 `min-height: auto` 导致它们被内容撑开、永不收缩到容器高度，于是 `overflow: auto` 永远不触发，
   内容超出可视区就被 `.panel { overflow: hidden }` 硬裁掉，**滚动条根本不出现**。
2. **配置面板 `overflow-x: hidden`** — 窗口被拉窄时，任务描述 / 提示文字被横向裁掉，且不提供横向滚动。
3. **账号卡片 chip 不换行** — 「实战 / 清理单向+关注指定UP / 循环 / 今日 N」挤在一行，窄列下溢出被裁。

### 修复
- 所有可滚动容器（`.acc-list` / `.tabpane` / `.logbox` / `.recbox`）加 `min-height: 0`，滚动条正常出现
- `.panel.config` 由 `overflow-x: hidden` 改为 `overflow: auto`（双向滚动，窄窗也能看到全部内容）
- `.panel` / `.acc-ops` 加 `min-width: 0` 与 `flex-wrap: wrap`，卡片 chip 自动换行、不再被裁
- 窗口最小尺寸维持 1020×640，拉到最小也能靠内部滚动看全

### 数据
- 测试 98 项全绿（smoke 27 + engine 57 + ui 14）
- 兼容历史数据，直接覆盖升级

---

## v2.1.10 修复：热更新从未生效过 + 自动复查 + 常驻提醒

### 病根（这才是「没有热更新」的真正原因）
用户反馈「没有热更新欸」，实测后发现不是「发现太晚」，而是**从来没生效过一次**。

`src/updater.js` 里比较版本时，把 `parseVer()` 的结果（对象 `{major,minor,patch}`）直接传给了 `compareVer()`，
而后者只认字符串：`String({...})` → `"[object Object]"` → 解析失败 → 返回 `0` →
`compareVer(current, latest) >= 0` **恒成立** → 每次检查都判定「已是最新版本」。

后果：v2.1.7 上线后所有版本更新提示一次都没弹过。用真机 Electron 主进程打桩成 2.1.6 复现：
```
假版本: 2.1.6 | hasUpdate: false | latest: 2.1.9 | current: 2.1.6   ← 缺陷
修复后：      hasUpdate: true  | asset: bili-relation-manager-2.1.9-portable.exe 96MB
```

### 修复
- `compareVer()` 现在同时接受字符串与 `{major,minor,patch}` 对象（内部统一归一化），混合传参也一致
- `updater.check()` 显式传规整后的字符串，双保险
- 新增回归断言：`compareVer(parseVer('2.1.6'), parseVer('2.1.9')) < 0`、对象与字符串混用结果为 0
- 新增 `tools/test-update-check.js`：用真机 Electron 主进程 + 真实 GitHub API 跑全链路（打桩旧版本号），
  确认「能发现新版 + 挑中 portable 资产」，以后发版可以直接跑这条命令验收

### 顺带补齐的发现能力（原 v2.1.9 内容）
1. **定时复查** — 启动 6 秒首查之外，每 2 小时自动复查一次
2. **回到前台补查** — 窗口从后台切回且距上次检查超过 30 分钟时补查
3. **顶部「可更新 vX」常驻标记** — 发现新版后标题旁出现粉色药丸，点一下回到更新弹窗；关掉弹窗、点过「稍后再说」也不会错过
4. **手动检查必有反馈** — 菜单「帮助 → 检查更新…」无论有没有新版都给明确结果（已是最新 / 失败原因），不再点了没反应
5. **检查去重** — 手动与自动共用一个入口，不会并发重复打接口

### 数据
- 测试 98 项全绿（smoke 27 + engine 57 + ui 14）
- 升级方式：这版仍需手动装一次（旧版正是「永远说已是最新」的那个缺陷版）；
  装到 2.1.10 之后，后续版本就能正常弹窗 + 顶部提醒了
- 兼容历史数据，直接覆盖升级
