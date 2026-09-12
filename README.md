# Ripple

已实现设计基线 1.1 的 **K1～K4、K5 评估工具与 K6 内核稳定化**：从 Markdown 构建可追溯的确定性与语义关系，以当前文档为中心进行一跳渐进探索。交付物是 TypeScript Core、SDK、Node/SQLite/HTTP 适配器、两个最小宿主和 WeMM 2B 本地部署脚本。K5 的真实用户有用性标签仍待人工复核。


Vue 工作台已加入 Electron 桌面壳、公开 Web/iframe、只读 MCP 和 DeepSeek Harness 集成。运行方法与实际验收边界见 [工作台文档](docs/workbench.md)。

## 运行

需要 Node.js 22.16 或更新版本；本轮验证使用 24.15.0。

```sh
npm ci
npm run check
npm run cli -- --vault fixtures/vault --commands fixtures/demo.txt --ephemeral
```

用真实 iWiki 启动交互式 Playground：

```sh
npm run cli -- --vault /Users/alpha/Documents/ChatGPT/iWiki
```

存在 `Wiki/` 时默认只导入该目录中的 Markdown，路径仍相对整个 vault，能解析 `[[Wiki/Frontend/...]]`。使用 `--all-markdown` 可显式纳入其他目录；隐藏目录、符号链接和 AGENTS.md 不作为知识内容导入。

CLI 默认使用 SQLite，将文档索引、身份、用户声明和向量保存到**当前工作目录**的 `.ripple/<vault标识>/kernel.sqlite`，探索历史另存 `session.json`，不写回源知识库。`--state-dir <目录>` 指定位置；`--ephemeral` 使用内存。状态目录必须位于源知识库外部。第一次使用 SQLite 会迁移同目录旧 JSON 状态；后续应继续使用 SQLite，避免修改遗留副本。`--storage json` 保留旧宿主。SQLite 通过事务和 generation 拒绝并发覆盖，冲突后重新打开内核。

```text
focus Event Loop
lens 0
lens 50
lens 70
relations
evidence 1
focus Web Workers
back
relations all
quit
```

`evidence` 可接可见行号或目标名称。其他命令包括 `read`、`nodes`、`more`、`refresh`、`hide`、`unhide`、`pin`、`unpin`、`status`、`help`，以及 SQLite 下的 `search`、`search-literal`、`search-exact`。`relations all` 查询当前全部已召回关系，不受 Lens 裁剪；被用户隐藏的关系仍保持隐藏。

可选启用真实 Embedding，在一个终端启动模型，另一个终端索引：

```sh
npm run wemm:start
npm run cli -- --vault fixtures/embedding --embedding configs/embedding.wemm-local.json --index
```

默认 **Text Only**，不会因为 WeMM 支持图片就读取图片。换用 `configs/embedding.wemm-multimodal.json` 可开启文本与图片上下文索引。`index <名称>` / `index all` 显式更新，`coverage` 查看逐文档状态。本地和云端配置、切分规则、空间隔离与一键部署细节见 [Embedding 文档](docs/embedding.md)。首次运行会下载约 5.44 GB 权重；本地实测结果见 [验证记录](docs/validation.md)。

## 已实现的行为

- **K1 / Markdown → Knowledge Model**：AST 解析、文件名/主标题/frontmatter 名称与别名索引、自然提及、明确 WikiLink、章节目标、歧义与缺失状态、反向查询、UTF-16 证据位置、正文版本和变更更新。
- **K2 / Relation Engine**：候选生成与评分分离、双向发现、保留信号原始方向、重复提及饱和、章节覆盖增量、显式链接增强、用户隐藏/固定/备注及声明导入导出。
- **K3 / Exploration Engine**：冻结候选与分数的 Snapshot、0～100 Lens、单调展开、候选与显示预算分离、明确分页、过期和失效状态、序列化会话及历史恢复。
- **K4 / Embedding**：可替换 Provider、默认文本/可选图文策略、按章节与 token 预算切分、两端贡献片段、文档去重召回、增量缓存、取消/重试/迟到结果隔离；本地 WeMM 与云端 HTTP 适配。
- **K5 / Relation Eval**：240 对四级参考标签、分离开发/测试集、相同候选预算、真实 WeMM、P@3/nDCG、难负例、锁定校准与真实 Wiki 人工复核队列；标签来源和质量边界见[评估报告](docs/relation-eval.md)。
- **K6 / 稳定化**：SQLite 事务/冲突检测/旧状态迁移，中文及符号/型号 FTS，按中心语义检索，1k/5k/10k 实测，覆盖和错误协议，独立 HTTP Host；见[Kernel API](docs/kernel-api.md)和[规模验证](docs/kernel-stability.md)。

一篇文档就是一个图节点。章节用于实体目标、证据和评分聚合，不自动成为全局概念节点。原 Markdown 原样保留，阅读装饰由宿主依据 Mention 提供，不插入链接或改写段落。

同一文档对共享一个关系显示分。A 提到 B 时，A 与 B 都能发现彼此，但证据始终记录 `A → B`；不会伪造反向提及或学习依赖。

当前策略 `mention-explicit-v1`：

