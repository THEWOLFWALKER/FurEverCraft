# Review Scope — FurEverCraft P01–P24 离线交付

> 分支：`main`
> 当前 HEAD：`f1c5f90`（`fix(P24 rounds 3-5): enforce scope, recovery, gates and truthful reporting`）
> Review 历史：Round 1–2 checkpoint `17cdf06`；Round 3 `ee9eea7`；Round 4–5 与最终修复 `f1c5f90`
> 运行环境：Linux x86_64，Node `v22.23.4`，npm `10.9.9`，仅离线
>
> 五轮 review 已全部完成。按用户明确指示，Round 4 与 Round 5 并发执行以加快交付；所有修复完成后，最终完整检查在 `f1c5f90` 上串行执行。P24 在离线范围内为 `done-offline`；不代表真实 Minecraft 26.3、Windows 或付费模型 API 已验证。

本文用于说明这次 review 应该看什么、哪些是已完成、哪些是明确受限或受外部阻塞，尽量避免把“尚未实现/按设计保持不可用”误报为回归缺陷。**这不是对 review 范围的限制**；任何真实的正确性、并发、安全、资源上界、测试可信度问题都欢迎指出。

---

## 1. 本提交包含什么

本仓库包含本轮 P01–P24 的完整离线实现与五轮 review 修复：

1. P05–P09：原始 TCP relay、framing/compression、adapter manifest、domain projection、进程编排
2. P10–P13：3D BodyAdapter 合同、Motor 接入、实时控制、独立模拟身体
3. P17–P20：Provider、技能生命周期、知识 release、空间/经验记忆
4. P14–P16：attach CLI、网页主流程、安全与 SSE
5. 跨流装配：`factory` / `router` / `skills` / `control` / `cli` 的单一路径接线
6. P21：真实 doctor、可回放 trace/replay
7. P22：真实 headless Playwright E2E（9 tests）
8. P23：组合故障与长时离线验证
9. P24：trace 脚本、认证 doctor 端点、严格配置、认证模式、fixture/protocol 脚本分离、CI 配置与五轮 review 修复

历史保留；本轮未改写既有已合并实现。文档只描述可核对的本地状态。

---

## 2. 当前可运行的检查（均为实际执行结果）

最终串行检查，HEAD `f1c5f90`，构建后运行（`dist/` 存在，子进程测试不会因缺 dist 而跳过）：

```bash
npx tsc --noEmit              # exit 0
npm run build                 # exit 0
npm run test:offline          # 58 files / 578 tests passed, 0 skipped
npm run build:web             # exit 0
npm run test:v:offline        # 98 tests: integration 11/71, soak 2/2, diagnostics 2/25
npm run test:web:e2e          # 9/9 Playwright Chromium tests passed
npm run demo:offline          # 6/6 scenarios passed
npm run doctor                # exit 0，truthful degraded
npm run doctor -- --profile simulated-3d  # exit 0，runtime profile simulated-3d，body 3D
```

E2E 使用 Playwright + Chromium（headless，无截图/录像/trace）。没有真实 Minecraft、真实模型 API、真实 Windows 输入，也没有观察到 CI 实际运行。

---

## 3. 架构与关键链路（review 时建议按链路追踪）

- **用户入口**：`src/cli/main.ts`（attach / serve / demo / doctor / bridge / trace）、`src/server/index.ts`（Fastify + SSE）、`web/src/**`（React 控制台）
- **单一控制面**：`src/control/service.ts` → 唯一的 `RuntimeAssembly`（`src/execution/factory.ts`）
- **Agent 链路**：`ToolRouter.invoke` → `Executor` → `SkillLifecycle` / skills → `Memory` / `Motor` → `InputSink` → body
- **桥链路**：loopback client → `src/bridge/relay/raw.ts` → upstream；旁路 `src/bridge/observer/**` 到 framing → bounded queue → 观察元数据事件。`src/bridge/protocol/projection-pipeline.ts` 的 synthetic projector 装配只在测试中验证并明确标注 synthetic-only；没有 26.3 解码后的 packet payload，因此它尚未、也不能诚实地接到 relay/observer 或 WorldState。真实 domain projection 仍为 `unavailable`。
- **效果/恢复**：prepared → may-have-dispatched → confirmed/partial/ambiguous；`ownership` 跨进程锁、`SessionRuntime` 恢复预算、epoch/owner/revision fencing
- **Provider 链路**：`createConfiguredProvider` gate → canonical session → injected/网络 transport
- **知识与记忆**：`KnowledgeService` release/coverage/query；`MemoryService` scoped places/episodes/experiences
- **诊断**：`EventHub`、`TraceRecorder`、`doctor`、`replayTrace`（无外部副作用）

