# 在 DSH Web 中演示 Ripple

启动命令：

```sh
cd /Users/alpha/Github/Ripple
npm run demo:dsh
```

脚本构建 Ripple 插件，首次在仓库的 `reports/local/dsh-demo-runtime` 安装 `@deepseek-ai/dsh@0.1.5-rc.1`，随后启动真正的 DSH Web。演示配置、会话与凭据保存在独立的 `reports/local/dsh-demo-home`，不会覆盖默认 `~/.dsh`。CLI 的依赖范围可能解析出不同补丁版本，实际验收的组件版本记录见验收报告。

保留终端，打开 `dsh web:` 后打印的完整地址。DSH 使用本次进程的登录 token；重启后应使用新地址。Web 端口为 47323，Ripple 面板端口为 47321。若端口占用，先结束之前的演示进程。`Ctrl+C` 关闭演示。

## 演示步骤

1. 首次进入时可选择“稍后配置”模型。添加工作区，目录选择 `/Users/alpha/Github/Ripple/fixtures/showcase`。
2. 选择该工作区并进入一个会话。DSH 在发送第一条消息时创建持久会话；没有 Key 的请求会报 `MISSING_CREDENTIAL`，但可使用该会话展示知识面板。
3. 点击右下角 **Ripple Knowledge**，选择 **Promise**，切换“探索”。拖动 Knowledge Lens，点击关系分数查看来源。
4. 勾选 **Follow Lens**。它授权 Ripple 工具读取此会话当前可见的知识范围。
5. 需要模型参与时，在 DSH **设置 → 模型** 中配置 Key 并选择模型。演示脚本不会复制默认 DSH 的凭据。
6. 发给模型：

   > 请先调用 ripple_context，只使用当前 Knowledge Lens 可见的文档和证据，解释 Promise 与 Event Loop 的关系，注明来源。不要读取工作区文件或调用其他检索工具。

7. 把 Lens 收窄，再发送：

   > 请刷新 ripple_context，再调用 ripple_propose_beyond，提出最多两篇值得继续阅读的笔记，并说明理由。先等我确认，不要自行扩大知识范围。

8. 在 Knowledge Workspace 中查看提案，确认后检查可见关系与上下文版本变化。

当前演示只加载 10 篇示例原文，使用确定性关系，不会启动 Embedding 模型。Follow Lens 约束 Ripple 提供的工具与上下文，不撤销 DSH 其他文件/工具权限，也不会抹除历史上下文。

## 本次验证边界

2026-09-13：通过 npm 发布版 CLI 0.1.5-rc.1 启动完整 DSH Web，完成登录、目录选择、真实会话绑定、Ripple 浏览器插件注册以及 iframe 原文加载。修复了旧产物未注册 DSH 模块工厂、依赖旧 client-runtime 包的两个兼容问题。没有配置模型 Key，因此未完成在线模型调用；`MISSING_CREDENTIAL` 是已观察到的凭据缺失，不是模型成功运行。
