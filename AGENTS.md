# 项目记忆：已知回归点与硬性约束（Worldbook Organizer）

本文件记录**已经被真实用户日志验证过**的坑，凡是再动相关代码，先读这里。新增一条的格式：
「现象 → 根因（宿主/浏览器机制）→ 必须遵守的做法 → 回归验证点」。

---

## 1. 移动 / 复制条目到其他世界书：目标书里没有条目

- **现象**：行内「移动或复制条目到其他世界书」→ 选目标书 → 确认 → 弹窗关闭，目标书没有新条目，源书也不变，控制台无错误。
- **根因**：SillyTavern 的 `move_entry_button` 处理器用**原生监听**保存目标索引，确认时不回读 `<select>`：
  ```js
  let selectedWorldIndex = -1;
  select.addEventListener('change', function () {
      selectedWorldIndex = this.value === '' ? -1 : Number(this.value);
  });
  const popupConfirm = await popup.show();
  if (selectedWorldIndex === -1) return;      // 静默返回
  const selectedValue = world_names[selectedWorldIndex];
  ```
  我们曾用 `$(selectEl).trigger('change')` 写值——jQuery 的 `.trigger()` **只跑 jQuery 处理器，不派发 DOM 事件**，原生监听收不到 → 索引停在 -1。
- **必须**：给宿主 `<select>` 派发**原生冒泡** `change`（`el.dispatchEvent(new Event('change', { bubbles: true }))`）。jQuery 处理器挂在 `addEventListener` 上，同样会收到；**不要**再以 `.trigger('change')` 作为唯一手段（否则 jQuery 处理器会跑两次）。
- **回归验证**：`wboBuildDiagnostic('compact').actions[].dlg.tgt` 不该是 `EMPTY@…`；`picker.applied` 应为 `ok`。

## 2. 行内「复制 / 移动 / 删除」毫无反应（连弹窗都没有）

- **现象**：点击后什么都没有，无弹窗、无 toast、无报错。
- **根因**：宿主行动作依赖行上写死的属性：
  ```js
  const sourceWorld = $(this).attr('data-current-world');   // 建模板时的书名
  const sourceUid = $(this).attr('data-uid');
  const sourceName = sourceWorldInfo.entries[sourceUid]?.comment;
  if (sourceName === undefined) return;                     // 静默返回
  ```
  「重复 / 删除」用的是 jQuery `.data('uid')`，**克隆行即丢失**；行被重建 / 复用 / 重排后 `data-current-world` 可能指向旧书。
- **必须**：在**捕获阶段**点击原生动作按钮时（早于宿主处理器）调用 `repairNativeRowActionAttrs()`；并在 `applyAllNativeWorldFilters()` 之后、`deferGlobal` 延迟分支结束后各调用一次（幂等）。新增任何“重建行/重排行/复用行”的渲染路径，都要在这之后补一次。
- **回归验证**：报告里 `native-entry:row-attrs-repaired=N` 与动作条目 `attrsRepaired`；把 `data-current-world` 人为改错后点击，宿主必须读到正确书名。

## 3. iOS/安卓「点不开」普通下拉、全局列表跟着闪动

- **现象**：手机端点编辑世界书触发器没反应，要点好几次；同时全局世界书列表肉眼闪动。
- **根因**：`pointerdown` 里把 80+ 个隐藏 `<option>` 塞回两个 `<select>` → 面板当场重排 → iOS/Tauri 在布局位移超过阈值时**取消合成出的 click**（日志里表现为 `down>up` 且没有 `click`）。
- **必须**：**禁止在 `pointerdown`（或 touchstart）里做会改变布局的 DOM 变更**。补全目标书候选的动作只放在“点击原生动作按钮”的捕获阶段（`restoreForNative('action-click')`）与弹窗打开时。
- **回归验证**：手势记录 `movedPx` 应接近 0、`selectsMoved=false`；`miss` 不应大量出现 `no-click`。

## 4. 全局下拉分组顺序错乱（全局块被压、未分组跑前面、进组后标题位置）

- **现象**：`文风 → 已开启的全局世界书 → 全局那几本 → 文风组内书`；或「未分组」紧跟全局块；或进组后标题插在全局标题与全局行之间。
- **根因**：
  1. 该渲染器用了原始 `_latestClassification.orderedSections`，而设置面板/`diff` 用的是 `orderSectionsForExternalDropdown()`（它才会把「未分组」排最后）——两边口径必须一致；
  2. 进入某个分组后的标题是**插在整个结果列表外面**的独立元素，视觉上必然压过列表内的全局块；
  3. 别的脚本也会往同一个 `.select2-results__options` 里塞分组标题，任何一次性插入都可能被后写覆盖。
- **必须**：下拉与设置面板共用 `orderSectionsForExternalDropdown`；全局块永远第一；进组后标题**放进列表内、按 `data-wbo-pill-row="1"` 的锚点插在该组第一行之前**；每次重建 / 每次 sync 后调用 `enforceSelect2GroupOrder()` / `enforceShellGroupOrder()`。
- **回归验证**：`nativeEntries.groupOrder` 应为 `__active_globals__ → <分组> → … → __ungrouped__`，且不应出现 `:outside` 的分组标题。

## 5. 行数没变 ≠ 条目没变（分页）

- 宿主条目列表**分页**（桌面 25/页，iOS 5/页）。「重复」后 `rows` 仍 25 是正常的，第 26 条在下一页。
- **必须**：判定“有没有变化”用 `rowIds{count,hash}`（uid 集合指纹）与 `pager.atPageBoundary`，不要只看行数。
- **回归验证**：动作条目 `rowSetChanged`、`uidsBefore/uidsAfter`。

## 6. 诊断必须在手机上导得出来

- 完整 dev JSON 真机约 200 KB，手机/Tauri 常常导不出 → 全部白抓。
- **必须**：保留 `wboBuildDiagnostic('compact')`（约 1.3 KB，含 `native/actions/gestures/picker/trace`）；诊断菜单三项（下载详细 / 复制精简 / 复制简要）；手机上优先 `navigator.share` → `<a download>` → 剪贴板兜底。
- **回归验证**：`native-picker-window` 里诊断菜单断言为 `['dev','compact','short']`。

## 7. 测试环境的两个陷阱

- **mock jQuery 会骗人**：测试宿主用的是简化版 jQuery，它的 `.trigger()` **会**派发真实事件，正好抹平真 jQuery 的差异——所以“change 事件”类修复必须用「jQuery 打桩 + 原生监听」验证，别只信 mock。
- **E2E 前清理浏览器残留**：`本轮材料/**/.edge-profile-*` 积多了会出现 `EPERM`（Windows 文件锁）与 `waitForCondition` 5s 超时，会被误判成代码回归；跑套件前先删干净。

## 8. 仓库守卫

- `NEXT.md` 里**禁止出现第三方脚本名**（单测 `Forbidden third-party reference` 会红），需要提及时写“第三方脚本”并脱敏 class 前缀。
- 版本号三处同步：`manifest.json` / `index.js(STYLE_ASSET_VERSION)` / `src/native-filter.js(PLUGIN_VERSION)`。
- 推送策略：**默认只推 `dev`**；`main` 只在用户明确要求时推。

## 9. 基线验证

- `node --input-type=module -e "import('./src/native-filter.js').then(...)"` → `loads`
- `node --test tests/*.test.mjs` → **247/247**
- `WBO_E2E_SUITE=本轮材料\B03-R2-补充验证\formal-isolated-suite node --test tests/native-editor-titles.browser.mjs tests/native-picker-window.browser.mjs` → **56/56**
