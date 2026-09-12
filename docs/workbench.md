# Ripple 工作台与宿主

Ripple 使用同一个 Vue 3 工作台承载桌面阅读、公开探索与 Harness 知识面板。Core 不依赖 Vue、Electron 或 Harness；目录访问、存储和进程边界由 Host 管理。

## 桌面运行

```sh
npm ci
npm run build:desktop
npm run desktop -- --vault /absolute/path/to/vault --readonly
```

不传 `--vault` 时自动恢复最近打开的目录；没有历史或目录不可用时显示欢迎页。欢迎页与侧栏「最近工作区…」可重新打开历史目录，列表可移除旧记录。目录按规范路径标识，符号链接入口不会创建重复缓存。选择框默认只读；要编辑自己的目录，取消“只读打开新目录”后重新打开目录。测试编辑请使用副本。编辑采用 Mark-it 内核，提供富文本和 Markdown 源码模式；保存前检查版本与磁盘内容，发生外部修改时拒绝覆盖。未修改时保存保持原始字节；源码局部编辑保留未触及的 BOM 和换行格式。

```sh
npm run package:desktop
open release/current/Ripple-darwin-arm64/Ripple.app
```

当前打包目标是 macOS arm64。本机原生窗口已验证；产物尚未签名或公证，没有其他机器的 Gatekeeper 验收。

知识库状态保存在 Electron userData 下，源目录之外。文件监听会更新目录和关系。点击侧栏「语义关联设置…」填写服务地址、协议、模型和可选 API Key，测试连接后开始索引；第一次点击索引后，自动增量更新默认开启，可在表单中关闭；该开关和模型配置随工作区持久保存。重启直接恢复可用向量，启动扫描和文件监听只对新增或变化的笔记补索引，未变片段复用，删除笔记立即退出关系计算。模型不可用时仍可阅读和保存，状态面板显示失败与覆盖情况。配置说明见 [Embedding](embedding.md)。

阅读中的名称提及和 WikiLink 可预览笔记；关系分数打开双端证据，定位操作在来源文本中选择准确引用。探索视图使用小圆点和无底色标签，节点通过引力、斥力和标签碰撞力自然展开。拖动会重新激活模拟，稳定后停止计算并保存布局；边权在悬停或键盘聚焦时显示，默认最多显示 40 条关系。返回操作恢复中心、Lens、相机和阅读位置。

## 公开 Web 与 iframe

