# Kernel API 与宿主接入

`@ripple/core` 导出模型、端口、KnowledgeService 和 ExplorationSession；不引用 Node、浏览器或 CLI。Node 组合入口另在 `@ripple/core/node`，HTTP Embedding 在 `@ripple/core/embedding-http`。执行 `npm run build` 后使用包导出。Node 运行时要求 22.16+，本轮验收使用 24.15.0；SQLite 来自 Node 内置模块，较早 Node 版本可能显示实验性警告。

## 创建和关闭

```ts
import { KnowledgeService, ExplorationSession } from '@ripple/core';
import { SqliteStorage, RemarkMarkdownParser, NodeIdentityProvider } from '@ripple/core/node';

const storage = new SqliteStorage('/absolute/outside-vault/kernel.sqlite');
const knowledge = new KnowledgeService({
  storage, search: storage,
  parser: new RemarkMarkdownParser(), identity: new NodeIdentityProvider(),
});
try {
  knowledge.ingestDocuments([
    { id: 'csrf', path: 'CSRF.md', markdown: '# CSRF\nCSRF 与 SSRF 有不同的攻击入口。' },
    { id: 'ssrf', path: 'SSRF.md', markdown: '# SSRF\n服务器端请求伪造。' },
  ]);
  const session = new ExplorationSession(knowledge);
  session.focus('ssrf');
  console.log(session.setLens(50));
  console.log(knowledge.search('CSRF', { mode: 'exact' }));
} finally {
  storage.close();
}
```

已有 Markdown 目录可直接 `await openSqliteVault(vaultRoot, { stateDir })`，返回 `{ service, sources, save, close, stateDir }`。源目录和通过符号链接解析后的状态目录必须分离。SQLite 每次内核修改都已提交，`save()` 保留宿主接口但不另写文件；退出时调用 `close()`。这层不监听目录，外部修改由宿主重新导入。

首次打开有旧 `manifest.json` 的状态目录时，导入 K1～K4 的身份、revision、别名、关系声明与向量缓存。历史仍在 `session.json`，由 CLI 恢复。旧 JSON 文件不删除，后续 SQLite 为活动存储；不要再用 `--storage json` 修改同一状态目录里的旧副本。CLI 现在默认 SQLite；`--ephemeral` 使用内存，`--storage json` 显式选择旧文件宿主。

## 同步知识接口

| API | 返回与行为 |
| --- | --- |
| `ingestDocument(input)` / `ingestDocuments(inputs)` | 返回更新后的 Document；批次原子提交。`id` 保持已知改名身份；`expectedRevision` 拒绝迟到输入；内容和 parser version 未变时跳过解析。 |
| `reindexChanged(inputs)` | 返回改变文档数和 indexRevision。不会自动删除此次未出现的文档。 |
| `removeDocument(id)` / `removeDocuments(ids)` | 删除文档并保留 revision/失效计数；批量删除一次提交。 |
| `getNode(id)` / `listDocuments()` | 返回独立副本；缺失 ID 的 getNode 返回 undefined。 |
| `resolveEntity(name, sourceId?)` | 返回 resolved、ambiguous、missing 或 suppressed。 |
| `findMentions(query)` / `findWikiLinks(query)` | 可按源或目标查询；反向查询保留实际引用方向。 |
| `getRelations(id, { includeHidden? })` | 双向文档发现；确定关系全部保留，语义按每中心预算去重截断；未命中不等于未配置。 |
| `getEvidence(locator)` | valid 带当前对应文本；stale/missing 不返回伪造的新版本文本。 |
| `exportUserDeclarations()` / `importUserDeclarations(data)` | 用户别名和 hide/pin/note 属于持久资料；导入校验后原子替换。 |
| `setRelationOverride(a, b, override)` | 修改显示例外；不改评分。 |
| `setScorePolicy(policy)` | 改参数必须换 version；SQLite 保存策略。 |
| `exportState()` | 完整独立副本，含原文与可能很大的向量缓存；用于迁移/诊断，不放进普通 UI 响应。 |

正文不变复用 AST；只改正文而未改实体名称、路径、章节目标或用户别名时，复用其他文档的引用投影。影响实体解析时重新解析全库引用。名称使用字面 trie；确定关系有按节点的邻接索引。

语义按当前中心精确扫描有效单元；没有后台全库两两配对，也没有 ANN。最多缓存 32 个中心的已截断候选；任何索引提交都清理中心缓存。不同中心的 Top-N 成员可以不同，某一文档对本身的相似度和证据保持对称。长文多单元仍会增加扫描成本。

## 探索与异步 Embedding

`createExplorationSnapshot(id, { lensValue?, visibleBudget? })` 固定候选和分数；`setLens(snapshot, value)` 与 `setVisibleBudget(snapshot, budget)` 返回新副本；`getVisibleRelations(snapshot)` 只过滤已冻结集合，返回 current/stale/invalid 和原因。新中心通过新 Snapshot 进入，旧 Snapshot 不接收后来的召回。

`ExplorationSession` 包装 focus、setLens、loadMore、back、refresh、visible、setViewState、exportState/importState。历史中的布局和相机由宿主负责。详见[协议](protocols/kernel-v1.md)。

`configureEmbedding(provider, config, resolver?)` 选择模型和空间；`indexEmbeddings({ documentIds?, signal? })` 返回编码、复用、丢弃数和逐文档状态。`cancelEmbeddings()` 取消任务，`disableEmbedding()` 停用语义。重启后需要显式配置 Provider，持久向量不自动成为活动能力。[Embedding 文档](embedding.md) 定义切分、模态和重试规则。

## 搜索与证据

