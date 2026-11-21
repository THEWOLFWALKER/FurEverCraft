# Review Scope — FurEverCraft P01–P23 离线开发分支

> 分支：`review/furevercraft-p24-round2-2026-10-24`
> 基线：`main@c27dcfa`（用户报告的已知基线）
> 本分支 HEAD：P01–P23 + P24 准备项 + 内部 Review Round 1–2 修复（以 `git log -1` 为准）
> 运行环境：Linux x86_64，Node `v22.23.4`，npm `10.9.9`
>
> **外部 review 交接**：按用户最新指令，内部五轮 review 在 Round 2 后停止，Round 3–5 改由外部 review 给出问题。P24 不标记完成；外部问题返回后逐项修复并回归。

本文用于说明这次 review 应该看什么、哪些是已完成、哪些是明确未完成或受外部阻塞，尽量避免把“尚未实现/按设计保持不可用”误报为回归缺陷。**这不是对 review 范围的限制**；任何真实的正确性、并发、安全、资源上界、测试可信度问题都欢迎指出。

---

## 1. 本分支包含什么

本分支把本轮 P01–P23 的实现合并在一起，约 97 个文件、+14.9k 行（相对 `c27dcfa`）。合并顺序：

1. P05–P09：原始 TCP relay、framing/compression、adapter manifest、domain projection、进程编排
2. P10–P13：3D BodyAdapter 合同、Motor 接入、实时控制、独立模拟身体
3. P17–P20：Provider、技能生命周期、知识 release、空间/经验记忆
4. P14–P16：attach CLI、网页主流程、安全与 SSE
5. 跨流装配：`factory` / `router` / `skills` / `control` / `cli` 的单一路径接线
6. P21：真实 doctor、可回放 trace/replay
7. P22：真实 headless Playwright E2E
8. P23：组合故障与长时离线验证

`main` 本身未被改写；历史保留。所有提交都在本地完成后合并，未改动远端 `main`。

---

## 2. 当前可运行的检查（均为实际执行结果）

```bash
npm run typecheck        # pass
npm run build            # pass
npm run build:web        # pass
npm run test:offline     # 47 files / 409 tests passed (after P24 Round 2)
npm run test:v:offline   # integration 56, soak 2, diagnostics 15 passed
npm run test:web:e2e     # 2 Playwright Chromium tests passed (~19s)
npm run demo:offline     # 6 scenarios pass
npm run doctor           # 真实 Runtime 状态，不是静态常量
```

E2E 使用 Playwright 1.64.1 + Chrome for Testing 156.0.8078.4（headless，无截图/录像/trace）。没有真实 Minecraft、真实模型 API、真实 Windows 输入。

---

## 3. 架构与关键链路（review 时建议按链路追踪）

- **用户入口**：`src/cli/main.ts`（attach / serve / demo / doctor / bridge / trace）、`src/server/index.ts`（Fastify + SSE）、`web/src/**`（React 控制台）
- **单一控制面**：`src/control/service.ts` → 唯一的 `RuntimeAssembly`（`src/execution/factory.ts`）
- **Agent 链路**：`ToolRouter.invoke` → `Executor` → `SkillLifecycle` / skills → `Memory` / `Motor` → `InputSink` → body
- **桥链路**：loopback client → `src/bridge/relay/raw.ts` → upstream；旁路 `src/bridge/observer/**` 目前只到 framing → bounded queue → 观察元数据事件。`src/bridge/protocol/projection-pipeline.ts` 的 synthetic projector 装配只在测试中验证；没有 26.3 解码后的 packet payload，因此它尚未、也不能诚实地接到 relay/observer 或 WorldState。真实 domain projection 仍为 `unavailable`。
- **效果/恢复**：prepared → may-have-dispatched → confirmed/partial/ambiguous；`ownership` 跨进程锁、`SessionRuntime` 恢复预算、epoch/owner/revision fencing
- **Provider 链路**：`createConfiguredProvider` gate → canonical session → injected/网络 transport
- **知识与记忆**：`KnowledgeService` release/coverage/query；`MemoryService` scoped places/episodes/experiences
- **诊断**：`EventHub`、`TraceRecorder`、`doctor`、`replayTrace`（无外部副作用）

---

## 4. 任务状态（实现与验证分开报告）

