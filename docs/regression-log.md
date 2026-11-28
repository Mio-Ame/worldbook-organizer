# 回归记录与根因台账

> 用途：把「用户报过、修过、又回来」的问题连同**证据链**留下来，避免下一次再从现象开始猜。
> 本文件只做记录与审查，**不代表已改行为**。带「待验证」字样的条目表示假设尚未被真机日志证实。

---

## R-01（2026-11-28 报）文风分组下滚时，置顶的是「已开启的全局世界书」标题

### 现象
全局下拉（普通下拉/「全局世界书」下拉）里点进「文风」胶囊，分组内有约 100 条书。向下滚动时，应该**始终置顶「文风」这一栏**（用户要随时能点它收起分组），但实际留在顶部的是「已开启的全局世界书」的分组标题。

### 复现路径
1. 打开全局下拉 → 点「文风」胶囊（进入分组隔离视图）。
2. 该分组里挂载/收藏的全局书会先以「已开启的全局世界书」块出现。
3. 在分组里向下滚过第二个屏幕高度。

### 根因（两层，互相独立）

**层 A：进入分组后的那个标题根本没有粘滞行程（sticky travel = 0）**
- 该标题是 `<button class="select2-results__group wbo-dd-group-head wbo-global-group-heading">`（`src/native-filter.js:8019-8023`）。
- 从 `27a1802`（v2.35.128）起，它被塞进一个 `<li class="wbo-global-heading-slot">` 里，再把这个 `li` 插到组内第一行之前（`src/native-filter.js:8227-8247`）。
- `styles` 里 `.wbo-global-heading-slot` **一条规则都没有**（`git log -S wbo-global-heading-slot -- style.css` 为空）。这个 `li` 的高度就等于按钮高度。
- CSS 的 `position: sticky` 只在**包含块**范围内生效；包含块只有按钮那么高 → 滚动时按钮跟着一起滚走，永远回不到 `top:0`。
- 对照：真正的分组标题是 `<li class="select2-results__group wbo-dd-group-head wbo-global-group-head">`（`src/native-filter.js:8147`），是 `ul.select2-results__options` 的直接子节点，所以它**能**粘住。用户看到"置顶的是全局块名字"，正是"能粘的那些里最靠上的那个"。

**层 B：即便它能粘，z-index 也不会赢**
- `1dfcfa3`（v2.35.129）加了"按 DOM 顺序逐个头递增 z-index"：
  `[...resultsList.querySelectorAll('li.select2-results__group, .wbo-global-heading-slot')].forEach((head, i) => head.style.zIndex = String(10 + i))`（`src/native-filter.js:8200-8201`、`8263-8264`）。
- 但选择器命中的是**外层 `li`**（slot），而真正 `position: sticky` 的是里面的 `button`。给静态元素写 `z-index` 不产生任何效果。
- 按钮自己的 `z-index` 来自 `.select2-results__group.wbo-dd-group-head { z-index: 4 }`（`style.css:2982-2988`），而全局块标题的 `li` 拿到内联 `z-index:10` → 全局块赢。
- 这层在 `9d821a0` 只解决了"`!important` 压掉内联值"（`z-index: 4 !important` → `z-index: 4`），**没有**解决"内联值写错了元素"。

### 为什么前几轮都没修好
| 提交 | 当时的结论 | 为什么不够 |
| --- | --- | --- |
| `df9a159`（v2.35.128） | 标题搬进列表、放在全局块下面 | 只保证 DOM 顺序；粘滞行程仍为 0 |
| `27a1802`（v2.35.128） | 标题插到该组第一行之前（加 `data-wbo-pill-row` 锚点） | 引入了同高 `li` 包裹层，把 sticky 彻底废掉 |
| `1dfcfa3`（v2.35.129） | 给每个头按顺序递增 inline z-index | 写在外层 `li` 上，且当时被 CSS `!important` 静默压制 |
| `9d821a0`（v2.35.129） | 去掉 `!important`，让 inline 值生效 | inline 值本身写在非粘滞元素上；且按钮 z=4 < 10 |

