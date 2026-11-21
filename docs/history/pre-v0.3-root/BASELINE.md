# 现有基线（来自用户汇报）

项目名 FurEverCraft，main 对应 origin/main。已汇报提交：

- 4b1532b：build offline minecraft agent runtime foundation
- c9cdec6：complete offline runtime validation and tool loop
- b3f2716：chore: ignore local dependencies and runtime artifacts

已有：Node/TS strict/ESM、Zod、ManualClock、12×12 fake 地图、FakeClientBridge、模拟移动/背包/UI/放置、四邻接 A*、SQLite 八表基础迁移、目标保存重读、WorldState 基础时效与 gap、InputArbiter/租约/Executor、ToolRouter、多轮 AgentLoop、ScriptedProvider、两个模型协议基础适配、SSE 与增量工具解析、错误分类、取消、模拟 CLI/demo。

已汇报 typecheck/build/test/demo/CLI 通过，当前仅 3 个测试。这个数字不是本阶段能力依据，不要求对这份汇报做真实性审计。

明确缺口：五项技能及统一生命周期、effect ledger 与恢复、完整控制台、ring buffer/cursor、脱敏和独立故障测试。真实客户端、服务器、OS 输入、线上 API 及 Node 22 尚未验证。

本阶段直接补齐这些开发缺口。旧阶段 A01–A21 的必要性质合并进第二阶段测试，不单独再做一轮验收报告。