`search(query, { mode: 'text' | 'literal' | 'exact', limit })` 返回 documentId、revision、path、title、score、excerpt 和可定位时的 `[start,end)`。这些是搜索命中，不会自动变成 Relation；score 是该搜索排序值，不与关系分数比较。

- `text`：Intl.Segmenter 中文分词后写入 FTS5 unicode61。多个查询词取 AND，BM25 标题权重为正文的 3 倍。比如 `词法作用域`。
- `literal`：原文区分大小写的子串。至少 3 个码点时先用 trigram 筛选，再用原文确认；更短查询走扫描。
- `exact`：在 literal 之上检查完整标识边界。字母、数字、`_.$+/#:-` 都算标识的一部分。`Array.from` 不命中 `Array.fromAsync`，`Qwen3.5-2B` 不命中 `Qwen3.5-2B-Instruct`。对程序符号、型号使用此模式；边界规则有意保守。

查询上限 512 个 UTF-16 单位，limit 为 1～1000，默认 20。UTF-16 offset 对应原文，text 模式可能通过去音调或标题索引命中而没有直接 match。它不伪造精确定位。搜索会看到代码块等完整 Markdown 内容；自然提及仍遵守 AST 可链接范围。

SQLite 搜索与文档提交处于同一事务。另一个实例提交后，旧实例拒绝继续写入或查询；宿主重新打开并重新取得当前状态，不能无限重试旧状态。

## 存储和状态协议

SQLite schema 1 保存 metadata、documents、revisions、declarations、embedding_spaces、vectors 及两个 FTS 表。用户声明和向量物理分表；向量使用 little-endian Float64 BLOB，保留进入内核后的原始数值。持久层不重复归一化。缓存可通过导出状态移除 embedding 后保存来重建，用户声明保持独立。

写入使用 `BEGIN IMMEDIATE`、WAL、FULL 同步，并检查实例加载时的 generation。失败回滚数据库，KnowledgeService 也恢复内存投影；未来未知 schema 显式拒绝。SQLite 并发模型是多实例乐观冲突检测，并非自动合并。不要让外部程序直接改内核表而不递增 generation。

自定义 Storage 必须让 load/save 隔离对象引用，save 原子成功或抛错。可忽略可选的 `StorageWriteOptions`；其中 `embeddingSpacesUnchanged` 是调用方对不可变前后状态作出的保证，SQLite 用它跳过无变化向量表，仍检查 generation 并提交其他数据。直接调用 save 时省略这个选项即可得到完整保存。

`capabilities` 包括协议版本、deterministicRelations、semantic 总体状态、storage kind/persistent/concurrency、search engine/modes。`getIndexCoverage()` 返回 indexRevision、确定索引文档/提及/链接数、逐文档语义状态及搜索能力。覆盖只说明已导入状态，不能检测尚未被宿主告知的磁盘变化。

语义状态有 `not-configured / ready / partial / pending / stale / error / cancelled / limit-exceeded / unsupported`。有可用单元但其余未完成时总体为 partial；全无可用单元时保留 stale、取消、能力或错误原因。逐文档 errors 包含错误码和经过适配器处理的消息。Snapshot 的 stale 是独立概念，表示冻结视图与当前索引有差异。

`KernelError.code` 是导出的 `KernelErrorCode`，枚举在 `KERNEL_ERROR_CODES`：

| 错误 | 宿主处理 |
| --- | --- |
| `INVALID_INPUT` / `INVALID_SNAPSHOT` | 修正输入或舍弃无效历史。 |
| `NOT_FOUND` | 文档/会话已不存在，返回当前可用列表。 |
| `CONFLICT` | revision 或策略版本冲突，读取当前状态后决定更新。 |
| `STORAGE_CONFLICT` / `STALE_INDEX` | 重新打开内核，再由上层决定是否重放操作。 |
| `STORAGE_SCHEMA` | 使用兼容版本或显式迁移，不清库掩盖问题。 |
| `STORAGE` / `CLOSED` | 检查存储生命周期与磁盘状态。 |
| `SEARCH_UNAVAILABLE` | 注入搜索端口或在 UI 隐藏搜索入口。 |

`serializeOperationError(error)` 产生 `{ code, message, retryable, source }`，保留 KernelError / EmbeddingError 的分类，未知异常返回通用 INTERNAL，不把底层异常内容发给客户端。retryable 是恢复后可以重试，不是无条件循环。

## 第二个最小 Host

```sh
npm run host:http -- --vault fixtures/vault --port 4318
```

服务仅绑定 `127.0.0.1`，拒绝浏览器 Origin 与非本机 Host。它用于验证 SDK 可被独立宿主调用；正式浏览器接入、身份认证和网络发布不在本轮。

| 接口 | 内容 |
| --- | --- |
| `GET /v1/capabilities`、`/v1/coverage` | 能力和覆盖状态 |
| `GET /v1/documents`、`/v1/search?q=...&mode=exact` | 文档摘要和搜索 |
| `POST /v1/evidence` | body 为 EvidenceLocator |
| `POST /v1/sessions` | 创建独立 ExplorationSession |
| `POST /v1/sessions/:id` | `{action:'focus',documentId}` / `{action:'lens',value}` / `{action:'more',count}` / back / refresh |
| `GET /v1/sessions/:id`、`DELETE /v1/sessions/:id` | 导出状态或释放会话 |

最多 32 个会话，创建新会话时淘汰 30 分钟未使用的会话；状态保存在进程内。单个请求上限 256 KiB。可用 `--embedding <配置>` 与 `--index` 启用语义，但不会自动开启正式 App。

实现依据：[Node SQLite API](https://nodejs.org/api/sqlite.html)、[SQLite FTS5](https://www.sqlite.org/fts5.html)。
