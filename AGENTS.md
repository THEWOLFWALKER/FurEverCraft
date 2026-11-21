# FurEverCraft 当前开发入口（v0.3）

继续本工作区的 FurEverCraft v0.3 增量开发。本文件是唯一执行约束来源；`CLAUDE.md` 只是指针，`GOAL.md` 是目标，`PROGRESS.md` 是唯一当前状态文件。以当前代码为唯一开发起点，保留已完成预实现与 Git 历史，不从 origin/main 覆盖、不重建工程、不回退到旧 ZIP。

## 权威顺序

用户最新明确指令 > 本文件 > `docs/design/` 下 v0.3 三层设计（L1 `minecraft-agent-top-level-design-v0.3.md` → L2 `minecraft-agent-client-bridge-contracts-v0.3.md` → L3 `minecraft-agent-motion-navigation-recovery-v0.3.md` 及 `v0.3-implementation-handoff.md`） > 当前源码合同 > `docs/research/` 研究材料。

`docs/history/` 仅保存历史证据，其中所有 GOAL/CLAUDE/NEXT_BATCH/REVIEW 指令均已失效，不得当任务执行。旧文档中的 F/B/U/M/A/V 与 P01–P24 编号只是历史追溯标签，不是当前批次编号。

## 阅读顺序

`README.md` → `GOAL.md` → `PROGRESS.md` → `docs/design/` L1 → L2 → L3 → `docs/design/v0.3-implementation-handoff.md`。

## 本批授权范围

本批明确授权是 `v0.3-implementation-handoff.md` 的 **S01–S09 剩余迁移** 及其中 **61 项（FEC-01…FEC-61）逐项处置表**。按依赖连续完成，每组分垂直链跑通成功/失败/取消/重启；常规工程决策在已定合同内解决，不向用户抛 A/B 题，不做完小阶段就等“继续”。设计目标与已实现分开：已有兼容 registry、service 控制资格、异步关闭、framing 修复只是起点，不得因类存在就宣布整个 v0.3 完成。

未完成项（ActionGateway/EffectCoordinator 全链、数据库 5–7 升级、动态 scope/时间、helper 独立 watchdog、真实 26.3 codec/projector、知识 importer、Motor 实机适配、部分 provider/SSE 问题）如实标注，不缩小范围制造完成。

## 硬边界（本批必须遵守）

- 不连接真实 Minecraft 服务器、不加入世界；不启动真实游戏服务端；不下载游戏 JAR/资产。
- 不运行真实 SendInput 或桌面截图；不调用线上付费模型 API。
- 允许：本机 npm 构建与依赖安装；127.0.0.1 无游戏引擎 TCP/HTTP 夹具；注入 transport/sink；依赖构建与既指定固定源码的核实。
- 浏览器 headless E2E 本身允许，但**本批次不安装、不启动浏览器**，其 E2E 与 360/768/1024 视觉验收记录为 `not-run`，绝不允许伪装通过，也不得删除对应测试。
- 保持**原版 Java 客户端为唯一身体**，生产链路是**原始字节 TCP relay + 只读 passive observer sidecar**；不引入 Mod、Java Agent/注入、内存读取、服务端组件或第二个 bot/玩家。除显式配置的首次 handshake 地址映射外，转发字节保持不变。
- 外部能力 gate（`allowMinecraftUpstream`、`allowModelNetwork`、`allowOsInput`、`allowScreenCapture`）独立且默认关闭；loopback 测试授权不得回退成真实目标或 Fake 生产后端。

## 秘密脱敏

密码、API Key、pairing code、bearer token、CSRF token、session cookie 等秘密在日志、异常、HTTP 响应、trace 与诊断中必须脱敏。

## 测试纪律

测试必须建立在正确合同前提与显式 fixture provenance 上，断言必须证明可观察行为，负例必须真的会失败。fixture/synthetic/simulated 行为不得证明生产能力；不得编造版本数据，不得用模拟结果宣称真实兼容。不得削弱断言、静默跳过、删除必测场景或把恒成功脚本称为测试。先审查前提与实现边界，再修实现或纠正错误前提。研究来源固定在 `docs/research/`。

## 状态词

报告和表格只使用以下四个状态词（本仓库实际使用，见 `PROGRESS.md` 与 `v0.3-implementation-handoff.md`）：

- `done-offline`：实现存在，并已由适用的离线测试/命令验证。
- `done-limited`：实现存在且已验证，但范围或验证边界明确受限（例如 synthetic 投影、模拟 body、注入 transport）；必须同时写出限制。
- `blocked-external`：任务本身依赖本批禁止的真实环境/数据/API；必须写明精确缺件与影响。
- `not-done`：尚未实现或尚未满足验收；进行中的工作也归入此类，不得提前标成 `done-*`。

## v0.2 → v0.3 集成说明

v0.2 根指令文档（P01–P24 批次、`REVIEW.md` 五轮 review 合同、`NEXT_BATCH.md` 等）已归档为历史证据于 `docs/history/v0.2-root/`，其**有效修复（VALID FIXES）已保留在 src 中**，是当前开发起点。**不要重新开启五轮 review**（用户外部审查已接管）；**不要用旧 ZIP 覆盖当前源码**，也不在不核对当前代码的情况下盲目 cherry-pick 旧提交。后续用户协同 review 反馈仍须修复并定向回归，但不自动启动第六轮全仓 review。

## 提交与记录

保留当前 TypeScript/SQLite/React/Fastify 框架与历史。按可 review 的增量本地提交组织工作，完成一个阶段后更新唯一当前 `PROGRESS.md`；不擅自 push、部署、发布、开 PR 或更改远端权限。只记录可见决策与证据，不收集隐藏思维链；遇到无法解决的技术错误，记录具体错误、已尝试修复与影响范围，不伪造通过。
