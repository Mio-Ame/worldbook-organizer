# `worldbook-organizer` 精修交接说明（dev 分支 · v2.35.1）

## 0. 交接断点（2026-11-26 · v2.35.1）

### 0.1 本版范围
- `dev` 的 v2.35.1 修复原生世界书选择和编辑、精简顶栏为「整理 / 组合 / 扫描」与齿轮、补全静默补扫与同名书归类、支持条目调序写回 `displayIndex`（可选同步 `order`），并修复窄窗、非阻塞设置和弹窗底栏。
- 本版仅走 `origin/dev`；`main` 保持 `f61a20b`，不改宿主或用户数据。

### 0.2 提交前复验
- `node --max-old-space-size=1024 --test --test-concurrency=1 tests/core.test.mjs`：**73/73**。将可能指向实际素材的样例名称替换为中性测试名，不改变断言语义。
- `node --max-old-space-size=1024 --test-concurrency=1 run-e2e.mjs`：**64/64**（Tier 1–4：47、7、7、3），`T3-07` 展开态编辑与连续拖拽通过。此结果来自 headless Edge 加本仓库源码和模拟宿主，不是实际安装、iOS 真机或用户验收。
- 交付清单：窗口缩放与锚点、非阻塞面板、宽窄按钮与置顶、宽屏设置、正文与拖拽、映射双列、浮层与抽屉、重扫反馈与偏好、通用文案、输入与模拟软键盘、测试内存锁均已按自动化和源码覆盖核对；实际宿主待单独验收。

### 0.3 后续顺序
1. 历史回归套件保留在仓库外，迁移后路径为 `F:\MyAiProject\.codex-tmp\wbo-e2e-suite-keep`；窄屏临时验证目录单独清理。
2. 拆分 `src/panel.js`：窗口与公共底座、主分组面板、扫描与角色关联、本地与 AI 整理、全局组合与外部快捷浮层、跨书搜条目、设置。保持原导出与行为，每块跑单测与对应 E2E。
3. 实现角色主世界书与附加世界书绑定；同名候选先核对角色头像和路线，不能自动绑定。
4. 合并世界书条目分组并验证已有配置与入口的兼容性。

---

以下为 v2.35.0 已交付内容（保留备查）。

## 1. 当前目标与范围
- 分支：`dev`（跟踪 `origin/dev`，`main` 保持 `f61a20b` 不动），版本号与样式热刷版本号同步至 `2.35.1`。
- 完整保留 `v2.35.0` 新特性（全局世界书组合 `globalPresets`、`#wbo-wi-merged-btn` 快捷中心与回退、全题材通用 AI 整理提示词与 `aiOrganizePresets`、持久化 UI 偏好记忆等），并落地窗口缩放与防回弹、非阻塞浮动分组管理、面板容器级响应式按钮与 `★` 右对齐、窄窗展开世界书条目头部按钮收纳与防竖排挤压、条目正文优先与展开态拖拽、扫描覆盖两列分割表与零变动反馈、宽屏设置紧凑对齐及 iOS 软键盘保活等全部体验优化与缺陷修复。

## 2. 已完成与改动文件
- `manifest.json` & `index.js`：版本号与 `STYLE_ASSET_VERSION` 升至 `2.35.1`（确保更新后立即刷新浏览器旧 CSS 缓存）。
- `src/core.js`：
  - 新增 `bookOrders`（组内手动拖拽排序持久化）与 `reorderBookInGroup`（跨组移动自动清理原分组 `bookOrders` 残留键），同步接入 `normalizeSettings`、`classifyWorldbooks`、`migrateSettingsOnWorldRename`、`cleanupDeletedWorldSettings`、`pruneStaleWorldbookSettings`、`exportConfigData` 与 `importConfigData`。
  - 保留并完善 `globalPresets`、`aiOrganizePresets` 与通用 AI 提示词预设。
- `src/host.js` & `src/entry-accordion.js`：
  - 新增 `deleteWorldbookEntryDirect` 并在展开条目的底部栏补齐「删除条目」按钮（带二次确认与计数实时同步），补齐原生编辑器级的新增/编辑/启停/删除完整闭环；
  - 展开条目默认优先展示核心正文编辑区，将触发词、蓝绿灯/位置/深度等低频配置默认折叠进 `<details class="wbo-acc-meta-details">`（附一行状态摘要）；
  - 修复 `applyTallTextareaHeight` 与 `syncTallUi`：测量前先置 `height: auto` 再按 `380px..560px` 设定高度，并移除 `scrollIntoView`、锁定外层与编辑框 `scrollTop`，使点击「加高编辑区 / 恢复默认高度」页面保持原位零跳动；
  - 升级框内关键词查找：新增同步高亮底层 `.wbo-acc-ta-backdrop`，输入关键词即直接在编辑区内对命中词标框高亮（`.wbo-acc-hl-mark.is-current`）并自动滚到第 `1/N` 处（无需先点下一个，且不抢走查找输入框焦点）；将计数与「上一个 / 下一个」收入不可拆分的 `.wbo-acc-find-nav` 防止窄窗拆行；
  - 全库替换简陋字符 `↶`/`↷` 为统一清晰的标准圆弧撤回/重做矢量图标（`.wbo-undo-svg`）。