### 3.1 认证模式

| 模式 | 启动方式 | 浏览器行为 |
|---|---|---|
| `pairing` | 默认，或 `--pairing-code <code>` | 用一次性 code 配对；HttpOnly session + CSRF |
| `bearer-only` | `--no-pairing --cli-bearer <token>` | 浏览器访问禁用；使用 CLI bearer |
| `loopback-open` | `--no-pairing` 且无 bearer | 仅 loopback 开放；显式开发模式 |

`GET /api/v1/auth-mode` 是公开且不含秘密的启动信息端点。生成的 pairing code 只在 stdout 是交互式 TTY 时打印；非 TTY `serve` 必须显式提供 `--pairing-code` 或 `MINECRAFT_AGENT_PAIRING_CODE`，否则以 `pairing-code-required:non-tty` 失败。显式提供的 code 不会被打印。

### 3.2 serve 配置与 provider

`serve --config <path>` 使用严格 loader，只接受 serve 能实际执行的键（`profile`、`allowModelNetwork`）；其他键报 `config-key-unused:<key>`，不会被静默忽略。`--provider openai|anthropic` 仅在配置 `allowModelNetwork: true` 且提供 API key（`--api-key` 或 `MINECRAFT_AGENT_MODEL_API_KEY`）时有效；无 provider 的开放 gate、无 gate 的 provider、无 key 的 provider 都会失败。`configs/serve-offline.example.json` 的 gate 保持关闭；本批次未调用付费 API。

### 3.3 bridge fixture 与 protocol

- `npm run bridge:fixture`：使用 `configs/bridge-fixture.example.json`，默认 fixture 模式，目标是 loopback echo，不是配置的真实目标。
- `npm run bridge:protocol`：使用 `configs/simulated.json`，在 fixture 模式报告版本/协议摘要。
- `bridge --mode service` 才使用 `targetHost`/`targetPort`；`live` 仍被 gate 阻断。`configs/client-offline.example.json` 的 upstream gate 为 false，只适合 `bridge --mode inspect`。

---

## 4. 任务状态（实现与验证分开报告）

| 任务 | 状态 | 主要证据 |
|---|---|---|
| P01 缺口映射 | done-offline | 本文件 + `PROGRESS.md`/`WORKSTREAM.md`（原始 500/208 清单不在仓库内，未臆造编号） |
| P02 Runtime 装配 | done-offline | `src/execution/factory.ts`，`tests/unit/p01-p04.test.ts`，`tests/integration/integration-wiring.test.ts` |
| P03 执行/效果边界 | done-offline | `src/execution/admission.ts`、`src/agent/router.ts`、p01-p04/c2 测试 |
| P04 所有权/恢复 | done-offline | `src/execution/ownership.ts`、`session.ts`，双进程/恢复测试 |
| P05 原始 TCP relay | done-offline | `src/bridge/relay/**`，`tests/unit/raw-relay.test.ts`（19），Round 5 observer 测试 |
| P06 framing/compression | done-offline | `src/bridge/observer/framing.ts`，`tests/unit/framing-compression.test.ts`（18），`p24-round3-observer.test.ts` |
| P07 adapter manifest | done-limited | `src/bridge/adapter/manifest.ts`，`configs/adapters/target-26.3.candidate.json`，manifest 测试（10），`p24-round3-adapter`；**限制：26.3 数据缺失** |
| P08 领域投影 | done-limited | `src/bridge/protocol/projectors/**`、`projection-pipeline.ts`，p08 测试（14），`tests/integration/synthetic-observation-chain.test.ts`；**限制：synthetic 装配，test-only 且明确标注 synthetic-only** |
| P09 进程编排 | done-offline | `src/bridge/service/**`，p09/service-child 测试；**限制：Windows helper 未真实启动** |
| P10 3D 合同 | done-limited | `src/motor/contracts.ts`，`Legacy2DBodyAdapter` 显式 legacy；**限制：`place_one`/`look_at`/`dig_one` 仍为 2D** |
| P11 导航→Motor | done-limited | `src/skills/navigation.ts`、`src/motor/controller.ts`，`tests/unit/p10-p13.test.ts`、`integration-wiring.test.ts`；**限制：模拟身体** |
| P12 实时控制 | done-offline | 单调时钟、预算、偏差、局部重规划、租约撤销测试 |
| P13 独立模拟身体 | done-offline | `src/fixtures/body-adapter.ts`、`simulated-body.ts`，非零 z/头部障碍/台阶/跳跃边界；**限制：仅模拟控制闭环** |
| P14 attach CLI | done-offline | `src/cli/main.ts`，`tests/integration/cli-attach.test.ts`（真实 readline + 服务） |
| P15 网页主流程 | done-offline | `web/src/**`，P22 浏览器 E2E（9 tests） |
| P16 安全/SSE | done-offline | `src/server/index.ts`，`tests/integration/p16-security.test.ts`，`/api/v1/auth-mode` |
| P17 Provider | done-limited | `src/providers/**`，`tests/unit/providers-p17.test.ts`（11），`p24-round3-provider`；**限制：注入 transport** |
| P18 技能/调度 | done-limited | `src/skills/lifecycle.ts`、`registry.ts`，`tests/unit/skills-p18.test.ts`（10）；**限制：离线有限范围** |
| P19 知识接线 | done-limited | `src/autonomous/knowledge.ts`，`tests/unit/knowledge-p19.test.ts`（11）；**限制：fixture source，无 26.3 语料** |
| P20 空间/经验记忆 | done-limited | `src/autonomous/memory.ts`、`src/persistence/store.ts`，`tests/unit/memory-p20.test.ts`（7）；**限制：fixture/simulated 范围** |
| P21 doctor/trace/replay | done-offline | `src/diagnostics/doctor.ts`、`trace.ts`，`tests/diagnostics/**`（25），认证 `/api/v1/doctor` |
| P22 Playwright E2E | done-offline | `tests/e2e/**`，9/9 Chromium tests passed；**限制：模拟/fixture body，无截图/录像/trace** |
| P23 组合故障/长时 | done-offline | `tests/unit/p23-*`、`tests/integration/p23-process-faults.test.ts`、`tests/soak/p23-fault-soak.test.ts`；60 虚拟分钟 + 墙钟 smoke |
| P24 最终一致性与五轮 review | done-offline | 五轮全部完成；Round 4/5 按用户指示并发执行；最终检查在 `f1c5f90`；**仅离线范围** |

