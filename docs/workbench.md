# Ripple 工作台与宿主

Ripple 使用同一个 Vue 3 工作台承载桌面阅读、公开探索与 Harness 知识面板。Core 不依赖 Vue、Electron 或 Harness；目录访问、存储和进程边界由 Host 管理。

## 桌面运行

```sh
npm ci
npm run build:desktop
npm run desktop -- --vault /absolute/path/to/vault --readonly
```

不传 `--vault` 时显示目录选择页。选择框默认只读；要编辑自己的目录，取消“只读打开新目录”后重新打开目录。测试编辑请使用副本。编辑采用 Mark-it 内核，提供富文本和 Markdown 源码模式；保存前检查版本与磁盘内容，发生外部修改时拒绝覆盖。未修改时保存保持原始字节；源码局部编辑保留未触及的 BOM 和换行格式。

```sh
npm run package:desktop
open release/current/Ripple-darwin-arm64/Ripple.app
```

当前打包目标是 macOS arm64。本机原生窗口已验证；产物尚未签名或公证，没有其他机器的 Gatekeeper 验收。

知识库状态保存在 Electron userData 下，源目录之外。文件监听会更新目录和关系。模型配置通过知识库状态面板选择本地 JSON 文件；第一次点击索引后，后续保存会自动增量索引。模型不可用时仍可阅读和保存，状态面板显示失败与覆盖情况。配置说明见 [Embedding](embedding.md)。

阅读中的名称提及和 WikiLink 可预览笔记；关系分数打开双端证据，定位操作在来源文本中选择准确引用。探索视图按冻结快照分配坐标，Lens 调整只过滤节点，默认最多显示 40 条关系。返回操作恢复中心、Lens、相机和阅读位置。

## 公开 Web 与 iframe

公开演示：[异步的知识花园](https://alpha5402.github.io/Ripple/)。嵌入地址为 `https://alpha5402.github.io/Ripple/?embed=1`。

```sh
npm run build:web
npm run audit:public
npm run preview:web
```

公开包来自 `fixtures/showcase` 的 10 篇专门编写的示例笔记，白名单在 `configs/public-demo.json`。提交的 `knowledge.json` 包含真实 WeMM 预计算信号，浏览器无需模型服务或密钥。默认导出命令不启用模型，会只生成确定性关系；要更新语义包需在本地模型运行时显式提供 embedding 配置并索引：

```sh
npm run export:public -- --embedding configs/embedding.wemm-local.json --index
```

导出时从公开原文重新构建名称提及与链接，只保留两端都公开且版本一致的语义贡献，不导出向量、用户声明、模型端点或密钥。包含媒体的笔记必须先整理成适合公开的文本，不能直接导出。发布前 `audit:public` 核对每篇原文与示例白名单完全一致，并扫描构建文件。

部署工作流 `.github/workflows/pages.yml` 只上传 `dist/web`。iframe 使用公开地址加 `?embed=1`。访客可创建浏览器沙盒进行编辑，刷新后恢复公开包；不会写入服务器或本机原始目录。浏览器沙盒没有向量推理，修改后的旧语义证据会失效。

## 只读 MCP

```sh
npm run mcp -- --vault /absolute/path/to/vault --state-dir /absolute/path/to/ripple-state
```

MCP 客户端可将 command 配置为 `node`，args 为 `--import`, `tsx`, `/absolute/path/to/Ripple/apps/mcp/main.ts`, `--vault`, `/absolute/path/to/vault`，并将 cwd 设置为 Ripple 仓库。提供 resolve、mention、relation、exploration 和 evidence 相关的 7 个只读工具，没有写文件工具。stdout 仅输出 MCP 协议；运行日志进入 stderr。进程关闭会释放 watcher、SQLite 与传输。

## DeepSeek Harness

```sh
npm run build:dsh
```

产物位于 `dist/dsh`，后端入口是 `entry.mjs`，客户端入口是 `client.mjs`。后端插件注入 Harness 的 `tools` 与 `systemPrompt`，配置项包括 `vault`、`stateDir`、可选 `embedding` 和 `panel`。客户端提供 Vue Knowledge Workspace，具体注册契约见 `packages/integrations/dsh` 和 `packages/workbench/dsh-client.ts`；当前对照本地 DSH 0.1.0-rc.5 API 验证。

Follow Lens 只向 Ripple 的工具和上下文提供当前可见证据。Explore Beyond Lens 返回候选提案，由人确认后才改变该会话的可见范围；不同会话隔离，卸载清理工具、上下文和 UI 订阅。它不撤销 Harness 的其他工具，也不删除历史对话中已经出现的内容。

已使用实际 Cordis、SystemPrompt、ToolRuntime 和 Vue 插件验证注册、调用、提案、确认和卸载；前端会话列表是明确的测试替身。尚未运行完整认证的 DSH 应用和在线 LLM 会话，不能将此结果表述为模型端到端验收。

## 验证记录

2026-09-13：`npm run check` 的 85 项测试通过；Vue 类型检查通过，桌面、Web 与 DSH 构建通过。原生 QA 使用独立 bundle ID 和受控 12 篇样本库，验证了富文本保存、新链接关系更新、证据精确选择、BOM/CRLF 无编辑保存、源码增量保存、未保存关闭的取消保护。真实 iWiki 保持只读。

图谱测量见 [渲染报告](../reports/hosts/graph-rendering.json)：40 条关系的 Lens 更新 P95 34.3ms；1000 节点/5000 边压力场景 P95 1092.4ms。后者不满足流畅交互，当前保留分页和 40 条默认预算。这是已加载渲染器的测量，不是冷启动时间或模型延迟。Harness 实测见 [集成报告](../reports/hosts/dsh-ui.json)。
