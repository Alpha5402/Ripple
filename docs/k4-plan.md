# K4：可配置 Embedding

本轮按用户要求使用腾讯 WeMM-Embedding-2B，并将其作为可替换 Provider 接入。Text Only 是默认索引策略；模型能力、索引模态、运行位置相互独立。

## 实施顺序

1. 核查官方模型代码与版本，提供隔离 Python 环境、下载和启动一体的部署命令。
2. 增加 EmbeddingProvider、EmbeddingSpace、KnowledgeUnit、任务与覆盖率协议。
3. 实现按章节及 token 预算切分的 Text Only 策略；MultiModal 增加图片与附近文字的关联单元，保持原文位置。此次多模态覆盖文字和图片，视频、音频、PDF 页面转换不冒充已支持。
4. 实现可取消、有界重试、增量复用和迟到结果拒绝；向量缓存按模型/版本/表示/切分策略隔离。
5. 章节近邻按文档去重召回，保留两端贡献片段；融合进现有 Relation 与 Snapshot。语义更新只让旧快照 stale，不在拖动中改变候选。
6. 提供本地 WeMM HTTP 和云端 HTTP 配置；兼容纯文本的 OpenAI embeddings 协议。密钥从环境变量读取，默认不向云端发送 iWiki。
7. 回归 K1–K3，验证真实 WeMM 文本及图片调用、无显式引用的语义关系与失败边界。

## 本轮边界

- 先使用内存精确余弦近邻，不把 SQLite 或 ANN 带入 K4。
- 不以模型相似度断言概念依赖、重复或学习收益；评分映射需要 K5 校准。
- 本地 M5/16 GB 的运行效果以实测为准；云端适配不等于已经创建付费云资源。
- 官方模型仓库固定 revision `bbd6cd4bf52cfc6716f752a2df80b2706720bd95`；远程自定义模型代码已读取检查，不追踪 main 执行。