| 任务 | 状态 | 主要证据 |
|---|---|---|
| P01 缺口映射 | done-offline | 本文件 + `PROGRESS.md`/`WORKSTREAM.md`（注意：原始 500/208 清单不在仓库内，未臆造编号） |
| P02 Runtime 装配 | done-offline | `src/execution/factory.ts`，`tests/unit/p01-p04.test.ts`，`tests/integration/integration-wiring.test.ts` |
| P03 执行/效果边界 | done-offline | `src/execution/admission.ts`、`src/agent/router.ts`、p01-p04/c2 测试 |
| P04 所有权/恢复 | done-offline | `src/execution/ownership.ts`、`session.ts`，双进程/恢复测试 |
| P05 原始 TCP relay | done-offline | `src/bridge/relay/**`，`tests/unit/raw-relay.test.ts`（18） |
| P06 framing/compression | done-offline | `src/bridge/observer/framing.ts`，`tests/unit/framing-compression.test.ts`（18） |
| P07 adapter manifest | done-limited（26.3 数据缺失） | `src/bridge/adapter/manifest.ts`，`configs/adapters/target-26.3.candidate.json`，manifest 测试（9） |
| P08 领域投影 | done-limited（synthetic 装配） | `src/bridge/protocol/projectors/**`、`projection-pipeline.ts`，p08 测试（14） |
| P09 进程编排 | done-offline（relay/observer 真实子进程；Windows helper 未真实启动） | `src/bridge/service/**`，p09/service-child 测试 |
| P10 3D 合同 | done-limited | `src/motor/contracts.ts`，`Legacy2DBodyAdapter` 显式 legacy；`place_one`/`look_at`/`dig_one` 仍为 2D |
| P11 导航→Motor | done-limited（模拟身体） | `src/skills/navigation.ts`、`src/motor/controller.ts`，`tests/unit/p10-p13.test.ts`、`integration-wiring.test.ts` |
| P12 实时控制 | done-offline | 单调时钟、预算、偏差、局部重规划、租约撤销测试 |
| P13 独立模拟身体 | done-offline（仅模拟控制闭环） | `src/fixtures/body-adapter.ts`、`simulated-body.ts`，非零 z/头部障碍/台阶/跳跃边界 |
| P14 attach CLI | done-offline | `src/cli/main.ts`，`tests/integration/cli-attach.test.ts`（真实 readline + 服务） |
| P15 网页主流程 | done-offline | `web/src/**`，P22 浏览器 E2E |
| P16 安全/SSE | done-offline | `src/server/index.ts`，`tests/integration/p16-security.test.ts` |
| P17 Provider | done-limited（注入 transport） | `src/providers/**`，`tests/unit/providers-p17.test.ts`（11） |
| P18 技能/调度 | done-limited | `src/skills/lifecycle.ts`、`registry.ts`，`tests/unit/skills-p18.test.ts`（10） |
| P19 知识接线 | done-limited（fixture source，无 26.3 语料） | `src/autonomous/knowledge.ts`，`tests/unit/knowledge-p19.test.ts`（9） |
| P20 空间/经验记忆 | done-limited | `src/autonomous/memory.ts`、`src/persistence/store.ts`，`tests/unit/memory-p20.test.ts`（7） |
| P21 doctor/trace/replay | done-offline | `src/diagnostics/doctor.ts`、`trace.ts`，`tests/diagnostics/**`（15） |
| P22 Playwright E2E | done-offline（模拟 body + 真实 server/浏览器） | `tests/e2e/**`，2 tests passed |
| P23 组合故障/长时 | done-offline | `tests/unit/p23-*`、`tests/integration/p23-process-faults.test.ts`、`tests/soak/p23-fault-soak.test.ts` |
| P24 最终一致性与五轮 review | **未完成（外部 review 接管）** | 内部 Round 1–2 已完成并合并；按用户指令停止内部 Round 3–5，等待外部 review 问题后收尾 |

状态词只表示：`done-offline` = 离线可执行并有测试；`done-limited` = 实现范围/验证边界受限，限制见下。

---

## 5. 明确尚未完成的部分（请勿按缺陷计数，但可以指出实现上会 blocking 的点）

