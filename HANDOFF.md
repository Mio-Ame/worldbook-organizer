# 交接说明：worldbook-organizer v2.35.17 → v2.35.37

## 0. 这份文档是什么

本窗口从 `v2.35.17` 起持续按用户反馈修改插件，累计 20 个提交（全部在 `dev`）。本文件写给接手审查的另一个 agent：包含**全部改动清单**、**用户反馈过的问题（含未解决）**、**关键代码位置**、**测试现状**、**已知风险**。

分支：`dev`，最新提交见 `git log --oneline`。所有测试用 `WBO_E2E_SUITE` 指向 `本轮材料/B03-R2-补充验证/formal-isolated-suite`。

---

## 1. 改动清单（按版本）

| 版本 | 主题 | 关键改动 |
| --- | --- | --- |
| 2.35.17 | 反馈修复轮 | B01 选书顺序、B02 组合表单、B03-D01 外点关闭、B04 按钮顺序、B05 分组展开、B06 角色名、B07 iPad 竖屏高度、B08 排除分组语义 |
| 2.35.18 | 全局下拉折叠 + 敏感书 | 全局下拉「全部」下分组标题可折叠（`layoutGlobalGroupRows`）；敏感检测排除角色组（`analyzeSensitiveOrganizeState`、`sensitiveSet`） |
| 2.35.19 | 编辑下拉置顶 + 组合页两行 | 编辑下拉当前角色书置顶（`decorateGroupItems` 尾部）；组合页 pill 分两行（`#wbo-cmb-group-pills` / `#wbo-cmb-pills`）、「已选」强调、per-pill 滚动记忆 |
| 2.35.20 | 主面板常驻块 + 眼睛浮层 | 主面板「已开启的全局世界书」常驻、新增「当前角色世界书」块；眼睛浮层外部点击关闭；编辑下拉「已全局」徽章 |
| 2.35.21 | 编辑下拉全局块 + 组合页折叠 | `__globals__` 镜像块（≥3 本挂载）；组合页分组折叠（`comboGroupCollapsed`） |
| 2.35.22 | 主面板折叠 / 组合页强调色 | 全局块可折叠（`activeGlobalGroupCollapsed`）；当前角色按 `charOwners` 全量取书；已选暗红 `#7f2b2b`；全局下拉收藏组恢复折叠记忆 |
| 2.35.23 | 全局下拉归属 / 会话 pill / 搜索匹配 / 绑定面板 | 既收藏又挂载只进全局块；`_sessionGlobalPillId`；编辑下拉搜索归组（`layoutEditorSearchMatches`）；绑定主世界书改原生 Select2（`groupDesktopSingleWorldSelect`） |
| 2.35.24 | 收藏块 / 标题 / 组合页样式 / 眼睛二次点击 | 普通下拉「已收藏」镜像块；置顶行回填 `primaryTitle`；组合页去卡片样式；去掉「已选 X 本」徽章；眼睛按 `data-wboGid` 判定二次点击 |
| 2.35.25 | 收藏计数与提示 | 收藏组标题按收藏总数计数并追加「X 本已全局，位于全局分组」（`.wbo-dd-group-note`） |
| 2.35.26 | 搜索归组扩到收藏/全局与移动端 | 编辑下拉 PINNED/GLOBALS pill 也归组；移动 picker `renderList` 搜索归组；`原属：X` 徽章 |
| 2.35.27 | 去掉全局抽屉多余控件 | `#world_info` 不再 attach 自建 trigger（移动模式且宿主无 Select2 例外）；移除自建全局搜索框 |
| 2.35.28 | 绑定主世界书增强 + 全局不注入 | `enhanceDesktopSingleWorldSelect2`（搜索/optgroup/dropdownParent）；`applyGlobalWorldSelectFilter` 不再注入控件 |
| 2.35.29 | iOS 全局块 + 绑定默认展开 | 移动 picker 加「全局世界书」pill/section；绑定弹窗 `collapseCharByDefault: false` |
| 2.35.30 | iOS 当前角色置顶 + 标签 | `getMobileCurrentCharBooks` / `pinCurrentCharRows` / `当前角色` 徽章 |
| 2.35.31 | 收藏 pill 与绑定初始化 | 组合页 `__pinned__` 不再排除全局书；绑定 Select2 首次检测即初始化 |
| 2.35.32 | 搜索跨组 + 标签精简 | 移动端搜索跨全部分组、≥2 建组、原属改纯分组名；桌面 `skip` 只保留非搜索；行内布局修复 |
| 2.35.33 | 绑定分组与显示名 | 去掉「≥2 组才建 optgroup」早退；模板用 `state.element.dataset.wboRealName` 查 `primaryTitle` |
| 2.35.34 | 标签完整显示 | 徽章 `flex: 0 0 auto`、`max-width: none`；动作区右对齐 |
| 2.35.35 | 镜像徽章守卫 | `renderSelect2OptionResult` 对镜像行不渲染「当前编辑」徽章（消除竞态） |
| 2.35.36 | 镜像星标 + 全局搜索放宽 | 镜像行保留 ★；全局下拉搜索时不再按 pill 过滤 |
| 2.35.37 | 搜索徽章回填 | `decorateGroupItems` 末尾按实时搜索词补「搜索匹配到的世界书」+ 分组名徽章（幂等） |