- `src/native-filter.js`：
  - 面板外全原生框 `☆ / ★` 收藏置顶全覆盖：为 `#gr-global-dropdown-container`（全局增强选择框）与 `.gr-container-enhanced`（编辑器增强选择框）的每一行 `.gr-option`（无论单分组或多分组、首次打开或二次重绘列表）注入右对齐 `.wbo-gr-pin-btn` 星标按钮并支持原地点击切换置顶不关窗，同时为 `#world_info`、`#world_editor_select` 与角色附加书 Select2 补齐 `ensureSelect2RowsHavePinBtn` 兜底与高对比度星标样式；置顶项在各下拉框顶部同步置顶；
  - 增强 `enhanceCustomDropdownPopover` 显式声明 `isGlobalPopover` 并标记 `dataset.wboPopoverRole`（`'global'` / `'editor'`），修复多分组自定义弹层（含全局 `★ 已置顶` 置顶与编辑区隔离）识别，即使在未分组或单分组下也可靠识别编辑器 `.gr-container-enhanced` 并绑定 `bindDrawerSafeBubbleGuard`；将 `displaySelector` 收敛至 `#WIMultiSelector .gr-select2-display` 并把 `#world_popup .gr-select2-display`、`#wbo-mobile-picker-overlay`、`.wbo-mp-backdrop`、`.wbo-mp-popover` 纳入拦截白名单；
  - 修复 iOS WKWebView 软键盘弹出秒关问题：`openMobileEditorPickerSheet`（`#wbo-mp-search`）与 `attachGroupedSelectControl`（`#wbo-pop-search`）改为基于 `visualViewport` 与焦点/宽度阈值的原地高度/位置夹紧，软键盘触发 `resize` / `scroll` 时绝不销毁或重建输入框，仅在失焦且真实转屏或宽度大幅变化时关闭，同时在 toggle 关闭时完整清理 `window`/`visualViewport`/`document`/观察器监听；
  - 新增 `isPointInsideElementRect` / `consumeRecentDismissedTap` 修复触控场景下 `.wbo-mp-backdrop` `pointerdown` 关闭浮层后紧随的合成 `click` 穿透 `#wbo-mobile-editor-trigger` 或 `.wbo-popup-select-trigger` 立即重开的闪跳问题；
  - 与 `closeAllOpenWorldDropdowns` 联动，打开全局世界书控件或弹窗快捷入口时自动收起已展开的编辑区/分组下拉浮层；所有 `body` 挂载弹层保持冒泡阶段 `bindDrawerSafeBubbleGuard`。
- `src/panel.js`：
  - 移除「缩小尺寸 / 小窗对照」按钮及相关状态，保留四边 + 四角共 8 条无文字角标的隐藏拖拽缩放热区；桌面端支持纵向拉伸至 `100dvh`，拖拽底边/右边/右下角缩放时锁定 `top`/`left` 锚点不向顶部/中央回弹；
  - 将「管理分组」改造为不锁死底层列表的非阻塞浮动面板，支持边整理分组边滚动、点开底层主面板条目内容；
  - 世界书行移除标题中冗长括号后缀，改以旁侧简洁 `本地同名` 红标提示；展开世界书行后仍可在标题/握把区正常发起同组拖拽排序与拖入顶部分组胶囊；
  - 扫描覆盖区域重构为左「角色名」、右「世界书」的两列分割表（去掉每行重复「角色卡绑定」标注）；点击「重新扫描角色卡」在零新增变动时亦返回时间戳状态栏、按钮即时态与 Toast 提示；
  - 统一所有文本/搜索 `<input>` 与 `<textarea>` 的 `spellcheck="false"`，移动端（`<= 680px` 或粗指针）保持禁用自动 `.focus()`。