共同盲点：三次验证用的都是**DOM 顺序/文本探针**（断言 `HEAD[__active_globals__] → rows → SLOT[文风]`），**没有任何一条断言滚动后的几何位置**（`getBoundingClientRect().top` 或 `elementFromPoint(中心点)`）。DOM 顺序对、粘滞行为错，探针全绿。

### 修复方向（下一轮再做，本轮不改行为）
- 方案 1（最小）：把 `.wbo-global-heading-slot` 本身设为 `position: sticky; top: 0;`，并把递增 z-index 写到**粘滞的那个元素**上（slot 或 button 二选一，不要两层各写一半）。
- 方案 2（更彻底）：干掉 slot 包裹层，直接把 `button` 作为 `ul` 的直接子节点插入（与其它分组标题同构），沿用同一套 sticky + z-index 规则。
- 无论哪种，都要先确认「当前进入的分组标题的 z-index 必须大于它上方所有块」这一条，而不是"按 DOM 顺序递增"（`全部` 视图下紧接着的下一组标题会拿到更大的值）。
- 验收必须加**几何断言**：滚到分组中部后，`document.elementFromPoint(listRect.centerX, listRect.top + 4)` 的所属标题文本应为「文风」。

### 与 AGENTS.md 的关系
- 直接复用了 AGENTS.md 第 4 条（全局块必须第一、进组后标题要进列表内），但该条只规定了**顺序**，未规定**粘滞**，是本次漏检的制度性原因；建议给 AGENTS.md 第 4 条补一句「进组标题必须自身可粘滞，且 z-index 高于全局块」。

---

## R-02 已修过又回来的模式（审查结论）

### 模式 1：样式层静默覆盖脚本层
- 证据：`212df98`（v2.24.0）写 `z-index: 4 !important`；`1dfcfa3`（v2.35.129）才加内联 z-index，随后被这条 `!important` 静默吃掉，直到 `9d821a0` 才发现。
- 教训：凡是 JS 写内联样式去"抢层级/抢定位"，必须先 grep 同名属性的 `!important`。同类风险点还有 `position/top/display`（`.wbo-dd-group-head` 用了 `position: sticky !important`）。

### 模式 2：包裹层吃掉粘滞
- 证据：`27a1802` 为"把标题放到组内第一行之前"加了 `li.wbo-global-heading-slot`，DOM 顺序达标，粘滞能力归零。
- 教训：任何 `position: sticky` 元素，其父级高度决定了它的活动范围；插桩/包裹前先算"粘滞行程"。

### 模式 3：验证口径只看 DOM，不看几何
- 证据：`df9a159`/`27a1802`/`1dfcfa3`/`9d821a0` 四轮的验证都是 DOM 序列探针。
- 教训：涉及"置顶/固定/吸顶/悬浮"的修复，验收必须包含滚动后的 `getBoundingClientRect()` 或 `elementFromPoint()` 断言。

### 模式 4：同一容器被多方写入
- 证据：AGENTS.md 第 4 条（第三方脚本也会往 `.select2-results__options` 塞分组标题，后写者覆盖）；相关修复 `ec22c1e`（外部下拉「全部」胶囊禁用粘滞重叠）、`bca0e71`、`2c3b929` 都在这一个容器上打补丁。
- 教训：一次性插入必然被后续重建覆盖；顺序/层级必须**每次 sync 后幂等校正**（`enforceSelect2GroupOrder` / `enforceShellGroupOrder` 已是这个形态，但"粘滞层级"没有纳入这套幂等校正）。

### 模式 5：同一主题反复修复（统计）
`git log --grep=sticky` 命中 8 次（`212df98`、`db2b84b`、`ec22c1e`、`bca0e71`、`2c3b929`、`df9a159`、`27a1802`、`1dfcfa3`、`9d821a0`）。集中在两个下拉（原生 Select2 结果列表 + 插件自绘外壳）的同一块逻辑上。
- 教训：这套"分组标题"逻辑应当收敛成一处（一个函数负责 顺序 + 粘滞 + 层级），现在分散在 `layoutGlobalGroupRows`、`syncResults`、`enforceSelect2GroupOrder`、`enforceShellGroupOrder` 四处，任一处漏改就复现。