---

## 2. 用户反馈过的问题（完整清单）

### 已解决（请审查实现是否正确）

1. 主面板「已收藏」单组视图带折叠箭头 → 改静态标题。
2. 组合页分组顺序：已收藏 → 用户分组 → 未分组（不含角色组）。
3. 组合页 pill 两行 + 「已选」强调色。
4. 分组切换滚动位置记忆（任意位置，不只底部）。
5. 挂载全局书时出现「全局」pill（组合页）。
6. 全局下拉「全部」下分组可折叠；收藏组默认展开后改为记忆折叠。
7. 敏感书检测排除角色组。
8. 全局下拉既收藏又挂载只显示在全局块（后来加计数与「X 本已全局」提示）。
9. 全局下拉会话级记住最后 pill。
10. 编辑下拉当前角色书置顶 + 显示名（`primaryTitle`）。
11. 搜索归类：单本带徽章、多本建组、清空不残留（桌面 + 移动 picker）。
12. 绑定主世界书：不闪原生框、搜索可用、显示名、就地展开（部分）。
13. 眼睛浮层：外部点击关闭、再点同眼睛关闭、同时只一个。
14. 去掉全局抽屉多余的第三个框与自建搜索框（输入法卡住）。
15. 组合页去掉书单卡片与外层留白、去掉「已选 X 本」。
16. 徽章不被压缩/截断；★ 右对齐。
17. 组合页「已收藏」pill 不再空白（不排除全局书）。

### 未解决 / 部分解决（请接手修复）

| # | 问题 | 现状与线索 |
| --- | --- | --- |
| U1 | 电脑端普通下拉：全局书显示两遍/三遍（分组块 + 原组 + 裸行；既收藏又挂载时三遍） | 试过「镜像存在即隐藏原组行」，会让 `editor dropdown groups 3+ mounted globals…` 与 `editor search inside a group…` 两个用例失败，已回退。需要让镜像行接管选中/收藏管线并同步更新断言 |
| U2 | 绑定弹窗没有分组切换胶囊（pills） | 只有 optgroup。需复用 `createDropdownFilterBar` 给主 select 的 dropdown 挂 filter bar |
| U3 | iOS 增强浮层（`syncSections`）路径：无「全局世界书」块、无搜索归组、置顶缺失 | 该路径与 mobile picker 是两套渲染；需在 `syncSections` 内实现同样逻辑 |
| U4 | iOS 全局搜索出现原生 `NO RESULTS FOUND`、必须切到对应分组 | 增强浮层/原生 Select2 matcher 仍按 pill 过滤；需在该路径放开搜索过滤 |
| U5 | 电脑端全局下拉搜索没有「搜索匹配到的世界书」分组 | 已放宽「搜索不按 pill 过滤」（v2.35.36），但尚未把命中行收进临时分组；需仿 `layoutEditorSearchMatches` 写 `layoutGlobalSearchMatches` |
| U6 | 当前角色显示名在普通下拉又变原名 | 线索指向 `classifyWorldbooks` 的 `charBookTitleMode` 判定：书被移到非角色组后 `isInCharGroup=false`，标题模式可能回落。需回到 core 层修，不建议 UI 补丁 |
| U7 | 组合页默认进入「已收藏」 | 直接改默认 pill 会破坏 `organize-combos` 两个用例的预期，需连同引导/滚动一起改 |
| U8 | 普通下拉全局块阈值（≥3 本）与命名「全局世界书」是否符合预期 | 用户曾要求 >3 本，后又反馈"没有分组"；需确认真实挂载数量 |
| U9 | `参考仓库/下拉框美化.json` 兼容 | 尚未加载该脚本做隔离验证；镜像块/分组头/搜索框可能被其重写 DOM 影响 |
| U10 | 点原生世界书抽屉其它位置会关闭抽屉 | 移除自建控件后仍存在，怀疑是 ST 原生行为；需真机复核 |

---

## 3. 关键代码位置