状态词只表示：`done-offline` = 离线可执行并有测试；`done-limited` = 实现范围/验证边界受限，限制见上；`blocked-external` = 依赖本批禁止的真实环境/数据；`not-done` = 未满足验收。

---

## 5. 已知限制与外部阻塞（请勿按缺陷计数，但可以指出实现上会 blocking 的点）

1. **26.3 真实数据完全缺失（P07/P08）**：已安装的 `minecraft-data@3.87.0` 没有 26.3 的 version/protocol 数据；所有 26.3 decoder/domain 保持 `unsupported`/`unavailable`，只做 fail-closed 与 synthetic 合同测试。没有伪字段、没有把最新依赖当成 26.3。
2. **真实 26.3 投影不可用（P08）**：relay/observer 只发射 frame metadata；没有解码后的 packet payload 可供真实 projection/WorldState 使用。synthetic 装配只在测试中验证并标注 synthetic-only。
3. **没有真实客户端/服务器/世界**：relay/observer 只在 loopback 无游戏引擎夹具上验证；没有任何 live compatibility 声明。
4. **没有真实 Windows 输入/截图（P09）**：Windows helper 只有注入 transport 与静态/单元测试，不调用 SendInput；native provenance 未验证。
5. **没有真实模型 API（P17）**：OpenAI/Anthropic 只用注入 transport 与离线 fixture 验证，所有网络 gate 默认关闭；`serve --provider` 只验证 gate/key 行为，不发起真实请求。
6. **Motor 只有模拟证据（P10/P11/P13）**：turn / 平地 walk / stop / 短跳；`stepUp`、`controlledDrop` 明确禁用；没有真实 26.3 物理/地形数据。E2E 的 body 也是 fixture/simulated。
7. **P18 技能/调度范围有限**：生命周期与调度只有离线有界证据，不是长期 live 调度证明。
8. **P19 知识来源为 fixture**：没有 26.3 语料；conflict/validity 只在该 fixture 范围内成立。
9. **P20 记忆为 fixture/simulated 证据**：没有真实世界地点验证。
10. **默认 `simulated` profile 仍是 legacy 2D**；公共入口 `serve --profile simulated-3d`（以及 doctor）会装配同一个 simulated 3D BodyAdapter/Motor 链。“legacy-2d”是诚实标签，不是把 `{x,y}` 伪造成 `z=0`。`runtimeProfile` 与 `serverProfileId` 分开报告。
11. **P22 的 E2E 不覆盖真实 Minecraft**：覆盖真实 Fastify/ControlService/浏览器 DOM/CLI 共用同一 Runtime；9 个 Chromium tests 中有 fixture body 和 simulated-3d body，均非 Minecraft 客户端。
12. **P23 的 60 分钟是虚拟时间**：只证明预算/资源上界，不等于长期稳定性证明；另有短墙钟 smoke。
13. **认证/配置边界**：默认 pairing；`--no-pairing` + bearer 为 `bearer-only`（浏览器禁用）；`--no-pairing` 无 bearer 为 `loopback-open`。非 TTY `serve` 必须显式提供 pairing code。`serve --config` 拒绝未使用键。
14. **CI 未实际运行**：Node 22 本地通过，workflow 定义了 Playwright browser job，但云端 CI 结果未观察；HTTP/模型/输入/截图 gate 仍默认关闭。

