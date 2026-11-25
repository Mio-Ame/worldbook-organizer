# `worldbook-organizer` 精修交接说明（dev 分支 · v2.35.0）

## 1. 当前目标与范围
- 分支：`dev`（跟踪 `origin/dev`，`main` 保持 `f61a20b` 不动），版本号同步至 `2.35.0`。
- 完整保留 `v2.35.0` 既有新特性（全局世界书组合 `globalPresets`、`#wbo-wi-merged-btn` 快捷中心与回退、全题材通用 AI 整理提示词与 `aiOrganizePresets`、持久化 UI 偏好记忆等），并落地窗口缩放与防回弹、非阻塞浮动分组管理、面板容器级响应式按钮与 `★` 右对齐、条目正文优先与展开态拖拽、扫描覆盖两列分割表与零变动反馈、宽屏设置紧凑对齐等全部体验优化与缺陷修复。

## 2. 已完成与改动文件
- `manifest.json` & `index.js`：版本号与 `STYLE_ASSET_VERSION` 升至 `2.35.0`。
- `src/core.js`：
  - 新增 `bookOrders`（组内手动拖拽排序持久化）与 `reorderBookInGroup`（跨组移动自动清理原分组 `bookOrders` 残留键），同步接入 `normalizeSettings`、`classifyWorldbooks`、`migrateSettingsOnWorldRename`、`cleanupDeletedWorldSettings`、`pruneStaleWorldbookSettings`、`exportConfigData` 与 `importConfigData`。
  - 保留并完善 `globalPresets`、`aiOrganizePresets` 与通用 AI 提示词预设。
- `src/entry-accordion.js`：
  - 展开条目默认优先展示核心正文编辑区，将触发词、蓝绿灯/位置/深度等低频配置默认折叠进 `<details class="wbo-acc-meta-details">`（附一行状态摘要）；
  - 修复 `applyTallTextareaHeight`：测量前先置 `height: auto` 读取自然 `scrollHeight` 再按 `Math.max(380, Math.min(560, naturalScrollH + 12))` 设定高度（关闭时清回 `''`），使「加高编辑区」对长内容提升明显且多次触发完全幂等。
- `src/native-filter.js`：
  - 置顶/收藏世界书同步在 `#world_info`、`#world_editor_select`、Select2（`.wbo-s2-item` 右侧对齐 `★`）与自定义浮层顶部排序；
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
