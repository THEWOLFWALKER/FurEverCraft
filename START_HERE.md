# 给 Claude Code 的完整任务提示词

```text
请在现有 FurEverCraft 仓库继续开发，完整执行本包第二阶段。

先读 CLAUDE.md、BASELINE.md、DECISIONS.md、WORK_PACKAGES.md、CLIENT_BRIDGE.md、RUNTIME_CONTRACTS.md、OFFLINE_ACCEPTANCE.md 和 docs。以用户提供的上一阶段汇报为基线，不重新做一轮验收或只写审计报告。正常读代码和跑所需回归后直接增量实施。

本次范围明显扩大：先尽可能补齐上一阶段全部遗留，再完成五技能生命周期、执行仲裁、效果账本/崩溃恢复、事件与记忆、交互控制台、完整两家模型工具循环；还要实现 1.20.4 offline-mode 本地协议桥、Windows 原生输入/按需截图 helper 和 CompositeClientBridge。后端是实际代码，不是 unavailable 占位；外部依赖测试用夹具和模拟 transport。

选型和默认值都已决定，不给我留开放题，不重新问库/版本/平台。缺少真实 API、服务器配置、游戏目录不是本阶段阻碍。不要索要 Key 或密码。用户机器资源有限，默认单 worker、虚拟时间、无 GPU、无游戏进程。

可以启动 Java 或辅助进程做本地检查；如果已有客户端，可选启动到主菜单观察，但绝不加入任何 Minecraft 服务器，不启动真实服务端，也不进入单人世界/集成服务器。不要下载游戏资产。不调用真实付费模型 API。协议集成测试只运行 loopback 上没有游戏引擎的最小消息夹具。不要实际注入键鼠，使用 fake helper transport。

已有工程不要推翻重建；沿用并补齐真实可用部分。按 W01–W15 持续推进，完成全部离线验收、六组演示、文档和 DELIVERY_REPORT。不要做到骨架就结束，不把本阶段必做项再次整体留作后续。不自行搜索新资料，不推送/发布远端。确有单项无法解决时记录证据并继续其他工作，不伪造通过。
```
