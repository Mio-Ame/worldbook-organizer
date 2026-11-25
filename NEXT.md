# `worldbook-organizer` 精修交接说明（dev 分支 · v2.34.6）

## 1. 当前目标与范围
- 分支：`dev`（跟踪 `origin/dev`，`main` 保持 `f61a20b` 不动），版本号同步至 `2.34.6`。
- 完成 M3 Iteration 3（第 3 轮用户体验与大规模世界书交互精修）、实测反馈 5 项体验修复、Windows 真机卡顿/截断 4 项根因修复，以及三件套统一的浮动窗口化（`PointerEvent` 拖拽 / 缩放 / 小窗对照 / `—` 最小化恢复 / 零遮挡点击穿透 / `@container plugin-win` 响应 / `.openDrawer` 防误关冒泡守卫）。

## 2. 已完成与改动文件
- `src/entry-accordion.js`（新增）：共享多开手风琴条目浏览器与内联直编器（`mountEntryAccordion`）：
  - 折叠行零表单 DOM，按需懒加载单条，支持同时展开 2~N 条对比编辑（脏改收起弹窗守卫）；
  - >60 条渐进加载（`继续加载 60 条` / `展开全部`），搜索覆盖标题、触发词及**全书完整正文**（已展开条目保持挂载），`spellcheck="false"`，不主动手机端 `.focus()`；
  - 单编辑器轻量撤销/重做栈（`↶ 撤回` / `↷ 取消撤回`、`Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z`，`Tab` / `Shift+Tab` 缩进前后保留历史），框内查找（`上一个 / 下一个` 选中高亮）、`复制正文`、等宽代码字体切换（`entryEditorMonoFont`）、编辑区`加高`与实时字数/Token 估算（`estimateEntryTokens`）。
- `src/core.js` & `src/host.js`：
  - **零截断**：彻底移除 `fetchWorldbookPreviewEntries` 的 1600 字截断与 `searchEntriesInPayload` 的 2400 字截断；新增 `fetchWorldbookEntryContentMatchedUids` 无缓存直连全书正文搜索（仅保留匹配 UID 集合，不滞留大 JSON）。
  - `findSensitiveTargetGroup(groups)` 自动识别 `nsfw / 成人 / 18+ / R18 / 涩 / 色 / 肉 / 车 / h向 / h文` 同义分组且避免误伤 `History` / `Character` / `角色`；`moveBooksToNamedGroup` 支持 `targetGroupId`。
  - `AI_ORGANIZE_CATEGORY_PRESETS`（含 `按题材背景`、`按挂载方式`）与 `AI_ORGANIZE_NAMING_PRESETS` 扩展为 6+6；`isBookVisibleInSelector` / `isBookVisibleInCharBindPopup` 支持 `SPECIAL_GROUPS.PINNED`；`partitionGroupPickerBooks` 拆分本组/未分组/其他已分组；`unbindWorldbookFromPersona` 增加激活人设与交叉绑定保护。
- `src/panel.js`：
  - 将「行内展开预览」与「条目浏览/编辑」融合为同一 `mountEntryAccordion`（移除书行与 `···` 菜单中重复的 `browse-entries` 按钮）；
  - 星标置顶改为原地亮灭更新，切换筛选胶囊或重开主窗时重排；新建/编辑分组支持 `未分组 / 已选 / 全部 / 其他已分组` 胶囊筛选、`全选当前可见未分组` 与默认折叠的「已在其他分组的世界书」；
  - 排除分组（设置页与快捷排除浮层）新增 `全选`、`反选` 与 `隐藏 X / 显示 Y 组` 计数；AI 整理样式 6+6 等宽网格、两行高级选项、`外部 AI 整理` 独立子视图、敏感书同义分组就近确认与顶部 `[撤回]`；扫描弹窗去重摘要并增加顶部状态条与 `HH:mm 扫描完成：...` 汇总；
  - 主列表移除常驻 `draggable="true"`，仅在拖拽抓手 `pointerdown` 时动态开启；
  - 统一 `PointerEvent` 标题栏拖拽 + 右下角 `24×24px` 缩放（桌面 `≥340×280`，移动 `≥min(310px, calc(100vw - 16px))×250px`，上限 `96vw×92dvh`），关窗自动卸载 `resize` / `orientationchange` 监听；
  - 标题栏新增「小窗对照 / 还原尺寸」与 **`—` 最小化**（隐藏面板完整保留 DOM/草稿/滚动位置，右下角显示 `世界书管理 · 点击恢复` 安全区胶囊）；默认主遮罩全程 `pointer-events: none; background: transparent;` 点击穿透外部宿主按钮且点击外部永不关闭，所有浮层根节点统一挂载冒泡阶段 `bindDrawerSafeBubbleGuard`（`mousedown` / `touchstart` / `click`）防止收起 SillyTavern 未固定抽屉。