---

## R-02b 最近一天的提交审查（2026-11-28 13:49 → 15:49，`596e25c` → `9d821a0`）

方法：对区间内每个**非合并**提交取它新增的代码行，再检查这些行在 `9d821a0`（本轮重构前的最后一个提交）的树里是否还存在。**在树里消失 = 后来被改写或删掉**。版本号行属于正常差分，已从结论中排除。

| 提交 | 新增行 | 消失 | 消失的是什么 | 判读 |
| --- | --- | --- | --- | --- |
| `a1c61d0` v123 | 235 | 8（含 2 版本号） | 弹窗跟进匹配的几行（`dialogArmed`/`elTagClass(dialogEl…)`）、`OWN_UI_SELECTOR` 拼接续行 | 被 `a024a80`（v125）的"弹窗跟进优先匹配同一动作"重写——**有意的精化**，不是回退 |
| `694fc6c` v124 | 20 | 2（版本号） | — | 修复完整保留 |
| `a024a80` v125 | 44 | 2（版本号） | — | 修复完整保留 |
| `8fe244f` v126 | 35 | 2（版本号） | — | 「不再每次按压重排两个 select」完整保留，没有被人加回去 |
| `57d546c` v127 | 105 | 6（含 2 版本号） | 四条 `hoist…` 的 trace 调用（`enh-globals:hoisted=1…`） | 被 `effccf1`（v128）的 `enforce…GroupOrder` 幂等校正取代——**机制换代**：一次性插入改成每次 sync 后校正 |
| `effccf1` v128 | 128 | 2（版本号） | — | 行属性自愈、目标书双写完整保留 |
| `df9a159` v128 | 24 | 2 | `let slot = headingHost.querySelector(':scope > .wbo-global-heading-slot');` 与 `resultsList.insertBefore(slot, globalsHead.nextElementSibling);` | **7 分钟后被 `27a1802` 推翻**：标题位置从"跟在全局块后面"改成"组内第一行之前" |
| `27a1802` v128 | 21 | 0 | — | 完整保留（但它引入的 `li` 包裹层正是 R-01 层 A 的成因） |
| `f42d53a` / `1dfcfa3` v129 | 71 / 18 | 0 | — | 完整保留 |
| `9d821a0` v129 | 1 | 0 | — | 完整保留 |

### 结论（可以直接回答「为什么修好了又回来」）
1. **没有发生"代码级回退"**：这一天里没有任何提交把别人刚修好的行改回旧写法。
2. 真正让现象"回来"的是三种机制，且都在同一块 UI 上：
   - **同一处逻辑在十几分钟内被改写两次**（`df9a159` 15:17 → `27a1802` 15:24；`57d546c` 14:55 的 hoist → `effccf1` 15:06 的 enforce）。前一次的结论被自己推翻，用户看到的版本取决于他什么时候装的包。
   - **修复被别层静默吃掉**（`212df98` 的 `z-index: 4 !important` 压掉 `1dfcfa3` 的内联层级，直到 `9d821a0` 才被发现——跨 100+ 个版本）。
   - **修复位置对、机制错**（R-01 层 A：标题被塞进同高 `li`，`position: sticky` 行程归零，DOM 顺序探针全绿）。
3. 可复用的判据：**同一个"置顶/顺序"现象如果连续修了 3 次以上还在，先怀疑验证口径（几何断言缺失）与样式层覆盖，而不是再改一次位置。**

---

## R-03 待观察（真机未定）
- `enhancedScript.active=true` 但 `compatDropdownScript=false` 两条检测口径不一致（v2.35.126 记录，未改动）。
- iOS 上条目列表 `pager.pageSize=5`，「重复」后行数不变属正常（分页），见 AGENTS.md 第 5 条。