Web 入口：[Ripple](https://alpha5402.github.io/Ripple/)。默认显示欢迎页，不内置演示笔记。欢迎页使用 R 字形 Logo，保留两行英文 HTML 文本，不再重复展示大号名称。

```sh
npm run build:web
npm run audit:public
npm run preview:web
```

点击「打开工作区」选择本地 Markdown 文件夹，浏览器会建立名称提及和显式链接关系。导入本身不上传文件，编辑不会写回原文件。点击「语义关联设置…」可连接本地 WeMM 或兼容 OpenAI 的 Embedding 服务；测试仅发送固定文本，开始索引后才发送笔记文本。工作区历史、笔记副本、模型配置和向量保存在当前来源的 IndexedDB，刷新或重开浏览器会恢复最近工作区。支持目录访问 API 时保存目录句柄，以三秒间隔在可见页面检查变化；权限失效时保留缓存，点击状态面板中的「同步目录」重新授权。仅支持文件上传的浏览器保存目录快照，源文件变化需要点击「同步目录」重新选择该目录；普通导入不会仅凭同名目录猜测身份。浏览器里的已保存编辑不会被未变源文件覆盖，双方都修改时保留本地副本并提示冲突。多标签页通过存储版本检查拒绝旧快照覆盖新缓存。清除浏览器站点数据会清除这些副本与索引。

浏览器导入忽略隐藏目录和 AGENTS.md，限制 1000 篇笔记、单文件 4 MiB、总计 32 MiB。空目录或超限会显示错误并保留此前打开的内容。切换目录前会保护尚未保存的编辑。

部署工作流 `.github/workflows/pages.yml` 只上传 `dist/web`，`audit:public` 检查产物未包含演示笔记或敏感字段。iframe 地址为 `https://alpha5402.github.io/Ripple/?embed=1`。

测试用示例仍保留在 `fixtures/showcase`；显式执行 `npm run export:public` 会生成 `fixtures/showcase.precomputed.json`，该文件不随默认 Web 或桌面构建发布。

## 只读 MCP

```sh
npm run mcp -- --vault /absolute/path/to/vault --state-dir /absolute/path/to/ripple-state
```

MCP 客户端可将 command 配置为 `node`，args 为 `--import`, `tsx`, `/absolute/path/to/Ripple/apps/mcp/main.ts`, `--vault`, `/absolute/path/to/vault`，并将 cwd 设置为 Ripple 仓库。提供 resolve、mention、relation、exploration 和 evidence 相关的 7 个只读工具，没有写文件工具。stdout 仅输出 MCP 协议；运行日志进入 stderr。进程关闭会释放 watcher、SQLite 与传输。

## DeepSeek Harness

实际 DSH Web 演示：`npm run demo:dsh`。完整步骤和版本边界见 [DSH 演示](dsh-demo.md)。

```sh
npm run build:dsh
```

产物位于 `dist/dsh`，后端入口是 `entry.mjs`，客户端入口是 DSH 模块工厂 `client.js`（另保留独立验收用的 `client.mjs`）。后端插件注入 Harness 的 `tools` 与 `systemPrompt`，配置项包括 `vault`、`stateDir`、可选 `embedding` 和 `panel`。客户端提供 Vue Knowledge Workspace，具体注册契约见 `packages/integrations/dsh` 和 `packages/workbench/dsh-client.ts`；当前对照本地 DSH 0.1.0-rc.5 API 验证。

Follow Lens 只向 Ripple 的工具和上下文提供当前可见证据。Explore Beyond Lens 返回候选提案，由人确认后才改变该会话的可见范围；不同会话隔离，卸载清理工具、上下文和 UI 订阅。它不撤销 Harness 的其他工具，也不删除历史对话中已经出现的内容。

已使用实际 Cordis、SystemPrompt、ToolRuntime 和 Vue 插件验证注册、调用、提案、确认和卸载；前端会话列表是明确的测试替身。尚未运行完整认证的 DSH 应用和在线 LLM 会话，不能将此结果表述为模型端到端验收。

## 验证记录

2026-09-13：`npm run check` 的 85 项测试通过；Vue 类型检查通过，桌面、Web 与 DSH 构建通过。原生 QA 使用独立 bundle ID 和受控 12 篇样本库，验证了富文本保存、新链接关系更新、证据精确选择、BOM/CRLF 无编辑保存、源码增量保存、未保存关闭的取消保护。真实 iWiki 保持只读。

图谱测量见 [渲染报告](../reports/hosts/graph-rendering.json)：40 条关系的 Lens 更新 P95 34.3ms；1000 节点/5000 边压力场景 P95 1092.4ms。后者不满足流畅交互，当前保留分页和 40 条默认预算。这是已加载渲染器的测量，不是冷启动时间或模型延迟。Harness 实测见 [集成报告](../reports/hosts/dsh-ui.json)。

### 全局知识网络

Web 与桌面顶部的「全局」展示整个已打开工作区：所有笔记都成为节点，包括孤立笔记；连线汇总各篇笔记已发现的关系并去重，遵守隐藏关系设置。全局 Lens 默认 100，筛选关系强度但保留所有笔记，不使用局部探索的 40 条显示预算。语义边仍取决于有效索引与检索候选预算。

全局图使用力导向布局，可拖动节点、平移、滚轮缩放、复位适配画面；单击预览，双击进入该笔记的局部探索，连线可查看两端证据。全局布局与镜头保留于当前页面，与局部探索历史分开。Harness 继续沿用其局部可见范围，未增加全局入口。
