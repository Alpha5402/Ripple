# K4：Embedding 接入与运行

模型能力、索引策略和部署位置分别配置。Core 只调用 `EmbeddingProvider`；本地进程、云端地址、文件读取和凭据均在 Adapter 层。

## 工作台中的完整入口

Web 和桌面版均可在打开工作区后点击侧栏「语义关联设置…」，无需先编写 JSON。

1. 选择本地 WeMM / Ripple 服务，或兼容 OpenAI 的 Embedding 服务。
2. 填写根地址（允许以 `/v1` 或 `/v1/embeddings` 结尾）和可选 API Key。兼容协议还需填写模型名，向量维度由测试响应探测。
3. 点击「测试并连接」。只发送固定测试文本，不会索引笔记；成功后显示实际模型和地址。失败替换保留旧连接与索引。
4. 点击「开始索引」，查看完成笔记数和片段数。支持停止、失败重试、向量复用；完成后自动刷新探索关系。
5. 点击「语义相似」的关系分数，查看两端原文证据。

表单目前提供纯文本索引；多模态仍使用下文的文件配置。API Key 仅保留在当前进程 / 页面内，不写入状态、缓存或日志。桌面向量在重新连接同一模型后可复用；浏览器向量仅保留到页面刷新或关闭。

浏览器直接访问配置的服务，服务必须允许页面来源的 CORS。自带 WeMM 默认允许本地 4320 / 4321 工作台和 `https://alpha5402.github.io`，可用 `RIPPLE_EMBEDDING_ALLOWED_ORIGINS`（逗号分隔）配置自己的页面来源，不对任意网站开放。第三方服务不支持 CORS 时可使用桌面版；HTTPS 页面访问本地 HTTP 服务还取决于浏览器的本地网络许可。

## 本地一键启动 WeMM 2B

在项目根目录执行：

```sh
npm ci
npm run wemm:doctor
npm run wemm:start
```

`wemm:start` 会寻找 Python 3.10+、创建项目内虚拟环境、安装依赖、下载固定版本权重并启动 HTTP 服务。环境、下载缓存和约 5.44 GB 的模型权重位于 `.ripple/wemm/`，不修改系统 Python 环境。没有合适 Python 时，脚本尝试在项目内使用 uv 安装 Python 3.12；也可以设置 `RIPPLE_PYTHON` 指定解释器。

首次运行需要联网下载。只安装和下载可用 `npm run wemm:setup`；已准备好的离线环境可用 `npm run wemm:start -- --no-setup`。进程前台运行，按 Ctrl+C 退出。

默认监听 `127.0.0.1:8787`，自动选择 CUDA → MPS → CPU。可用 `--device mps|cuda|cpu` 指定设备，`--port` 更改端口。MPS/CUDA 使用 BF16，CPU 使用 FP32。CPU 内存和延迟成本更高。这里使用官方 Transformers 模型实现，未做量化。

官方模型与固定 revision：