1. **P24 与五轮 review 未完成（外部 review 接管）**：P24 的脚本/端点/文档已落地；内部 Round 1（完整性与真实接线）与 Round 2（并发、崩溃与生命周期）已完成并合并。按用户最新指令，内部 Round 3–5 不再执行，改由外部 review 给出问题；P24 不标记完成，待外部结果修复后再收尾。
2. **仓库进度文档已更新到 P24 Round 2**：`PROGRESS.md`、`WORKSTREAM.md`、`DELIVERY_REPORT.md`、`CLAUDE.md` 反映当前状态；最终一致性整理仍待 P24 收尾。
3. **`trace:export` / `trace:replay` npm scripts 已在 P24 加入**，并有真实 CLI 调用记录。
4. **`/api/v1/doctor` 已在 P24 加入**，复用 `ControlService.diagnostics()` 与同一条认证路径。
5. **26.3 真实数据完全缺失**：已安装的 `minecraft-data@3.87.0` 没有 26.3 的 version/protocol 数据；所有 26.3 decoder/domain 保持 `unsupported`/`unavailable`，只做 fail-closed 与 synthetic 合同测试。没有伪字段、没有把最新依赖当成 26.3。
6. **没有真实客户端/服务器/世界**：relay/observer 只在 loopback 无游戏引擎夹具上验证；没有任何 live compatibility 声明。
7. **没有真实 Windows 输入/截图**：Windows helper 只有注入 transport 与静态/单元测试，不调用 SendInput。
8. **没有真实模型 API**：OpenAI/Anthropic 只用注入 transport 与离线 fixture 验证，所有网络 gate 默认关闭。
9. **Motor 只有模拟证据**：turn / 平地 walk / stop / 短跳；`stepUp`、`controlledDrop` 明确禁用；没有真实 26.3 物理/地形数据。E2E 的 body 也是 fixture。
10. **默认 `simulated` profile 仍是 legacy 2D**；公共入口 `serve --profile simulated-3d`（以及 doctor）现在会装配同一个 simulated 3D BodyAdapter/Motor 链。“legacy-2d”是诚实标签，不是把 `{x,y}` 伪造成 `z=0`。
11. **P22 的 E2E 不覆盖真实 Minecraft**：覆盖真实 Fastify/ControlService/浏览器 DOM/CLI 共用同一 Runtime，但身体是模拟的。
12. **P23 的 60 分钟是虚拟时间**：只证明预算/资源上界，不等于长期稳定性证明；另有短墙钟 smoke。
13. **CI 未实际运行**：Node 22 本地通过，但云端 CI 结果未观察；HTTP/模型/输入/截图 gate 仍默认关闭。

---

## 6. 易于误报的点（请结合上下文判断）

- `unsupported` / `unavailable` / `legacy-2d` / `synthetic` / `fixture` 多数是**有意的 fail-closed 结果**，不是遗漏。尤其 26.3 数据缺失时不允许猜字段。
- 某些工具仍只接受 2D（`place_one`、`look_at`、`dig_one`），这是 P10 明确保留的 legacy 边界；`navigate_to` 已要求 `x/y/z`。
- 默认 demo 的 2D 行为是为保持 legacy simulated profile；生产型 3D 装配通过 `--profile simulated-3d` 或注入 `bodyAdapter`，仍是模拟 body。
- 测试中的 `synthetic` / `fixture` body/transport 是合同夹具，不应被当成“真实环境证据”；反过来，也不要求它们在离线环境产生真实客户端字节。
- `bridge --mode live` 仍被 gate 阻断是预期行为（没有真实 body/服务器）。
- doctor 输出中的 `degraded`/`unknown` 可能反映当前环境（如内存 DB、未启动 session、无知识 release），不一定是缺陷。

---

## 7. 建议重点审查的方向（不限以下）

1. **执行/效果边界**：prepared 持久化失败、派发前后崩溃、并发取消、旧 finalizer、部分效果、receipt 与观察确认的区分。
2. **所有权/恢复**：双进程争用、崩溃重启、world/account/dimension 隔离、不完整快照、恢复预算、跨 epoch 新证据。
3. **relay/observer**：双向字节不变、半关闭、慢消费者、背压、压缩边界、未知/间隙的 sticky 语义、observer 故障不阻塞转发。
4. **3D 合同与 Motor**：2D→3D 是否还有隐式路径、目标/观察/租约版本校验、暂停/换目标/断连是否立即释放输入、A* 前提与落地容差。
5. **控制面安全**：pairing、Origin/Host、CSRF、CLI bearer、SSE 重连/cursor gap、静态目录穿越、日志脱敏。
6. **Provider/技能**：canonical history/tool 配对、写工具重放、重试预算、暂停/取消、partial/ambiguous 是否被误升级为成功。
7. **知识/记忆**：release 固定、scope 隔离、新鲜度、冲突可见、历史经验是否直接授权动作。
8. **测试可信度**：断言是否证明公开行为、负例是否真的会失败、E2E 是否真的启动浏览器、测试是否清理临时 DB/进程、是否存在恒成功路径。
9. **文档/能力声明一致性**：实现状态、测试数量、外部 gate、Node 版本、未实现项是否被如实报告。

---

## 8. 如何复现与反馈

```bash
git fetch origin
git switch review/furevercraft-p01-p23-2026-10-24
npm ci
npm run typecheck && npm run build && npm run build:web
npm run test:offline && npm run test:v:offline
npx playwright install chromium   # 仅首次
npm run test:web:e2e
npm run demo:offline && npm run doctor
```

反馈建议带：严重性、触发条件、`file:line`、实际影响、是否已被现有测试覆盖、最小复现。若属于第 5 节列出的未完成/外部阻塞项，请标注为“known gap”而不是回归；若实现与文档/能力声明冲突，请直接指出。

---

## 9. 分支说明

- 本分支：`review/furevercraft-p24-round2-2026-10-24`（含 P01–P23、P24 准备项、Round 1–2 修复）
- 上一检查点：`review/furevercraft-p01-p23-2026-10-24`、更早的 `review/p22-e2e`，均可视为中间产物。
- 未推送 `main`，未部署、未发布。
