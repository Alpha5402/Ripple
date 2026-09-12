# 语义关系边界与局部探索

向量排序只产生候选池，不再直接产生图的边。核心路径为：

Vector Retrieval → Semantic Candidate Pool → Relation Boundary → Valid Semantic Neighborhood → Relation Scoring → Knowledge Lens → Visible Graph。

`packages/core/relation/semantic-candidate.ts` 对文档去重后按原始 cosine 排序，默认召回最多 100 个文档。候选池保留未通过质量要求的尾部用于观察分布，不含 RelationSignal 或最终关系分数。只有通过 boundary 的候选才能转成 semantic signal，与全部 Mention/WikiLink 合并后进入既有评分模块。

`gap-detector.ts` 计算相邻差值，显著性阈值为 median(gaps) + max(0.01, 3.5 × 1.4826 × MAD(gaps))。选择第一个显著断层，忽略 rank1 的断层，至少需要四个候选；没有显著断层就不截断。0.01 是防止浮点或微小变化触发截断的保护项，不是全局关系阈值。质量下限在策略之后独立应用，默认 0.55，可通过 `EmbeddingConfig.retrieval.boundary.qualityFloor` 或连接设置修改。这是初始配置，尚非模型质量标定结果。

策略接口 `RelationBoundaryStrategy` 包含 id、version、select，独立于 UI；KnowledgeService 可注入替代策略。模型、检索配置、策略版本和参数进入关系评分版本，边界配置不改变向量空间身份，因此调参可复用向量。

Snapshot v2 冻结中心、原始候选池、边界判定、有效语义邻域、合并后的关系、邻居之间已成立的关系、评分版本、索引版本与 Lens。旧 v1 会话需要重新建立探索快照，向量缓存不受影响。Lens 在冻结的有效关系分数范围内线性映射；Focus 显示最强关系，Explore 展开全部有效关系，同分一起出现。它不控制固定显示数量，默认预算为全部有效候选；显式分页预算仍可使用。

局部图中的横向边来自两个端点均认可的已通过 gate 的关系，且仅在两端都可见时显示。不会为布局创建全连接。后台索引、文件保存和同步不刷新已有快照；快照标记 stale，用户点击刷新或切换中心才重新召回。删除或失效证据仍即时撤下。

## 验证与局限

测试覆盖合成 SSRF 七节点邻域、25 节点宽邻域、低相似度整体拒绝、无断层、rank1 离群点、Mention/WikiLink 保留、101 个 Lens 值下单调扩张、零新增 embedding/retrieval 调用、stale 冻结以及真实横向边。

`fixtures/ssrf-cosine-distribution.json` 保存了一个 77 文档旧缓存中 SSRF 的 76 个真实 WeMM cosine，除测试目标外匿名化标题，不含正文。当前策略在 rank2 后识别断层，保留 CSRF/XSS 语义关系，排除 Web Storage（0.7004）、Vite（0.6467）与 Source Map（0.6410）。这不是完整的人工相关性标注，不能据此宣称召回率或对其他中心的质量达标。合成 fixture 的七节点结果也不代表真实 SSRF 必须显示七个节点。

首版 Gap 是可替换的探索策略，不表示断层外内容必然无关。当前策略偏保守，可能丢失有用的远距离语义关系；没有显著断层时，宽松 floor 仍可能接纳较多候选。下一轮应对多个中心做人工标注，比较 fixed threshold、top-k、mutual-kNN 与混合策略，保留 poolTruncated、gap 统计和逐候选理由供评估。