- `src/native-filter.js`：
  - 原生 `#world_info`、#world_editor_select、附加书 Select2、手机端选择弹窗与自定义浮层统一接入置顶星标 `☆/★`（Select2 捕获阶段拦截点击不选中/不关闭，手机/弹窗改用 `<div>` 行容器零嵌套 `<button>`）、`★ 已置顶` 筛选胶囊、置顶排序与冒泡防误关守卫。
- `style.css` & `manifest.json` & `index.js`：
  - 版本号与 `STYLE_ASSET_VERSION` 统一升至 `2.34.6`；
  - `.wbo-link-btn` 改为 Ghost 次级按钮；`.wbo-groups-list` 与折叠项启用 `contain: layout style`；弹窗全量引入 `container-type: inline-size; container-name: plugin-win` + `@container plugin-win (max-width: 560px / 420px)` 响应规则，全遮罩零 `backdrop-filter: blur()`。
- `tests/core.test.mjs`：更新零截断断言并新增 Iteration 3 单元覆盖（26 项全部通过）。

## 3. 绝对不能碰的红线 / 已确认偏好
- 仅在 `dev` 分支迭代交付，严禁修改 `main`（`f61a20b`）、`INTEGRATION.md`、`user-persona-picker`、`worldbook-entry-groups`、`F:\SillyTavern`、`F:\TauriTavern`；不得读取 `F:\SillyTavern\data` 或 `OpenAI Settings`；所有示例与测试使用虚构脱敏数据。
- 默认浮层外层遮罩保持透明与 `pointer-events: none`，仅 `.wbo-modal` 本体响应事件且不向 `<html>` 冒泡 `mousedown` / `touchstart` / `click`；仅显式点击 `×` 关闭主面板，点外部不关闭。

## 4. 已知坑与验证结论
- 语法检查与单测：`node --check` 全部 6 个模块通过；`node --test tests/core.test.mjs` 26/26 通过。
- 4 状态无头 Edge CDP 验证（均通过且零横向溢出、`<html>` 冒泡计数为 `0`）：
  1. 桌面 `1280×800` 标准窗：外部宿主按钮在面板开启下可直接点击且不关窗；手风琴 60 条分页增量、双条同开、3615 字零截断全量搜索、`Tab` 缩进后撤回/重做、框内查找、等宽/加高、原地置顶不回滚、Select2 置顶不关闭、分组选择器折叠、6+6 网格、敏感书同义归组与撤回、排除组反选/全选全部通过；
  2. 桌面 `1280×800` 拖拽右下角缩窄至 `360×420`：`@container plugin-win` 自动切换紧凑三列工具栏，零溢出错位；
  3. 移动 `390×844` 触控标准窗：手机端选书抽屉零嵌套 `<button>`、星标置顶与 `★ 已置顶` 胶囊正常；
  4. 移动 `390×844` 半屏小窗对照 + `—` 最小化/恢复：小窗占比约 `48%`，上方外部宿主按钮可正常点击；输入未保存草稿 `E2E未保存草稿-123` 并滚动后点 `—`，点击 `世界书管理 · 点击恢复` 胶囊后草稿与 `scrollTop` 完整保留。

## 5. 下一步最小动作
- 若需在真实酒馆（SillyTavern / TauriTavern）实机核对，直接切至 `dev` 分支刷新浏览器缓存（`v=2.34.6`），在桌面端与 390px 移动端快速抽检小窗拖拽/缩放、展开超长条目及三件套联动即可准备合入 `main`。
