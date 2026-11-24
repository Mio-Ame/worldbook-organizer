# 世界书分组管理 (Worldbook Organizer)

兼容 **SillyTavern** 与 **TauriTavern**（桌面端 & 移动端）的纯前端世界书分组与角色书自动隐藏扩展。

## 核心功能

1. **自动识别角色卡世界书并归组隐藏**
   - 自动读取所有角色卡绑定的**主世界书**（`extensions.world`）、**附加世界书**（`world_info.charLore`）以及可选的**内嵌同名世界书**（`character_book`），全部归入内置「角色世界书」分组。
   - 打开酒馆时**默认隐藏角色世界书**，让 `#world_info`（全局激活）、`#world_editor_select`（编辑选取）以及角色卡「连接到世界书」弹窗默认只展示你的通用/自定义分组世界书。
   - **一键重新打开**：随时点击顶栏「隐藏/显示角色书」按钮、点击分组胶囊或输入 `/wbo`，即可立刻展开查看与编辑角色世界书。
   - **安全保护**：已经在全局激活的书、当前正在编辑的书永远不会被隐藏，避免误关或打断编辑。

2. **角色世界书按角色名显示**
   - 自动将角色卡世界书的主标题显示为**绑定的角色名**（同一角色多本时自动区分主书/附加书），彻底告别原作者五花八门的命名。
   - 默认在角色名后用小字标注作者原标题，也可在扩展设置里切换为「仅显示角色名（彻底隐藏作者原标题）」或「保留原标题」。

3. **AI 智能整理命名与分类（零破坏虚拟别名模式）**
   - **绝不修改底层世界书真实文件名**：AI 整理与手动改名均只生成插件内的**虚拟显示名 + 分组 + 备注**，确保角色卡绑定、User 人设绑定（`persona_descriptions.*.lorebook`）、聊天记录绑定、脚本/正则引用 100% 完好，也无需全盘扫描改引用。
   - 支持两种整理模式：
     - **直接调用当前酒馆 AI**：使用 `generateRaw`（不带聊天历史，省 Token、不污染对话），返回结果先进入**可视化预览勾选与微调界面**，确认后再应用，并支持**一键撤销**。
     - **复制提示词 / 粘贴 JSON**：不想消耗酒馆 API 时，一键复制提示词发给外部 AI，把返回的 JSON 粘回即可预览并应用。

4. **极低负载，绝不时刻扫盘**
   - 无轮询定时器、无后台扫盘、消息收发期间零开销。
   - 基于内存元数据 + 持久化懒加载缓存（兼容 `lazyLoadCharacters: true`），仅在角色/世界书发生变更时做防抖更新，并提供手动「刷新绑定」按钮。
   - AI 整理默认**仅按名称整理（0 读盘，手机端极速）**；仅当手动勾选「附带前 5 条条目关键词摘要」时，才按需读取选中的世界书。

## 安装方式

本插件为纯前端 ES Module，无需打包构建，**SillyTavern** 与 **TauriTavern** 通用：

- **SillyTavern（推荐用户目录）**：将 `worldbook-organizer` 文件夹放到
  `SillyTavern/data/default-user/extensions/worldbook-organizer`（或 `public/scripts/extensions/third-party/worldbook-organizer`），刷新页面即可。
- **TauriTavern**：将 `worldbook-organizer` 文件夹放到
  `data/default-user/extensions/worldbook-organizer`（或通过内置扩展管理器以 Git 仓库安装），重启/刷新即可。

## 快捷命令

- `/wbo` 或 `/wbo toggle`：一键切换角色世界书显隐
- `/wbo show` / `/wbo hide`：显示或隐藏角色世界书
- `/wbo rescan`：手动重新扫描一次角色绑定
