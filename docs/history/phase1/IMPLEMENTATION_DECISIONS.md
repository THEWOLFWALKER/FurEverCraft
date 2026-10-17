# 第一阶段实施定案

本文件把本阶段所有架构选项收敛为执行决定。不要另做技术选型，不提出路线选择题。docs 是目标架构背景；本阶段按以下内容实施。

## 1. 技术栈

- Node.js 22 LTS，TypeScript strict，ESM，npm，单 package。
- 编译器 tsc，测试 Vitest，CLI commander，结构化日志 pino。
- schema 使用 Zod；工具 JSON Schema 使用与所选 Zod 主版本配套的 zod-to-json-schema 3.x，Zod 固定为 3.x。TS 类型从 Zod 推导。
- SQLite 使用 better-sqlite3，手写版本化 SQL 迁移，不用 ORM。
- HTTP 使用 Node 内置 fetch，通过自建 HttpTransport 接口注入；不引入供应商 SDK。
- 流式 SSE decoder 自建为小模块，正确处理 UTF-8 和事件分片，通过 fixture 测试，不引入通用 Agent 框架。
- 测试 mock transport 为默认；本地 HTTP 测试如有必要仅绑定 127.0.0.1。运行时外网默认禁止，生产 provider 必须显式 enableNetwork 才能联网。
- npm 依赖使用满足以上主版本约束、兼容 Node 22 的版本，安装后保存精确版本并提交 package-lock.json。这是依赖解析，不重新讨论库选型。
- 不引入 MCP、LangChain、LangGraph、Temporal、Redis、向量库、Python、Rust、Docker 或工作区多包系统。

## 2. 固定目录

```text
src/contracts/
src/bridge/fake/
src/bridge/unavailable/
src/state/
src/execution/
src/controllers/
src/skills/
src/navigation/
src/agent/
src/providers/openai/
src/providers/anthropic/
src/providers/scripted/
src/persistence/migrations/
src/cli/
src/diagnostics/
tests/unit/
tests/integration/
tests/fixtures/providers/
tests/scenarios/
examples/
```

不做真实 OS 输入与协议代理实现；UnavailableClientBridge 声明原因并拒绝启动真实 profile。禁止把空实现返回成功。

## 3. 固定开发命令

- `npm run typecheck` → tsc --noEmit。
- `npm run build` → tsc 输出 dist。
- `npm run test:offline` → Vitest run，默认网络封锁和虚拟时间。
- `npm run demo:offline` → 先构建，再执行 dist/cli/main.js demo --profile simulated。
- `npm run cli -- --profile simulated` → 先构建，再启动交互控制台，透传用户参数。

README 解释首次 npm ci，不要求 Key 或游戏环境。CI workflow 只跑 typecheck/build/test:offline，不联网访问 Minecraft 或模型服务。

## 4. 数据库第一版

实现 schema_migrations、goals、executions、effects、critical_events、checkpoints、places、episodes 八张表。其中 effects 对 effect_id 唯一，executions 对 proposal_id 唯一。

每张身份相关表保存 schema_version、创建/更新时间；世界相关记录保存 profile/worldGeneration/dimension。业务内容允许使用经 Zod 校验的 JSON 列，不强行将所有嵌套字段拆表。

- goals：goal_id、revision、status、body_context、spec_json。
- executions：execution_id、proposal_id、proposal_hash、goal_id、skill_id/version、status、reason、outcome、checkpoint_json。
- effects：effect_id、execution_id、context、status、intent_json、evidence_json。
- critical_events：单调本地 event_seq、event_id、kind、context、payload_json。
- checkpoints：checkpoint_id、execution_id、revision、payload_json。
- places：place_id、context、status、last_verified_at、payload_json。
- episodes：episode_id、context、event_refs_json、summary_json。
- schema_migrations：version、applied_at。

以以上八张表为第一版固定 schema；不要增加占位表。

SQLite WAL、foreign_keys=ON。Store 单写者；事务覆盖目标/执行状态与关键事件关联更新。没有跨服务器 exactly-once 保证。

## 5. 固定模拟场景

- 默认 12×12 的二维整数格小地图，地面高度固定；cell 为 free/blocked/unknown。不是 Minecraft 物理。
- A* 使用四邻接、Manhattan 启发式、确定性邻居顺序，无对角移动；unknown 不生成边。
- 玩家位置按离散步推进，向目标格的输入由 walk 原语产生，bridge 负责应用并回报；不能由 planner 直接改位置。
- 虚拟控制周期 50ms；这是测试调度参数，不宣称真实客户端 20Hz 保证。
- 默认最多 3 次局部路径重算，同一失败签名最多 2 次重试，后续挂起并报告。
- 初始背包 8 个 simulated_block；place_one 只允许相邻、已知 free 且非玩家所在格，成功后数量减 1，格子变 blocked。
- UI 为 gameplay/chat/inventory；文本模式禁止移动输入，切回 gameplay 后重新观察才续行。
- 提供固定种子和显式故障事件列表，默认不随机。
- demo 不模拟精确跳跃、水流或伤害模型。需要 AIR/WATER 交接测试时使用明确标为状态夹具的模式事件，仅验证合同。

## 6. 固定调度与恢复

- 一个进程运行 Runtime，FakeClientBridge 可同进程注入；不实现跨进程时钟同步。不同 clockDomain 的控制命令直接拒绝。
- Clock 接口支持 now/schedule/cancel；测试用 ManualClock，生产用 MonotonicClock。
- 每个输入 commandId 只应用一次，按键状态序号单调；动作期限同时检查生成时间、观测年龄与 lease。
- 核心事件环形缓冲默认 1024 条，诊断轨迹默认 4096 条；溢出行为有测试。
- 崩溃模拟重新创建 Store/Runtime，不复用旧租约内存。Fake 环境状态独立保留或显式加载 fixture，以体现外部世界不会随 Runtime 回滚。
- goal/execution/effect 由独立稳定 ID 关联。模型 call ID 不作为幂等键。

## 7. 固定模型边界

- OpenAI 默认协议路径 /v1/chat/completions；Anthropic 默认 /v1/messages。baseUrl/model 可配置。
- 环境变量 OPENAI_API_KEY、ANTHROPIC_API_KEY；Anthropic 协议版本 header 由配置显式提供，示例用固定值 2023-06-01，不把它解释为模型能力版本。
- 两个 provider 实现 encodeRequest、decodeResponse、decodeStream、cancel、错误分类；ScriptedProvider 实现同一业务接口。
- 测试 fixtures 覆盖文本、图片、单/多工具、交错流、无效 JSON、结束原因、限流、服务端错误、取消。
- HTTP 429/5xx 仅在无业务工具提交且请求预算允许时最多重试 2 次，transport 重试不重放工具；测试用虚拟延迟。
- 非标准专用内容块报告 unsupported 并保留脱敏诊断，不静默执行其中内容。

## 8. 固定交付流程

按 P01–P12 执行并完成 A01–A21。遇到实现细节，按已有合同作局部决定并写记录，不抛回开放式技术选择题。

缺少游戏版本、OS、服务器配置或 Key：继续离线开发，不询问，不增加真实接入工作。依赖安装失败时先修复环境/版本兼容；确实无法运行则如实报告，不能伪造通过或换成内存持久化。

产品约束变更不在开发 Agent 自主范围。本阶段已经排除了这些依赖，不应再以此为由中断普通开发。