- [tencent/WeMM-Embedding-2B](https://huggingface.co/tencent/WeMM-Embedding-2B)
- `bbd6cd4bf52cfc6716f752a2df80b2706720bd95`
- `torch==2.10.0`、`torchvision==0.25.0`、`transformers==5.2.0`

模型按官方 chat template 编码，由 tokenizer 自动添加 `<embedding>`，然后调用官方 `model.embedding()`，取该位置的 hidden state 并归一化。服务校验末尾 token、2048 维、有限数值和单位范数。远程自定义模型文件仅从固定 revision 下载并本地加载。

默认每次推理一个单元，避免 padding 对 pooling 的影响并控制笔记本内存。服务默认最多 1024 tokens，Core 默认每块 512 tokens；超限返回错误，绝不静默截断。`--max-tokens` 可以修改服务上限；配置中的 `chunking.maxTokens` 不能超过服务声明。默认图片预算 65536 pixels，使用 `--image-pixels` 调整。图片缩放策略和精度包含在表示版本中，改变后创建新的向量空间。

## Text Only 与 MultiModal

```sh
# 默认只编码文本：即使模型支持图片，也不读取图片字节
npm run cli -- --vault fixtures/embedding --embedding configs/embedding.wemm-local.json --index

# 编码文本，并增加图片与附近文字组成的单元
npm run cli -- --vault fixtures/embedding --embedding configs/embedding.wemm-multimodal.json --index
```

| 项目 | Text Only（默认） | MultiModal |
| --- | --- | --- |
| 文本切分 | 按章节与模型 token 预算切分 | 同左 |
| 标题上下文 | 文档标题及章节路径 | 同左 |
| Markdown 图片 | 保留 alt/caption 文字，不读取附件 | 额外创建 image-context 单元 |
| 图片上下文 | 无图片向量 | 同章节附近文字，超限时缩短上下文 |
| 图片证据 | 原 Markdown 范围 | 原 Markdown 范围、附件来源和内容哈希 |
| 模型要求 | 支持 text | 同时支持 text 和 image |

块不重叠，不因长文而截掉尾部；分割不破坏 UTF-16 代理对或 Markdown 图片引用。每块保留原文 revision、章节 ID 和起止位置，添加的标题上下文不冒充原文范围。

当前媒体适配器处理 Markdown 图片、引用式图片和 Obsidian 图片嵌入；只读取 vault 内的 PNG/JPEG/WebP/GIF，最大 8 MiB，拒绝远程图片 URL 和越界符号链接。GIF 只取首帧。缺图或图片超限会记录 partial/error，仍保留可用文本结果。此次未接入视频、音频、PDF 渲染或 OCR；官方模型具备的其他能力不等于 Ripple 已经提供对应导入链路。

## 云端与其他模型

相同 `ripple` HTTP 协议可以指向自己的云端 WeMM 服务，见 `configs/embedding.wemm-cloud.example.json`。在云主机运行相同安装/启动命令，选择 CUDA；通过 HTTPS 反向代理暴露服务。绑定非 loopback 地址时，服务要求 `RIPPLE_EMBEDDING_API_KEY`。本仓库不创建云资源、证书或账单。

密钥在用户的进程环境中设置，配置仅写环境变量名 `apiKeyEnv`，不把值写入 JSON 或向量缓存。远程 Adapter 要求 HTTPS；HTTP 只允许 loopback，禁止自动跟随重定向。选择云配置并执行 `index` 会把所选文本，以及 MultiModal 下的附件字节发送到该端点。

`configs/embedding.cloud.example.json` 提供通用的 `openai-compatible` 文本协议配置，需要填写实际 URL、模型名称、部署 revision、维度和任务表示。它只接受字符串数组，不把多模态输入强塞进文本协议。端点不提供 tokenize API 时，`utf8-upper-bound-v1` 用 UTF-8 字节数加 32 作为保守预算，仅适用于 byte-level tokenizer；其他 tokenizer 应实现带精确计数的 `ripple` 协议。模型超限响应仍作为可见错误处理。

`ripple` 协议：

| 路径 | 响应要点 |
| --- | --- |
| `GET /v1/model-info` | model、revision、dimensions、normalized、modalities、maxInputTokens、representation、tokenizer |
| `POST /v1/tokenize` | `{ model, input: [{ text, images }] }` → `{ counts, revision }`，含模板和图片 token |
| `POST /v1/embeddings` | 相同 input → `{ model, revision, representation, data: [{ index, embedding }] }` |

每个图片对象为 `{ dataUrl, mimeType, contentHash }`。服务不接受远程媒体 URL 或本机路径。Adapter 按 index 恢复响应顺序并验证模型身份，Core 验证维度、有限值和归一化契约。第三方云端若不能提供不可变 revision，填写的 revision 只是用户声明，无法检测供应商在同名模型下静默换权重。

## 索引、缓存和探索

CLI 使用 `index <名称>` 只编码所选文档，`index all` 编码全库，`coverage` 查看逐文档状态。索引是显式操作，不在阅读或调 Lens 时自动调用模型。

空间 ID 由模型、revision、维度、归一化约定、模态能力、tokenizer、任务表示、索引模式及切分配置计算。更换这些信息会切换空间，旧空间保留为可复用缓存。候选预算或评分映射改变不会重编码，但会更改关系评分版本。

同空间用输入内容哈希复用未变单元。文档编辑时，未变章节复用向量并更新 Evidence revision；附件字节变化时只重算对应 image-context。Tokenization 暂时失败保留同 revision 的有效缓存。缓存存于状态目录的 `cache/embeddings.json`，可以删除重建，用户声明位于独立文件。

SDK 的 `indexEmbeddings({ documentIds, signal })` 支持取消，`cancelEmbeddings()` 取消当前任务。模型切换、文档 revision 和任务序号共同阻止迟到结果覆盖新状态。网络暂时故障有限重试；鉴权和无效向量不会反复重试。HTTP 客户端取消后，服务已开始的那次计算可能继续到结束，但结果不能回写过期索引。

目前用精确余弦比较单元，按文档对聚合。`max` 取最强命中；`top-mean` 对两端均不同章节的最多 `topMatches` 个命中求平均，防止长文靠重复块堆分。每个命中记录两端块、位置、内容哈希、模态组合及 cosine。语义信号对称，不表达引用方向或概念依赖。

各模态组合先分别映射到展示强度 S，默认映射只是待 K5 校准的基线；不是概率。混合分数为：

```text
B = max(MentionStrength, SemanticStrength)
R = B + 0.3 × ExplicitLink × (1 - B)
```

每中心默认召回最多 100 个语义文档候选，所有确定性关系继续保留；展示预算仍由 Snapshot/Lens 管理。索引完成不会给已有 Snapshot 偷换候选，而是标记 stale，用户 refresh 后才纳入新候选。模型空间改变会撤下旧空间语义证据。未配置或模型失败时，确定性关系照常可用。

当前比较采用内存精确计算，每次发布会重建关系；该实现用于小库验证，不具备 ANN 或大规模索引性能承诺。K6 再接入持久化向量索引和压力测试。

## SDK 与验证

```ts
import { createNodeKernel } from '@ripple/core/node';
import { HttpEmbeddingProvider } from '@ripple/core/embedding-http';

const knowledge = createNodeKernel();
knowledge.ingestDocuments([{ id: 'example', path: 'Example.md', markdown: '# Example\nSome content.' }]);
const provider = await HttpEmbeddingProvider.connect({ protocol: 'ripple', baseUrl: 'http://127.0.0.1:8787' });
knowledge.configureEmbedding(provider); // 默认 Text Only
await knowledge.indexEmbeddings();
console.log(knowledge.getEmbeddingCoverage());
```

服务启动后运行 `npm run validate:embedding`，可选 `-- --vault /path/to/iWiki` 只读验证四篇选定笔记。此工具仅允许 loopback 端点，将阶段结果及失败原因保存到 `reports/local/wemm-validation.json`。它检查真实文本/图像向量、语义候选、证据、增量复用和图文交替调用稳定性；人工判断“值得一起读”和质量指标仍需要 K5 标注。
