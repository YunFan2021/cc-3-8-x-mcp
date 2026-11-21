# Prefab 直改流程指南

> 目标读者：使用 Claude Code / MCP agent 操作 CC3.8.x prefab 的开发者。
> 本文聚焦**决策和流程**：什么时候用哪条路径、改完要做什么、有哪些已知坑。
> prefab 文件结构细节见 [prefab-schema.md](./prefab-schema.md)，不在此重复。

---

## 为什么绕过 Cocos 编辑器直改 prefab 文件

Cocos Creator 编辑器将 prefab 序列化为 JSON 文件存储在磁盘上。传统工作流需要打开 GUI → 在场景树里手动操作 → 保存，这在以下场景无法工作：

- **无头环境**：CI / MCP agent / 自动化脚本，没有显示器或不方便启动编辑器。
- **批量修改**：几十个 prefab 同步改文字、布局参数，手动操作成本极高。
- **可重复性**：工具链幂等产物（A/B 变体、多语言注入），需要确定性结果而非 GUI 点击。

直改文件可以做到零 GUI 依赖、秒级完成、可 diff 审计。代价是需要精确理解 prefab 格式，错误写入可能让编辑器报解析错误或静默破坏数据。

---

## 整体架构

**离线操作**通过 CLI 或 Gateway 的 offline 工具读写本地 Prefab，不需要编辑器在线。

**编辑器操作**先用 `gateway_list_editors` 按[项目绑定规则](../AGENTS.md#绑定当前项目)确定目标，再经 Gateway 使用该项目的 AssetDB 和场景工具；客户端不直接访问编辑器私有 Bridge。

---

## 决策表：用 offline 还是 editor？

| 操作 | 推荐路径 | 原因 |
|---|---|---|
| 改普通节点 position / active | **offline**（prefab_edit） | 直接改文件字段，秒级完成 |
| 改普通节点 Label 文字 | **offline**（prefab_edit） | 同上 |
| 改普通节点 SpriteFrame | **offline**（prefab_batch，op: set-sprite-frame） | `set` 子命令不支持，必须走 batch |
| 改 stub 节点普通字段（position / active） | **offline**（prefab_edit） | 工具自动路由到 propertyOverrides |
| 改 stub 节点组件字段（Label._string / Sprite._spriteFrame） | **当前不支持** | 需跨 prefab 读取组件 fileId，未实现；必须在编辑器里手改 |
| 查节点树结构 | **offline**（prefab_query）更快 | 纯文件解析，无需编辑器在线；但看不到运行时动态状态 |
| 查编辑器加载的节点和绑定 | **editor**（`scene_query_node`、`scene_verify_bindings`） | 回读当前实例 |
| 确认资源重新导入 | **editor**（`asset_reimport_confirm`） | 检查 AssetDB 的导入结果 |
| 游戏页面交互或截图 | 获得预览授权后使用浏览器 | 验证实际游戏页面 |
| 改运行时场景节点（非 prefab 文件） | **editor**（scene_set_property） | 场景节点不存在离线文件可直改 |

---

## offline 改完后的操作流程

1. 先核对磁盘差异，保护编辑器中的未保存改动，避免旧实例保存覆盖新文件。用 Gateway 绑定项目后，对需确认的资源调用 `asset_reimport_confirm`，传 `url` 和当前编辑资源的 `expectedAssetUuid`。外层操作完成且 `import.status=imported` 证明导入完成。
2. 回读目标 Prefab 实例。用 `scene_verify_bindings(expectedAssetUuid, checks)` 核对资源引用；`matched` 只覆盖所查字段。导入完成、实例未验证时分别记录。
3. 如确需刷新资产并软重载当前编辑器场景，传 `expectedAssetUuid` 调用 `preview_refresh_and_reload`。只在目标一致、`dirty=false` 时进行；遇到挂起或状态不明先核查，重载后再回读。
4. 用户明确要求游戏预览时，查询项目预览 URL 并在浏览器检查实际画面或交互。“先不预览”时止于已完成的编辑器层级，报告视觉未验。

---

## 踩坑清单

### 坑 1：stub 节点直改字段永远无效

嵌套 prefab 的 stub 节点在父 prefab 中通常只有五个字段（`__type__`、`_objFlags`、`_parent`、`_prefab`、`__editorExtras__`），其余属性全在 `cc.PrefabInstance.propertyOverrides` 里。直接改 stub 节点的 `_lpos` 或 `_active` 字段，编辑器加载时会用 propertyOverrides 覆盖回去，修改静默丢失。

→ offline 工具已自动处理：检测到 stub 节点时自动路由到 propertyOverrides 写入。
→ 手写 ops.json 绕过高层 API 时，必须自己判断 `instance !== null` 再决定写哪里。
→ 详见 [prefab-schema.md § 4](./prefab-schema.md)。

### 坑 2：nestedPrefabInstanceRoots 不同步导致静默数据损坏

根节点 `cc.PrefabInfo.nestedPrefabInstanceRoots` 是 CC3 编辑器识别所有嵌套 prefab stub 的总索引。新增嵌套实例时如果忘记把 stub 节点引用加进这个数组，编辑器不会报错，但在下次保存 prefab 时会把嵌套引用关系覆盖掉，造成子组件引用丢失。

→ offline 工具的 `editPrefab` 路径已自动维护该列表。
→ 手动拼 op 绕过高层 API 时必须自己维护。
→ 详见 [prefab-schema.md § 4 坑二](./prefab-schema.md) 和 cli/README.md 地雷二。

### 坑 3：stub 节点组件字段当前不支持离线写入

覆写 stub 节点的组件字段（如 `cc.Label._string`、`cc.Sprite._spriteFrame`）需要跨 prefab 文件读取该组件的 `cc.CompPrefabInfo.fileId`，当前 offline 工具未实现该能力。调用时会抛 `unsupported` 错误并不落盘。

**当前 workaround**：在 Cocos 编辑器里手动改这类属性，或通过 `editor tool: scene_set_property` 在运行时改（重启后失效）。后续版本将在 overrides.js 中实现跨 prefab fileId 查找。

→ 详见 cli/README.md 地雷一。