```text
M = 有自然提及时 min(0.8, 0.5 + 0.1 × (不同源章节数 - 1))，否则 0
E = 有有效显式链接时 1，否则 0
R = M + 0.3 × E × (1 - M)
```

同一章节重复再多次也不会继续加分，但所有有效位置保留。显式链接里的文字不重复计为自然提及。仅有明确 WikiLink 的关系也会形成候选，得分 0.3。启用 Embedding 后，基数变为 `max(M, S)`，再作相同显式增强；S 来自可配置的分模态余弦映射。分数用于展示，不代表概率、知识重要性或掌握程度；未配置 Provider 时语义状态为 `not-configured`。

Lens 从 0 到 100 对应阈值从 1 到 0，分数与阈值统一消除小数运算噪声。默认聚焦取第 3 个候选的分数作为阈值，不足 3 个时取最后一个候选，且不低于 0.5；同分节点同时通过，不保证恰好 3～6 个。当前所有有效确定关系都进入候选池，默认展示其中前 40 个，`more` 增加显示预算。固定关系是预算之外的显式视图例外，隐藏优先于固定，两者不修改分数。

## SDK

先执行 `npm run build`，再使用包导出：

```js
import { ExplorationSession } from '@ripple/core';
import { createNodeKernel } from '@ripple/core/node';

const knowledge = createNodeKernel();
knowledge.ingestDocuments([
  { id: 'csrf', path: 'CSRF.md', markdown: '# CSRF\n\nCSRF 有别于 SSRF。' },
  { id: 'ssrf', path: 'SSRF.md', markdown: '# SSRF\n\n服务器端请求伪造。' },
]);

const session = new ExplorationSession(knowledge);
session.focus('csrf');
session.setLens(50);
const relation = session.visible().relations[0];
console.log(knowledge.getEvidence(relation.signals[0].evidence[0]));

session.focus('ssrf');
session.back();
const savedSession = JSON.stringify(session.exportState());
```

`@ripple/core` 和 `@ripple/core/core` 不引入 Node、DOM、UI、模型或宿主库。`@ripple/core/node` 是明确的 Node 组合入口；其他宿主可以向 `KnowledgeService` 注入自己的 `MarkdownParser`、`KnowledgeStorage` 和 `IdentityProvider`。所有公开返回对象都与内部状态分离。

用户别名可通过 `exportUserDeclarations()` / `importUserDeclarations()` 配置；它们可以指向文档或稳定章节 ID。一字符名称默认不自动关联，可用用户声明的 `allowShort` 明确开启。通用名称如“概述”“总结”不作为自然提及匹配目标。不存在的实体不自动创建文档。

## 结构与协议

```text
packages/core/          模型、端口、实体解析、提及、关系和探索
packages/sdk/           跨宿主探索会话与公开导出
packages/adapters/      Markdown、内存、SQLite/FTS、HTTP 与只读文件导入
apps/playground-cli/   CLI 宿主
apps/http-kernel/      最小 HTTP 宿主
packages/eval/        关系指标和人工发现标注协议
fixtures/              可提交的合成回归样本
tests/                 解析、评分、探索性质、持久化和实际 CLI 测试
scripts/               独立 SDK 验收入口
docs/                  计划、协议、架构决策与验证说明
```

详见 [实施计划](docs/implementation-plan.md)、[内核协议](docs/protocols/kernel-v1.md)、[架构决策](docs/adr/0001-kernel-first.md) 和 [验证说明](docs/validation.md)。

## 当前边界

尚未实现 ANN、正式桌面/网页界面、布局算法、Mark-it、MCP 或 Agent。坐标、相机和阅读位置由宿主提供，SDK 负责恢复。当前语义按中心精确扫描，万篇规模使用每篇一个合成 2048 维单元测试，不能等同于万篇长文的模型编码或完整 App 性能。

未变文档复用 AST；正文变化但实体目标不变时，其他文档的引用投影也复用。影响名称、路径、章节目标或用户别名时重新解析引用。已知文件改名由 SDK 传入原 ID；不会依据相同内容强行认定身份。K5 校准只基于合成参考标签，默认语义映射保持原值，真实“意外但有用”的关系仍待用户标注。

目前在 AST 的可链接文本片段内匹配原始名称，不跨加粗等格式节点拼接名称，也不将 HTML 实体编码还原后匹配。Obsidian 图片嵌入可用于 MultiModal 单元；笔记嵌入、块 ID 和其他自定义 Markdown 扩展未作为独立关系类型实现。

## 真实笔记验收

```sh
npm run validate:vault -- /Users/alpha/Documents/ChatGPT/iWiki
```

验收只读取输入文件；编辑与过期测试在内存副本上执行。报告输出至被忽略的 `reports/local/iwiki-validation.json`，包含关系/证据检查、展开曲线、历史恢复和导入前后文件哈希比较。此工具验证 K1～K3 的运行正确性，不输出推荐质量、语义效果或学习收益结论。

## 评估与第二个宿主

```sh
npm run eval:relations -- --stage replay
npm run benchmark:kernel -- --documents 10000
npm run host:http -- --vault fixtures/vault --port 4318
```

前者可离线复算固定评估结果；规模测试不调用模型；HTTP Host 只绑定本机回环地址。API、生命周期、错误与搜索模式见[接入文档](docs/kernel-api.md)。
