# Knowledge Service / K1–K3 协议

协议版本 `schemaVersion: 1`。本阶段不承诺公开发布后的长期兼容性；序列化结构变更需要显式迁移或拒绝，不静默把旧数据解释成新语义。

## 文档、实体与证据

`Document.id` 是稳定身份，`path` 是 vault 相对路径，`contentHash` 是原文哈希；相同内容的不同文件仍是不同文档。调用方可显式指定 ID，缺省由 IdentityProvider 生成。ID 不允许为空或使用 Object 原型保留键。已知移动/重命名以原 ID 重新 ingest。

`Document.revision` 在内容、路径或解析器版本更新时递增，删除后保留版本计数，再次导入同 ID 不重用旧 revision。`expectedRevision` 提供乐观并发检查；不匹配抛出 `CONFLICT`，不改变状态。`ingestDocuments` 批量构建成功后才保存，解析中途失败不提交任何输入。

`Section` 保留标题路径和范围；其 ID 由文档 ID、标题路径和重复序号组成，插入普通正文不会改变章节身份。章节改名/删除导致旧用户章节别名失效，不静默绑定到同位置的新章节。

`EvidenceLocator` = `documentId + revision + sectionId + [start, end)`。偏移单位是 JavaScript UTF-16 code unit，包含 emoji/CRLF 时也直接对应原始字符串。`getEvidence` 返回 `valid`、`stale` 或 `missing`；旧版本不返回当前文本伪装成旧证据。

名称由文件名、首个 H1、frontmatter title/aliases 和用户声明构建，同名保留多个目标。匹配区分 `resolved / ambiguous / missing / suppressed`。名称匹配忽略大小写并进行 NFC 归一化；路径目标大小写精确匹配。自然提及以最长名称优先，拉丁名称检查词边界。

WikiLink 支持 `[[A]]`、`[[A|展示文字]]`、`[[A#标题]]`、`[[#本页标题]]`、`[[目录/A]]` 和 `[[../目录/A.md]]`。含 `/` 或 `.md` 的目标作为明确路径；无前缀路径相对 vault，`./`、`../` 相对源文档。明确路径不存在时不回退同名实体，重复标题保持歧义。

## 关系

`RelationCandidate` 保留无向文档对及多个有向 `RelationSignal`。当前 Signal 有 `mention` 和 `explicit`，各自保留 `from/to`、所有原始 Evidence 和原始出现次数。语义信号未实现，不以 0 代替“未配置”。

文档对只有一个显示分，两端都可通过 `getRelations` 发现。`findMentions({ targetDocumentId })` 是真正的反向提及查询，保留原始出处；不会因为双向发现而生成相反方向的 Mention。

评分策略包含版本、提及基分、不同章节增量、饱和上限和显式增强系数。参数变化必须更换版本。`getRelations(nodeId)` 默认遵守隐藏声明；诊断时可显式指定 `includeHidden: true`。

用户声明保存别名及以 `relationKey(a, b)` 为键的 hide/pin/note。声明不属于派生缓存。固定只作用于真实存在的候选，不凭空创造关系；隐藏优先。此版本未增加针对某个歧义提及的人工绑定操作，可使用明确路径 WikiLink 指定目标。

## Exploration Snapshot

Snapshot 冻结：中心及其 revision、候选关系和分数、候选版本、评分版本、indexRevision、Lens 映射、可见预算、用户声明快照、文档有效性版本。`setLens`、`setVisibleBudget` 返回新的可序列化对象，不重新检索或重算分数。

Lens 0～100 映射到 `[1, 0]` 的下降阈值；判断条件为 `score >= threshold`。分数与阈值统一保留至 12 位小数，以消除浮点运算噪声。候选按分数降序、关系 ID 确定排序；同分一起通过阈值，显示预算可分页同分节点。固定、候选与数据不变时，增加 Lens 不会移除已显示关系。

候选预算当前为 `{ deterministic: 'all', semantic: 0 }`，不按屏幕 Top-K 截断确定关系。常规显示默认 40 个；固定节点在常规预算之外显示，避免挤走已有节点。`eligibleCount`、`remainingCount`、`pinnedCount` 分别解释合格总数、剩余常规节点、固定节点数。

状态规则：

| 变更 | 旧 Snapshot 行为 |
| --- | --- |
| 新候选或新评分规则 | 标记 stale；旧分数与候选不更新，由宿主显式 refresh |
| 无关文档内容更新 | 标记 stale；原有有效关系保留 |
| 新同名实体使原提及变歧义 | 对应旧关系立即失效，其他有效关系保留 |
| 隐藏/取消隐藏/固定/取消固定 | 实时使用最新用户声明；标记 stale，单调性前提已改变 |
| 邻居被删除或正文 revision 更新 | 对应关系整体撤下，标记 stale，不对冻结分数局部修补 |
| 中心删除或 revision 改变 | invalid，不继续展示旧关系 |
| 删除后重新导入同 ID | 不恢复旧 Snapshot 的已失效关系 |

点击 `refresh` 才创建新候选快照。旧证据部分失效时，本版保守撤下整条关系，刷新后基于有效证据重新评分。这里不实现权限模型；未来宿主撤销访问权限时，需要同步从知识服务中移除文档。

`ExplorationSession` 保存当前状态和 backStack，包括 Lens、预算、布局坐标、相机、阅读位置及当时访问路径。`back` 返回旧状态和明确的当前有效性；`refresh` 会清除已变版本的阅读位置。坐标由宿主决定，内核不运行图布局。

## 索引与持久化

源变化采用同步批量事务，当前没有异步模型任务，因而尚不涉及模型取消/重试。未变 Markdown 复用解析结果；实体索引、提及和关系在变更后重建。迟到写入必须带 `expectedRevision`，由服务拒绝。

`KnowledgeStorage` 的 load/save 均需隔离对象引用，save 应原子成功或抛错。MemoryStorage 是当前实现。Node 文件宿主保存 `manifest.json` 的身份、版本和策略签名，以及单独 `user-relations.json` 的用户声明；启动从原文重建派生数据，无需缓存即可恢复整理成果。`session.json` 单独保存探索历史。文件宿主当前按单进程使用设计。

错误码：`NOT_FOUND`、`CONFLICT`、`INVALID_INPUT`、`INVALID_SNAPSHOT`。可选语义能力通过 `capabilities.semantic = 'not-configured'` 明确暴露。
