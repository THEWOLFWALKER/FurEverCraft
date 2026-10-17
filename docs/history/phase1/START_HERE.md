# 复制给 Claude Code 的启动提示词

```text
请完整阅读当前仓库的 CLAUDE.md、IMPLEMENTATION_DECISIONS.md、PHASE1_SCOPE.md、TASKS.md、CONTRACTS.md、OFFLINE_ACCEPTANCE.md 和 docs 中三份设计文档，然后实施 Minecraft Agent 的第一大阶段开发。

这次要求交付可构建、可测试、可在离线模拟客户端上持续运行的 Runtime，不是再写一份计划，也不是只生成空目录。

技术选型、目录、表结构、模拟参数和验收已确定，不给用户留开放题，不重新讨论路线。按任务依赖自主完成：工程基础、核心合同、确定性模拟 Bridge、状态归并、执行与控制权、基础技能、模型工具循环、OpenAI Chat Completions 与 Anthropic Messages 适配、SQLite 持久恢复、控制台、离线演示和故障测试。

绝不连接任何真实 Minecraft 服务器，也不启动本地真实游戏服务端，不调用真实付费模型 API。测试使用本地 fixtures、虚拟时钟、模拟输入和模拟观测。真实客户端适配明确保留为 unavailable，不能以模拟成功冒充已接入。

保持真实客户端、无 Mod、普通玩家权限、结构化优先、截图按需的产品方向。不自行搜索新的资料。缺少 OS/游戏版本不阻塞本阶段；不要向我索要服务器配置、密码或 API Key。

完成代码和全部离线验收，修复发现的问题，更新任务进度，最后填写 DELIVERY_REPORT.md，告诉我启动命令、测试结果、限制和下一阶段事项。不要做到一半只问我要不要继续。
```
