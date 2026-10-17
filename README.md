# FurEverCraft 第二阶段开发交付包

阶段：完整执行运行时 + 可连接的客户端桥 + 可操作的本地控制台  
日期：2026-10-17  
目标仓库：https://github.com/THEWOLFWALKER/FurEverCraft

这是下一阶段开发任务，不是代码验收报告。以前一轮工作汇报为事实基线，不要求重新验收第一阶段，不要求重建工程。

## 为什么本阶段更大

第一阶段目前形成骨架，执行恢复、技能生命周期、控制台和客户端接入均未闭合。本阶段将这些放在同一次交付内，同时提供真正的离线协议桥和 Windows 输入实现，而不再以所有真实后端 unavailable 收尾。

交付目标：

1. 五项技能、执行/控制权/副作用完整生命周期。
2. SQLite 事务恢复、事件游标、结构化记忆和可持续运行调度。
3. OpenAI/Anthropic 完整工具会话、流式解析、取消、限额和可手动开启的真实 API 路径。
4. 交互式 CLI：目标、执行、聊天、取消、暂停、恢复和诊断。
5. Minecraft Java **1.20.4 / 协议 765 / offline-mode** 的本地协议桥实现与离线协议测试。
6. Windows 10/11 原生键鼠及截图后端实现，以替身测试验证调用，不在本阶段注入真实游戏窗口。
7. 多场景离线集成和虚拟长序列稳定性测试。

**开发和验收均不连接真实 Minecraft 服务器，不启动真实 Minecraft 服务端（包括单人集成服务器），不调用付费模型 API。** 允许 Java/辅助进程检查，以及已有客户端到主菜单的可选只读检查。客户端桥和 OS 后端要有可执行代码；离线测试不等于真实环境验证。

## 入口

按顺序读 CLAUDE.md、BASELINE.md、DECISIONS.md、WORK_PACKAGES.md、CLIENT_BRIDGE.md、RUNTIME_CONTRACTS.md、OFFLINE_ACCEPTANCE.md，最后参考 docs 中三个长期设计。

将本包内容放入现有仓库根目录，保留现有源码和 Git 历史。根目录 CLAUDE.md / AGENTS.md 使用本阶段版本；旧阶段任务移至 docs/history/phase1/，不要让旧的“真实后端禁止实现”限制覆盖本阶段范围。

START_HERE.md 可直接复制给 Claude Code。开发 Agent 完成本阶段全部工作后填写 DELIVERY_REPORT.md；不能再次把本包必做能力全部移到第三阶段。

## 状态声明

本包生成者未 clone、审计或运行目标仓库。BASELINE.md 复述用户汇报，不是独立验证结果。开发者正常阅读现有代码并做增量修改属于实施，不需要先开展独立审计项目。
