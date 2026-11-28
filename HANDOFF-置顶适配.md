# 交接说明：美化脚本「置顶」适配（worldbook-organizer / dev）

> 交接日期：2026-11-28　当前版本：**v2.35.106 → v2.35.107（dev 分支，提交 `422acdb`）**
> 用户已明确表示疲惫：**请勿再向用户提问“是不是这样”“要不要这样”**，直接读证据、改代码、跑测试，用诊断判据自证。
> 若同一现象 **2 轮内未修好**，立即按 `AGENT.md` 派只读审查 agent（本项目已有先例，见第 6 节）。

---

## 1. 环境与产物

| 项 | 值 |
| --- | --- |
| 项目路径 | `F:\MyAiProject\01-酒馆-ST\插件与工具\worldbook-organizer` |
| 分支 | `dev`（**只能推 dev，未经用户同意不得推 main**） |
| 宿主 | SillyTavern 1.19.0 / Edge / Windows 1699×935@1.5x；另有 TauriTavern 2.4.0 / iOS 440×860@3x |
| 第三方脚本 | 「下拉框美化」脚本，把下拉渲染为 `.gr-container-enhanced` / `.gr-option` 结构，自带**置顶**与**收藏**功能 |
| 主文件 | `src/native-filter.js`（约 9.5k 行）、`style.css`、`src/panel-settings.js`、`index.js` |
| 测试 | `node --test tests/*.test.mjs`（245 条单测）；浏览器用例需 `WBO_E2E_SUITE=本轮材料\B03-R2-补充验证\formal-isolated-suite` 再跑 `tests/native-picker-window.browser.mjs`（36 条）等 |
| 用户诊断入口 | 右下角 🩺（单击导出详细 .txt，双击简短）→ 报告含 `trace` / `stages` / `pinProbe` / `ui` / `dom` / `consistency` |

---

## 2. 用户报的确切症状（原话转写）

1. **脚本置顶的世界书，出现在「已开启的全局世界书」分组里**（应裸行显示在全局块**上方**）。
2. **点击置顶会跳转到「★已收藏」分组**（用户视为不可接受）。
3. 「全部」里有时没有「已收藏」分组；收藏角色书后书从原分组消失、也没有收藏块（看起来丢了）。
4. 用户明确要求：**不要**再改「全部 → 关闭 → 重开仍是全部」的记忆行为（这是他想要的）。
5. 🩺 旁的 `↻` 按钮应当是**从 GitHub 更新插件**（已实现为 `POST /api/extensions/update`），不是刷新页面。

---

## 3. 当前实现（v2.35.107 已落地的部分）

`src/native-filter.js` 内 `enhanceCustomDropdownPopover()`：

- **置顶探测**：收集所有 `.gr-option-pin, [class*="pin"]`（排除插件自己的 `.wbo-gr-pin-btn` / `[data-wbo-gr-pin]`），命中 `pinned` / `is-pinned` / `is-active` / `aria-pressed=true` / `data-pinned=1` 即判定置顶；命中形态写入 `_diag.pinProbe`（报告可见）。
- **置顶标记持久化**：命中即写 `optEl.dataset.wboScriptPinned = '1'`；收集阶段 `scriptPinned = dataset === '1' || pinState.length > 0`。
- **优先级**：`if (scriptPinned) → barePinnedOptions`，`else if (isMounted) → mountedGlobalOptions`（两个下拉都走这条）。
- **放置**：编辑器下拉在字符书之后、全局块之前插入裸行；全局下拉在全局块插入后立刻把裸行移到块上方。
- **回填保护**：`syncSpecialSections()` 里 `mountedAndPinned` 回填时跳过 `barePinnedOptions.includes(optEl) || optEl.dataset?.wboScriptPinned === '1'`。
- **点置顶不换分组**：`containerEl._wboOnPinChanged` 只 `delete wboPopoverReady / wboPinSig` 后重跑增强，**不再**调用 `syncPopoverPinnedPill()`。
- **`validGroupIds` 永远包含 `__all__`**（修复“记住全部却开在已收藏”）。

---

## 4. 关键诊断证据（用户提供的报告，可直接复现结论）

v2.35.106 的 `/下载/wbo-diagnostic-2026-11-28T01-48-40-615Z.txt`：

```
pinProbe: cls:pinned | cls:pinned | cls:pinned | cls:pinned | cls:pinned | cls:pinned   ← 探测正常
enh-globals:script-pinned-bare=3                                                        ← 裸行移动执行过
enh-globals:block=1,count=1,role=global,pinnedMounted=1                                 ← 之后重渲染又收进全局块
enh-pill:open=__pinned__,hasMemory=1,remembered=__all__,role=global                     ← 记住 __all__ 却开在 __pinned__
ui: +29.5s down:span.gr-option-pin role=global   → +30.5s down:button.wbo-dd-pill.is-pinned-all
```

**推论**：置顶判定本身没问题，问题在**渲染时序**与**状态持久化**：
- 某一轮渲染 `count` 仍含置顶书 → 说明宿主**重建了行元素**（连 `data-wbo-script-pinned` 一起丢失），或回填路径未覆盖；
- `open=__pinned__` 说明某次渲染时 `validGroupIds` 不含保存值（已在 v2.35.107 补 `__all__`，待验证）。

---

## 5. 下一步排查方向（按优先级，建议逐个用诊断自证）

