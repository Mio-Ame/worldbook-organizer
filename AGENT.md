# AGENT.md — 插件开发通用约定（问题诊断 / 悬浮球 / 升级机制）

> 适用于 `F:\MyAiProject\01-酒馆-ST\插件与工具\` 下所有插件与其 AI 协作者。
> 目的：让「用户描述现象 → AI 定位」这一步不再靠反复猜测。

## 1. 每个插件必须内置「问题诊断」

入口要求：**一键可得**、**无需开控制台**、**输出可直接粘贴/下载为文本**。

诊断内容至少包含（顺序无关，字段名固定）：

| 分区 | 必须内容 | 说明 |
| --- | --- | --- |
| `env` | 插件版本、宿主（SillyTavern / TauriTavern）、**宿主版本号**、浏览器、系统、视口尺寸与 DPR、移动端判定、当前渲染路径、相关第三方脚本是否启用、主题名 | 宿主版本走多级兜底：`ctx.version → ctx.versionName → SillyTavern.version → #version_display` |
| `counts` | 插件处理对象的规模统计（条目数、分组数、隐藏数、缓存数等） | 只给数量，不给名字 |
| `flags` | 影响行为的关键开关快照 | 复现问题时先看这里 |
| `actions` | 用户可感知的操作记录（打开面板、切换分组、选中项…） | 环形缓冲，保留最近 20–40 条 |
| `ui` | **带时间戳**的交互流：`+12.3s down:button.wbo-dd-pill role=global` | 让报告可当时间线读；元素用 `tag#id.class`+角色描述 |
| `trace` | 渲染管线关键分支的面包屑，形如 `enh-panel:matches=3,shown=3` | 每条都是「一次判定结果」，能直接指出卡在哪一步 |
| `errors` | 最近若干条异常（文本截断 + 脱敏） | 不能为空却报“一切正常” |
| `dom` | 关键节点的**数量与可见数量**（有则 ≥0） | 关闭后再取会全是 0，所以要在处理路径里即时记录 |
| `runs` | 各处理函数被调用的次数 | 判断「没执行」还是「执行了但没效果」 |

**隐私红线**：绝不输出书目名、角色名、分组名、用户输入文本。需要关联时用 6 位哈希（`w=0a1f3c`）或长度。

**实现要求**

- 提供 `window.<plugin>BuildDiagnostic(mode)`，`mode` 至少支持 `short`（人读）与 `dev`（完整 JSON）；
- 文件下载走后端无关的 Blob 路径，文件名带 ISO 时间戳；
- 记录函数必须 `try/catch` 包裹：日志永远不能弄坏 UI；
- 新增/修改功能时同步新增对应 `trace` 面包屑，命名风格 `<模块>:<关键量>=<值>`。

## 2. 每个插件必须内置「诊断悬浮球」（dev 分支）

- 右下角固定圆形按钮，`z-index` 高于业务 UI，样式内联（不依赖主题变量）；
- **单击 = 导出详细诊断**，**600ms 内双击 = 导出简短版**；
- 开关常量形如 `DEV_QUICK_DIAG_BALL = true`，合并到 main 前改为 `false`（整体不渲染，不留残留 DOM）；
- 点击必须 `stopPropagation()`，避免触发宿主抽屉/弹窗的「外部点击关闭」。

参考实现：`worldbook-organizer/src/native-filter.js` 的 `installQuickDiagBall()`。

## 3. 排障纪律（给 AI）

1. **先看证据再改代码**：拿到诊断后先读 `trace` / `ui` / `dom`，明确「哪一步没发生」再动手。
2. **一个现象 ≤ 2 轮修不好，立即引入另一个 agent 做只读审查**：把当前 diff、相关文件路径、最近 3 份诊断一起给它，要求它产出「高危/中危/低危 + 最小修法」；
   审查结论优先于继续猜测，尤其是「重复失效」的场景。
3. **修完必须说明验证方式**：单测/浏览器用例跑了哪些、结果如何；不许只说“已修复”。
4. **不要用关键词匹配代替理解**：现象描述可能口语化，按其**语义**映射到具体代码路径。
5. **涉及宿主/第三方脚本 DOM 时**：只读不删、不动他人节点；自己的定位/样式优先用「就地插入 + 继承宿主配色」而不是浮动层抢层级。
6. **每次改动**：更新 `NEXT.md`（版本 + 行为变化）、必要时更新 `HANDOFF.md`，并在回复里给「重点检查」清单。

## 4. 诊断字段模板（可直接复制）

```js
{
  env: { pluginVersion, host, hostVersion, browser, os, viewport, mobileViewport, renderPath, compatScript, theme },
  counts: { /* 规模统计 */ },
  flags: { /* 关键开关 */ },
  actions: [ 'open-panel', 'switch-group:id' ],
  ui: [ '+12.3s down:button.wbo-dd-pill role=global' ],
  trace: [ 'panel:matches=3,shown=3' ],
  errors: [ '…' ],
  dom: { rows: 142, rowsVisible: 140, heads: 12 },
  runs: { decorate: 3, layout: 1 },
}
```
