# H1～H4 分批实施

用户已授权按设计基线继续自主实施。所有 Ripple 前端使用 Vue 3；原方案中的 React 工作台改为 Vue。界面参考 Apple Human Interface Guidelines 的内容层次、侧栏/工具栏、材质、键盘操作和减少动态效果，保持 Ripple 自己的视觉标识。

## H1：桌面阅读与探索闭环

- Electron 桌面壳与 Vue 工作台；阅读和探索可切换，目录可折叠，证据与关系列表可访问。
- 通过独立 Host 管理目录授权、SQLite、文件监听、版本冲突和原文保存；IPC 使用收窄的契约，Core 不引入宿主代码。
- Mark-it 内核经 EditorAdapter 嵌入 Vue；保留未编辑原文，显式保存，外部修改时拒绝覆盖。
- Snapshot 预分配稳定坐标，Lens 只过滤；保存历史中的中心、阈值、相机、布局与阅读位置。
- macOS 构建、打包及真实窗口验收；iWiki 继续只读，编辑验收使用受控样本库副本。

## H2：公开 Web 与 Embed

- 同一 Vue 工作台支持公开数据包，不连接本机目录或模型服务。
- 严格显式导出文档白名单，从公开原文重新构建确定信号，仅保留两端公开的语义贡献；不导出原库私有名称、别名、路径或用户声明。
- 无 Key 的预计算关系探索与 iframe 模式；访客编辑只修改本地沙盒副本。
- 提供静态构建和部署入口，检验发布资源和隐私边界。

## H3：只读 MCP

- MCP SDK stdio 服务包装 resolve、mentions、relations、explore、evidence。
- 参数和错误协议清晰，所有引用独立于 Lens；不提供写文件工具。
- 使用真实 MCP Client 完成握手、工具发现与调用，验证进程清理。

## H4：DeepSeek Harness 集成

- 对照本地 DSH 当前 API 实现独立 Integration，注册知识能力和工具。
- Vue Knowledge Workspace 面板与知识会话；Follow Lens 读取当前可见证据，模型可见内容按 Harness 的日志契约记录。
- Explore Beyond Lens 只提出候选，用户确认前不更改人的视图或上下文范围。
- 检验挂载、调用、卸载；将本地 DSH 版本与真实运行证据写入验收报告。

每批完成实现、相应测试、运行验证和文档，再进入下一批。远端是 https://github.com/Alpha5402/Ripple.git；最终交付清楚区分实现、实测、公开部署和需要外部凭据的边界。

参考：https://developer.apple.com/design/ 、https://developer.apple.com/design/human-interface-guidelines/ 。
