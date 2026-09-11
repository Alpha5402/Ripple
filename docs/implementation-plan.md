# K1–K3 实施计划

依据：用户提供的 Ripple 设计基线 1.1（2026-09-12）。本次只交付确定性知识内核、SDK、CLI，不进入 K4 Embedding 或正式宿主阶段。

## 已确认的产品契约

- A 提到 B 后，从 A、B 均可发现彼此；信号始终保留 A → B 的原始方向。同一无向文档对使用相同显示分。
- 文档是节点，章节是证据和聚合单位；源偏移使用 UTF-16，并绑定文档 revision。
- 唯一且符合规则的自然提及默认关联；歧义不猜测，明确路径失效不转到同名目标。
- 固定候选和评分版本的一跳 Snapshot 使用单调阈值过滤；显示预算采用固定顺序的前缀，支持显式增加预算；同分阈值一起通过，预算可能分页同分组。
- 隐藏优先于固定；两者不改变评分。普通索引更新只标记 stale，删除、隐藏及已失效的证据立即失效。
- iWiki 只读。默认导入其 Wiki/ 下的知识笔记，保留相对整个 vault 的路径，避免破坏 Wiki/... 的明确链接。

## 实施次序

1. 冻结最小类型与端口：Document、Section、Entity、Mention、WikiLink、Evidence、Relation、Snapshot、History。
2. K1：Markdown AST 适配器、frontmatter、名称/别名与路径解析、正文扫描、反向查询、变更更新。
3. K2：候选/信号/评分分离，有上限提及聚合、双向发现、可持久导出的用户声明。
4. K3：快照、Lens、预算、过期及历史恢复；CLI 提供 focus/lens/relations/evidence/back。
5. 回归：解析边界、方向与证据、更新/删除、性质测试、序列化、宿主依赖隔离。
6. 真实验收：只读导入 iWiki，执行探索闭环，核对导入前后文件哈希，生成本地检查报告。

以上 6 步已完成，验收证据见 `docs/validation.md`。合成回归样本位于 `fixtures/vault`；真实 iWiki 内容没有复制进项目。

## 验收命令

- `npm run check`：类型检查、回归测试、构建。
- `npm run cli -- --vault fixtures/vault --commands fixtures/demo.txt`：可重复探索演示。
- `npm run validate:vault -- /Users/alpha/Documents/ChatGPT/iWiki`：真实笔记验收，报告存入忽略的 reports/local/。

## 边界

- K1–K3 内存适配器采用全局重新解析提及以保证别名依赖正确，未变文档复用 Markdown 解析；持久 SQLite 和精细增量性能优化留给 K6。
- 暂不实现模型、语义评测结论、图布局算法、UI、自动文件改名识别或文件写回。
- SDK 提供显式 ID、revision 和用户声明导入/导出；宿主负责持久保存身份及声明，不把它们混入可清理缓存。