- `src/native-filter.js`
  - `applyGlobalWorldSelectFilter`（约 1324）：全局抽屉不再注入控件。
  - `openMobileEditorPickerSheet` / `renderList` / `renderPills`（约 2000-2400）：移动选书；`getMobileGlobalBooks`、`getMobileCurrentCharBooks`、`pinCurrentCharRows`、搜索归组。
  - `enhanceDesktopSingleWorldSelect2` / `renderSingleWorldResult` / `renderSingleWorldSelection` / `groupDesktopSingleWorldSelect`（约 3945-4070）：绑定弹窗主世界书。
  - `enhanceCharBindPopup`（约 4110）：绑定弹窗入口（桌面/移动分支）。
  - `enhanceOpenEditorDropdown` / `decorateGroupItems` / `layoutEditorGlobalBlock` / `layoutEditorSearchMatches`（约 4290-4750）：编辑下拉分组、镜像块、搜索归组、徽章回填。
  - `enhanceOpenGlobalDropdown` / `layoutGlobalGroupRows`（约 4900-5150）：全局下拉分组、会话 pill、收藏计数。
- `src/panel-quick.js`
  - `openGroupVisibilityPopover`（约 1578）：眼睛浮层。
  - `openEditView` / `applyEditFilters` / pill 处理（约 727-1010）：组合页两行 pill、折叠、滚动记忆、`__pinned__` 过滤。
- `src/panel-manager.js`
  - `pushOverviewPinnedSections`、`currentCharBooks`、`activeGlobalGroupCollapsed`、PINNED 单组视图（约 2740-2900）。
- `src/core.js`
  - `analyzeSensitiveOrganizeState`（约 3033）、`currentCharGroupCollapsed` / `activeGlobalGroupCollapsed` / `comboGroupCollapsed` 默认值。
- `style.css`
  - `.wbo-cmb-pill-rows`、`.wbo-pill.is-emphasis`、`.wbo-dd-group-note`、`.wbo-s2-badge.is-search-*`、`.wbo-mp-row-actions`、`.wbo-s2-right`。

---

## 4. 测试现状

- 单测：`node --test tests/*.test.mjs` → 245/245 通过。
- 浏览器：`WBO_E2E_SUITE=… node --test tests/*.browser.mjs`。
  - 通过：`native-picker-window` 24/24、`native-mobile-picker-lifecycle` 22/22、`native-global-drawer` 8/8、`native-favorites-touch` 6/6、`organize-combos` 8/8、`native-extras-cleanup` 2/2。
  - 环境性失败（本机无 playwright）：`floating-window`、`manager-favorites`、`prompt-preview`、`manager-tools` 的触屏用例。
  - 偶发：`feedback-round` 某些用例在全量并发时超时，单文件复跑通过。
- 新增测试：`native-picker-window` 中的镜像块、会话 pill、编辑下拉置顶/徽章、眼睛二次点击、绑定弹窗 optgroup、搜索单本/多本；`organize-combos` 中的 pill 两行、强调色、滚动记忆、折叠。

---

## 5. 已知风险 / 审查建议

1. **镜像块与原组行重复**（U1）：隐藏原组行会牵动搜索/选中/收藏三处逻辑，建议先写红测再改。
2. **`renderSelect2OptionResult` 的镜像判断**依赖 `state.element`，若某些 Select2 版本不传该字段，徽章守卫会失效（有兜底清理）。
3. **搜索徽章回填**每次 `decorateGroupItems` 执行，若行被频繁重建可能抖动；已用存在性判断收敛。
4. **全局下拉搜索放宽**后，非匹配 pill 的行可能短暂可见（Select2 matcher 仍会过滤，需复核）。
5. **绑定主世界书**主动初始化 Select2 可能覆盖宿主后续初始化，需在真实 ST 验证是否重复初始化。
6. **`_sessionGlobalPillId` 为页面级内存**，刷新即失；若用户期望持久化需改设置。
7. **移动端两条渲染路径**（mobile picker / 增强浮层）逻辑重复且已漂移，建议后续合并为一套。
8. **所有改动均为模拟视口验证**，未在真实 iOS/TauriTavern 与真实 ST 1.19 上验证；U3/U4/U9/U10 都需要真机证据。

---

## 6. 建议接手顺序

1. U1（去重）——影响最大、最常被反馈。
2. U5（全局下拉搜索分组）——与 U1 相邻，可共用一套「临时分组」实现。
3. U3 + U4（iOS 增强浮层）——合并两条渲染路径后再改。
4. U6（显示名回归）——回 core 层修 `charBookTitleMode`。
5. U2、U7、U8、U9、U10 按用户优先级排。

---

## 7. 提交流程约定（用户要求）

- 每次改完直接推 `dev`，并在回复里给「重点检查」清单。
- 用户是产品决策者，遇到歧义先确认（他多次纠正过理解）。
- 不要擅自改动酒馆原生展示（用户明确要求）。
