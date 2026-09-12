# Mark-it 源码快照

来自 Alpha 的本机 Mark-it 工作区 `packages/core/src`，包含 Source First 编辑实现。上游 npm 包在接入时尚未发布，因此固定当前源码及每个文件的 SHA-256，详见 `provenance.json`。此快照包含未提交改动，不将上游 HEAD 冒充为这些源码的发布版本。上游未提供 LICENSE 文件；不声明或杜撰其授权协议。

Ripple 通过 `npm run build:editor` 从此目录构建浏览器模块，不依赖本机另一个 checkout。仅 EditorAdapter 接触此 API；不引入上游 React Playground。原始代码按快照保存；Ripple 的适配与样式覆盖位于 `packages/workbench`。