---

## 6. 易于误报的点（请结合上下文判断）

- `unsupported` / `unavailable` / `legacy-2d` / `synthetic` / `fixture` 多数是**有意的 fail-closed 结果**，不是遗漏。尤其 26.3 数据缺失时不允许猜字段。
- 某些工具仍只接受 2D（`place_one`、`look_at`、`dig_one`），这是 P10 明确保留的 legacy 边界；`navigate_to` 已要求 `x/y/z`。
- 默认 demo 的 2D 行为是为保持 legacy simulated profile；生产型 3D 装配通过 `--profile simulated-3d` 或注入 `bodyAdapter`，仍是模拟 body。
- 测试中的 `synthetic` / `fixture` body/transport 是合同夹具，不应被当成“真实环境证据”；反过来，也不要求它们在离线环境产生真实客户端字节。
- `bridge --mode live` 仍被 gate 阻断是预期行为（没有真实 body/服务器）。
- `bridge:fixture` 与 `bridge:protocol` 都是离线 fixture/检查路径；前者是默认 loopback fixture，后者报告协议/版本摘要，均不是 live。
- doctor 输出中的 `degraded`/`unknown` 可能反映当前环境（如内存 DB、未启动 session、无知识 release），不一定是缺陷。
- `bearer-only` 模式下网页显示“browser access disabled; use CLI bearer”是真实安全边界，不是 UI 缺失。

---

## 7. 后续审查/回归建议重点（不限以下）

1. **执行/效果边界**：prepared 持久化失败、派发前后崩溃、并发取消、旧 finalizer、部分效果、receipt 与观察确认的区分。
2. **所有权/恢复**：双进程争用、崩溃重启、world/account/dimension 隔离、不完整快照、恢复预算、跨 epoch 新证据。
3. **relay/observer**：双向字节不变、半关闭、慢消费者、背压、压缩边界、未知/间隙的 sticky 语义、per-TCP-session epoch、observer 故障不阻塞转发。
4. **3D 合同与 Motor**：2D→3D 是否还有隐式路径、目标/观察/租约版本校验、暂停/换目标/断连是否立即释放输入、A* 前提与落地容差。
5. **控制面安全**：pairing/bearer-only/loopback-open、非 TTY pairing、Origin/Host、CSRF、CLI bearer、SSE 重连/cursor gap、静态目录穿越、日志脱敏。
6. **Provider/技能**：canonical history/tool 配对、写工具重放、截断/非法响应、重试预算、暂停/取消、partial/ambiguous 是否被误升级为成功。
7. **知识/记忆**：release 固定、scope 隔离、validity/conflict、新鲜度、历史经验是否直接授权动作。
8. **配置/能力声明**：strict config 的未使用键、serve provider gate、bridge fixture/protocol 分离、runtimeProfile/serverProfileId、Windows capability 派生。
9. **测试可信度**：断言是否证明公开行为、负例是否真的会失败、E2E 是否真的启动浏览器、测试是否清理临时 DB/进程、是否存在恒成功路径。
10. **文档/能力声明一致性**：实现状态、测试数量、外部 gate、Node 版本、未实现项是否被如实报告。

---

## 8. 如何复现与反馈

在当前交付树（`main` @ `f1c5f90`）运行：

```bash
npm ci
npm run typecheck && npm run build && npm run build:web
npm run test:offline && npm run test:v:offline
npx playwright install chromium   # 仅首次
npm run test:web:e2e
npm run demo:offline && npm run doctor
npm run doctor -- --profile simulated-3d
```

反馈建议带：严重性、触发条件、`file:line`、实际影响、是否已被现有测试覆盖、最小复现。若属于第 5 节列出的外部阻塞项，请标注为“known gap”而不是回归；若实现与文档/能力声明冲突，请直接指出。

---

## 9. 提交说明

- 当前交付：`main` @ `f1c5f90`（P01–P24 + 五轮 review 修复 + 最终文档整理）
- 检查点：Round 1–2 `17cdf06`；Round 3 `ee9eea7`；Round 4–5 与最终修复 `f1c5f90`
- 五轮已完成；Rounds 4/5 按用户明确指示并发执行，最终完整检查在 `f1c5f90` 串行执行
- 不代表真实 26.3、Windows 或付费模型 API 已验证；CI 未被观察到运行