1. **宿主是否重建行元素**：在 `enhanceCustomDropdownPopover` 入口记录 `realOptionNodes` 的“指纹”（如 `rows.length` + 首行 `data-value` + 是否带 `dataset.wboScriptPinned`），看重渲染前后是否同一批节点。若被重建 → 不能依赖行上的 `data-*`，必须改用**分类/设置侧**判定。
2. **从宿主持久化读取置顶列表**：美化脚本很可能把置顶状态存进 `localStorage`（尝试在页面里枚举 `Object.keys(localStorage)` 找含 `pin`/`pinned` 的键）。若拿到真实列表，判定就与 DOM 无关，最稳。
3. **顺序判定兜底**：脚本通常把置顶行放在列表最前（第一个分组标题之前）。可用「行在第一个 `.wbo-pop-section`/分组标签之前」作为置顶的补充判定。
4. **`syncSections()` 全链路复核**：`mountedAndPinned` 回填、`isPinFilter` 分支、`hidePinnedInGlobal` 三处是否都可能把行送回全局块。
5. **点置顶跳分组**：确认不是宿主脚本自身在 pin 后切换 pill；若是，需要在 pin 点击后**拦截宿主对 pill 状态的写入**（记录 `enh-pill:open` 与 `ui` 的先后即可判断）。

---

## 6. 约束（务必遵守）

- **不要动酒馆原生展示**（用户明确要求）；只读宿主 DOM，不删他人节点。
- 诊断内容**不得包含书名 / 角色名 / 分组名 / 用户输入**，一律用 6 位哈希或长度。
- 移动端（<680px）必须有可用方案；不要引入 hover-only 交互。
- 改完必须给出：`node --test tests/*.test.mjs` 结果 + 相关浏览器用例结果；**不许宣称“已修复”而不给判据**。
- 每次改动：更新 `NEXT.md`（版本 + 行为变化），必要时 `HANDOFF.md`。
- PowerShell 行内改写多行代码曾把函数改坏（`Unexpected token`），**改结构请用脚本读写文件，不要用行内替换**。
- 合并 main 前：`src/native-filter.js` 的 `DEV_QUICK_DIAG_BALL` 必须置 `false`（悬浮球不进 main）。

---

## 7. 验收标准（用户视角）

| # | 操作 | 期望 | 诊断判据 |
| --- | --- | --- | --- |
| 1 | 在美化脚本里置顶一本**同时是全局**的书 | 该书出现在「已开启的全局世界书」**上方**的裸行 | `enh-globals:script-pinned-bare≥1` 且重渲染后 `enh-globals:block` 的 `count` **不含**该书 |
| 2 | 点击该书置顶星 | 列表不切换分组，仍在当前 pill | `enh-pill:open` 前后一致；无 `remember=__pinned__` |
| 3 | 收藏一本角色书 | 「已收藏」块存在且能看到该书（或明确提示已被隐藏） | `enh-globals:block` 存在、`consistency.pinnedMounted` 合理 |
| 4 | 点 🩺 旁的 ↻ | 从 GitHub 检查并更新插件 | `ball:update-done,upToDate=0/1` |
| 5 | 「全部 → 关闭 → 重开」 | 仍在「全部」 | `enh-pill:open=__all__,remembered=__all__` |

---

## 8. 可直接粘贴给新 agent 的提示词

```
你接手一个 SillyTavern 第三方插件 worldbook-organizer 的适配 bug，项目在：
F:\MyAiProject\01-酒馆-ST\插件与工具\worldbook-organizer（git 分支 dev，只能推 dev）。

先按顺序读这三份文件，读完再动手：
1) 本目录的 HANDOFF-置顶适配.md（交接说明，含症状/证据/已尝试方案/验收标准）
2) 插件与工具\AGENT.md（诊断与排障纪律：阶段快照、判据、2 轮不成换审查 agent）
3) NEXT.md 最新 5 条 + src/native-filter.js 中 enhanceCustomDropdownPopover() 全文

必须修复的三件事（都有用户报告作为证据）：
A. 第三方美化脚本自身「置顶」的书，仍被放进插件自建的「已开启的全局世界书」分组；应裸行显示在该分组上方。
B. 点击置顶会跳转到「★已收藏」分组。
C. 「全部」里有时没有「已收藏」分组，收藏角色书后书看起来消失了。

已知事实（不要再从零推理）：
- 置顶探测是成功的：诊断里 pinProbe 连续出现 cls:pinned；
- 裸行移动也执行过：trace 有 enh-globals:script-pinned-bare=3；
- 但随后一次重渲染又把行收进全局块（enh-globals:block 的 count 仍包含它）；
- 并且出现「remembered=__all__ 却 open=__pinned__」。

请优先验证这个假设：宿主脚本在重渲染时替换了行元素，导致写在行上的 data-wbo-script-pinned 丢失。
若是，请改成不依赖 DOM 的判定：从 localStorage / 脚本自身的置顶列表读取，或用「行位于第一个分组标题之前」作为补充判据。
另外检查 syncSections() 的三处回填是否仍会把置顶行送回全局块。

约束：
- 不修改酒馆原生展示；只读宿主 DOM；诊断不得包含任何书名/角色名；
- 移动端可用；
- 改完必须跑 node --test tests/*.test.mjs 与（需要时）WBO_E2E_SUITE=本轮材料\B03-R2-补充验证\formal-isolated-suite node --test tests/native-picker-window.browser.mjs，并在回复里给出「重点检查」表（检查项 / 操作 / 期望 / 诊断判据）；
- 不要向用户重复提问已知需求，不要宣布“已修复”而没有判据；
- 同一现象 2 轮修不好，立即派只读审查 agent（材料：相关函数路径 + diff + 最近 3 份诊断）。
```
