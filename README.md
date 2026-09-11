# Ripple Knowledge Kernel

已实现设计基线 1.1 的 **K1、K2、K3**：从 Markdown 构建可追溯的确定性关系，以当前文档为中心进行一跳渐进探索。交付物是 TypeScript Core、SDK、Node 适配器和 CLI。

## 运行

需要 Node.js 22 或更新版本。

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

CLI 默认将文档身份、用户声明和探索历史保存到**当前工作目录**的 `.ripple/<vault标识>/`，不写回源知识库。可使用 `--state-dir <目录>` 指定位置；`--ephemeral` 完全使用内存。状态目录必须位于源知识库外部。当前文件适配器按单个 CLI 进程使用设计，不提供多个写入进程的并发协调。

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

`evidence` 可接可见行号或目标名称。其他命令包括 `read`、`nodes`、`more`、`refresh`、`hide`、`unhide`、`pin`、`unpin`、`status` 和 `help`。`relations all` 查询当前全部确定关系，不受 Lens 裁剪；被用户隐藏的关系仍保持隐藏。

## 已实现的行为

- **K1 / Markdown → Knowledge Model**：AST 解析、文件名/主标题/frontmatter 名称与别名索引、自然提及、明确 WikiLink、章节目标、歧义与缺失状态、反向查询、UTF-16 证据位置、正文版本和变更更新。
- **K2 / Relation Engine**：候选生成与评分分离、双向发现、保留信号原始方向、重复提及饱和、章节覆盖增量、显式链接增强、用户隐藏/固定/备注及声明导入导出。
- **K3 / Exploration Engine**：冻结候选与分数的 Snapshot、0～100 Lens、单调展开、候选与显示预算分离、明确分页、过期和失效状态、序列化会话及历史恢复。

一篇文档就是一个图节点。章节用于实体目标、证据和评分聚合，不自动成为全局概念节点。原 Markdown 原样保留，阅读装饰由宿主依据 Mention 提供，不插入链接或改写段落。

同一文档对共享一个关系显示分。A 提到 B 时，A 与 B 都能发现彼此，但证据始终记录 `A → B`；不会伪造反向提及或学习依赖。

当前策略 `mention-explicit-v1`：

```text
M = 有自然提及时 min(0.8, 0.5 + 0.1 × (不同源章节数 - 1))，否则 0
E = 有有效显式链接时 1，否则 0
R = M + 0.3 × E × (1 - M)
```

同一章节重复再多次也不会继续加分，但所有有效位置保留。显式链接里的文字不重复计为自然提及。仅有明确 WikiLink 的关系也会形成候选，得分 0.3。分数用于展示，不代表概率、知识重要性或掌握程度；语义能力明确为 `not-configured`。

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
packages/adapters/      Markdown、内存、Node 身份和只读文件导入
apps/playground-cli/   CLI 宿主
fixtures/              可提交的合成回归样本
tests/                 解析、评分、探索性质、持久化和实际 CLI 测试
scripts/               独立 SDK 验收入口
docs/                  计划、协议、架构决策与验证说明
```

详见 [实施计划](docs/implementation-plan.md)、[内核协议](docs/protocols/kernel-v1.md)、[架构决策](docs/adr/0001-kernel-first.md) 和 [验证说明](docs/validation.md)。

## 当前边界

此次未实现 Embedding、SQLite/FTS、正式桌面/网页、布局算法、Mark-it、MCP 或 Agent。坐标、相机和阅读位置由宿主提供，SDK 负责保存与恢复。

增量导入跳过完全未变文档的 Markdown 解析；发生变更时，先完整解析该文档，再重建全库实体提及和关系，保证跨文档别名依赖正确。尚未做 K6 的千级/万级压力测试或细粒度依赖优化。外部文件改名不会依据相同内容强行认定身份；已知改名可由 SDK 传入原 ID 更新路径。

目前在 AST 的可链接文本片段内匹配原始名称，不跨加粗等格式节点拼接名称，也不将 HTML 实体编码还原后匹配。Obsidian 嵌入、块 ID 和自定义 Markdown 扩展未作为关系类型实现。

## 真实笔记验收

```sh
npm run validate:vault -- /Users/alpha/Documents/ChatGPT/iWiki
```

验收只读取输入文件；编辑与过期测试在内存副本上执行。报告输出至被忽略的 `reports/local/iwiki-validation.json`，包含关系/证据检查、展开曲线、历史恢复和导入前后文件哈希比较。此工具验证 K1～K3 的运行正确性，不输出推荐质量、语义效果或学习收益结论。
