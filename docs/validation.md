# K1–K4 验证记录

记录日期：2026-09-12。以下是本次本机运行结果；不代表推荐质量、交互收益或大库性能验收。

## 自动检查

`npm run check` 已通过：TypeScript 类型检查、61 项测试（原 K1～K3 的 37 项，加上 24 项 Embedding/HTTP/CLI 回归）、ESM 与声明文件构建。

覆盖范围：

- Markdown 范围、自然提及、词边界、中文最长别名、同名歧义、明确路径和章节目标、源文保真。
- 双向发现与有向证据、提及饱和、显式增强、隐藏/固定持久化、评分版本和返回对象隔离。
- 在 5 种候选规模 × 4 种显示预算 × 全部 101 个 Lens 档位下检查展开单调性；另测同分分页、小数边界、一跳规则和即时失效。
- CLI 子进程执行 fixture 的完整探索流程；SDK 历史序列化与恢复；元数据持久化重启；依赖边界检查。
- CLI 退出后重新启动，通过独立元数据文件恢复旧中心、Lens、候选和历史。

构建后额外通过实际包导出调用 `@ripple/core` 和 `@ripple/core/node`，验证无需 CLI 即可从被提及节点反向发现原文及证据。

## iWiki 只读验收

命令：

```sh
npm run validate:vault -- /Users/alpha/Documents/ChatGPT/iWiki
```

实际导入 `Wiki/` 下 **77 篇 Markdown**，形成 **114 对确定性文档关系**。逐条检查了 **229 处关系信号证据**，均可回到对应 revision 的真实原文；现有 WikiLink 没有未解析目标。所有导入文件在验收前后的 SHA-256 和文件列表一致。

以 CSRF、SSRF、Event Loop、Vite 为中心，共检查 404 次 Lens 过滤。Event Loop 的关联数随 Lens 35 → 50 → 70 依次为 1 → 2 → 6。完整结果及其他展开曲线保存在被忽略的 `reports/local/iwiki-validation.json`。

最近一次测量：导入与构建约 369 ms；局部候选过滤 P95 约 0.059 ms。环境为 Node.js v24.15.0，设备细节记录于本地报告。过滤时间不包括 UI、图布局或模型推理；此小库测量不能外推到 K6 的 1k/5k/10k 规模。

同时验证了：双向查询结果一致、历史恢复、未变输入不触发索引更新、内存编辑使旧 Snapshot 失效，以及旧 revision 写入被拒绝。以上更新测试只操作内存副本。

构建后的真实 CLI 也已运行 `fixtures/iwiki-demo.txt`，完成 Event Loop 展开、双向证据查看、切至 Web Workers 再返回，以及 SSRF 的全关系查询。原始输出保存在被忽略的 `reports/local/iwiki-cli.txt`。

## K4：真实 WeMM 与 CLI

本机 Apple M5、16 GiB，实际使用 MPS / BF16 运行 [官方 WeMM-Embedding-2B](https://huggingface.co/tencent/WeMM-Embedding-2B)，固定 revision `bbd6cd4bf52cfc6716f752a2df80b2706720bd95`。模型权重下载、虚拟环境安装、服务启动与以下真实推理均已完成。精确配置见 [Embedding 文档](embedding.md)。

```sh
npm run wemm:start
npm run validate:embedding -- --vault /Users/alpha/Documents/ChatGPT/iWiki
```

本地报告 `reports/local/wemm-validation.json` 记录了：

- Text Only：三个无互相提及/链接的样本均产出 2048 维有效向量；异步调度的中英文描述 cosine **0.8417**，异步调度与鲸鱼主题 **0.4301**。
- 增量：完全相同输入复用 3 个单元、编码 0 个；内存中新加章节只编码 1 个、复用 3 个。旧 Snapshot 按预期失效。
- MultiModal：相同三篇图片样本从 3 个文本单元变为 4 个单元，Text Only 与 MultiModal 空间分离。图片与“红圆在蓝方上方”的文字描述形成 text-image 信号，cosine **0.6203**。
- 混合调用：同一服务实例中先编码文本，再处理图片，再编码原文本，向量一致性 cosine 约 **1.0**，未观察到前一次图片的位置缓存污染后续文本。
- iWiki：只读索引 `Event Loop`、`Web Workers`、`Observable`、`响应式编程` 四篇完整笔记，得到 **17 个单元**、coverage=ready，约 **11.05 秒**。索引前后全库 Markdown 文件列表与 SHA-256 一致。

该四篇子集中形成 4 对纯语义候选。示例 `Observable ↔ Event Loop` 的 cosine 为 **0.7874**，分别命中“发值可以同步，也可以异步”和“顺序如何推导”两段；两篇笔记之间没有 Mention/WikiLink。两端原文片段、revision 和范围已保存，人工有用性标注仍为 pending。

真实 CLI 也运行了 `fixtures/embedding-demo.txt`：图文关联、Lens 展开、Evidence 和索引均成功。首次编码 4 个单元；同进程再次 index 与重启后 index 都是 **encoded=0 / reused=4**。输出分别在 `reports/local/wemm-cli.txt` 与 `reports/local/wemm-cli-restart.txt`。

服务真实错误响应另存于 `reports/local/wemm-http-limits.json`：超长文本返回 413 且不截断；远程媒体 URL 与无效图片返回 400。Adapter 的云端认证、文本负载、响应索引顺序、模型身份验证使用 HTTP fixture 测试；没有部署或调用真实付费云端。

正常一键入口 `npm run wemm:start` 也已重新启动验证，复用已安装依赖和权重，通过构建后公开的 `@ripple/core/embedding-http` 导出返回 2048 维向量，范数约 1.0000004。结果在 `reports/local/wemm-oneclick.json`，启动日志在 `reports/local/wemm-startup.log`。验收后测试服务已停止，环境和权重保留。

首次文本请求约 8.54 秒，首次图片请求约 10.01 秒；本次后续单个文本请求约 0.17～1.56 秒。它们包含 HTTP 和推理的冷/热状态差异，是这次小样本的观测，不能当作吞吐或长期性能承诺。未安装 CUDA 专用线性注意力加速库，MPS 使用 PyTorch 实现。

## 保留的失败样本与未完成的评估

异步调度与鲸鱼主题虽然明显无关，默认映射仍给出 **0.3288**，在 Lens=70（阈值 0.3）时会出现。这一失败样本保留在报告的 `failureSamples` 中；此次没有用同一冒烟样本调参来制造“验证通过”。K4 证明模型调用、索引和证据链能工作，不证明默认语义分数已经适合最终展示。

K5 的人工关系标注、hard negatives、P@K/nDCG 和映射校准，K6 的 SQLite/ANN 与大库性能，以及 Desktop/Web 图交互和用户实验尚未完成。CUDA、CPU 推理、视频和 PDF 导入也未经此次运行验收。