- `style.css`：
  - 修复窄窗下展开世界书条目面板（`.wbo-book-preview`）布局错乱：为 `.wbo-acc-summary` 补齐 `white-space: nowrap` 杜绝 `共 N 条（启用 M 条）` 被挤压成单字竖排柱状撑高空白；在 `@container plugin-win (max-width: 600px)` 与 `@media (max-width: 680px)` 下隐藏 `.wbo-book-preview .wbo-preview-head-actions`（相关 `条目分组 / 在编辑器中打开 / 删除世界书` 统一收进世界书行右侧 `···` 菜单，宽屏下世界书行亦同步提供 `条目分组` 图标按钮）；同时优化 `<= 440px` 窄窗下顶部 4 枚二字工具按钮单行排布、条目搜索框与「新建条目」同行紧凑对齐及拖拽提示单行省略；
  - 修复 `.wbo-book-actions .wbo-book-more-btn` 与 `.wbo-icon-btn` 优先级冲突：桌面宽面板（`> 600px` 容器且 `> 680px` 视口）下彻底隐藏 `···`、平铺操作按钮并将 `★` 右对齐在行尾；窄容器（`@container plugin-win (max-width: 600px)`）及移动端（`@media (max-width: 680px)`）下隐藏 `.wbo-book-action-secondary` 并显示 `[全局]` + `★` + `···`；
  - 为 `.wbo-vis-popover`（及 `.wbo-mp-popover`）补齐 `min-width: 0 !important;` 覆盖 `.wbo-modal` 的 `340px` 最小宽度，确保窄屏与移动端 `···` 菜单及可见性弹层严格留在视口内不右溢；
  - 在 `@media (max-width: 680px), (pointer: coarse)` 下将 `.wbo-mp-popover` 与 `.wbo-modal` 内文本/搜索输入框字号提升至 `16px !important`（`.wbo-mp-popover .wbo-search-input` 高度 `34px`），避免 iOS WebKit 自动放大与视口抖动；
  - 拉开分组（L1）> 世界书（L2）> 条目（L3）三层视觉层级；补全 `.wbo-cov-chip-group` 与 `.wbo-cov-targets .wbo-jump-link.is-world` 长世界书名自动换行防溢出；宽屏设置页「明暗模式」紧凑贴近标题；零 `backdrop-filter` / `blur()`。
- `tests/core.test.mjs`：通过全部 `37/37` 单测与 DOM 回归测试（含 `bookOrders` 跨组清理、iOS 软键盘 `resize`/`visualViewport` 回归、`.gr-container-enhanced` 分组隔离与 `isGlobalPopover`、触控 toggle-close 监听清理、`isPointInsideElementRect`/`consumeRecentDismissedTap` 防误重开及静态 CSS/安全护栏），另经无头 Edge CDP 多视口校验（`1440×900`、`480×720`、`390×844` 触控）`20/20` 项全部通过。

## 3. 绝对不能碰的红线 / 已确认偏好
- 仅在 `dev` 分支迭代交付，严禁修改或推送 `main`（`f61a20b`）；严禁触碰 `user-persona-studio`、`F:\SillyTavern`、`F:\TauriTavern`、`OpenAI Settings` 或 `F:\SillyTavern\data`。
- 源码、CSS、注释、`README.md` 与 `NEXT.md` 中严禁出现任何第三方插件或作者名称。
- 禁用 `backdrop-filter` / `blur()`；文本/搜索 `<input>` 与 `<textarea>` 强制 `spellcheck="false"`；移动端禁止自动 `.focus()`；所有 `body` 挂载浮层绑定冒泡防穿透守卫。

## 4. 已知坑与未解决阻塞 / 真机待核验要点
- 已知环境限制：无头测试采用独立隔离 DOM 模拟宿主 `#WorldInfo` / Select2 与 `/api/*` 接口；真实 SillyTavern / TauriTavern 运行时的原生 Select2 v4 事件与 iOS/Android 触控拖放需在真机复核。
- 真机待核验要点：
  1. 桌面端拖拽主面板底边/右边/右下角拉伸至贴近视口全高（`100dvh`）时，确认窗口不向上回弹、右下角无文字角标；
  2. 宽屏下世界书行无 `···` 且 `★` 靠最右对齐，拉窄至 `<= 600px` 或切换移动端时收敛为 `[全局]` + `★` + `···`；
  3. 展开长条目点击「加高编辑区」观察高度显著提升且可复原，展开态仍可拖拽排序及拖入分组；
  4. 打开「管理分组」后直接滚动、展开底层面板条目；在编辑区打开下拉后点击全局世界书入口确认旧下拉立即收起；
  5. 扫描弹窗查看两列分割表长名称换行与无变动重扫即时提示；
  6. iOS TauriTavern 真机点击世界书编辑下拉搜索框「搜索世界书...」弹出输入法时浮层保持展开不秒关、不缩放抖动；窄屏与手机端点击 `···` 弹出的 `.wbo-book-more-popover` 菜单完整留在视口内不右溢。

## 5. 下一步最小动作
- `v2.35.0` 与全部 R1–R6 体验精修、缺陷修复已提交并推送至 `origin/dev`，可直接交由用户在真实 SillyTavern 与 iOS TauriTavern 环境按 `§4` 要点实机验证；确认无误后再由用户决定合入 `main`。
