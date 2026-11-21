# FurEverCraft P24 Round 2 — 五份外部审查去重综合报告

> **合并对象**：`THEWOLFWALKER/FurEverCraft` ｜分支 `review/furevercraft-p24-round2-2026-10-24` ｜固定提交 `17cdf063cd8b97af8d7a8d7094116870e11fdd1e`。
> **材料日期**：2026-10-24；**整理方式**：仅对用户提供的 Markdown 审查报告做逐条归并、重复核验、矛盾口径处理和可追踪索引，**不是另一次源码复核/动态复现**。
> **写作边界**：汇报缺陷、风险、触发条件、证据与已知不确定性；不添加修复设计，也不把尚未接线的 Java 26.3 真正 codec / Windows 真机测试视为新的已实现模块 Bug。

## 0. 去重结果（已逐项核对）

- 共收到 **5 个文件**；其中 `FurEverCraft-P24-round2-independent-review-2026-10-24.md` 和带 `-1` 后缀的文件 **字节完全一致**（两者 SHA-256 均为 `11ba0e59ee110366d485b84501aa8c38d70c27eedd81d9f232c4f5cb6b5707f1`），不是两轮独立新增问题，完全去重。
- 剩余 **4 份不同报告**共列出 **91 条有编号的问题条目**（22 + 25 + 28 + 16），另有未单列编号的补充风险；经按具体失效路径交叉核对，形成 **61 个去重后的核查项**。这里的 91→61 **不是精确的‘重复删除 30 条’**：有些原始条目覆盖多个可独立触发的分支，另有补充段落被独立纳入，不能把两个数字相减当作重复次数。
- 有意不把“相同根因但不同分支/边界”的问题过度压缩：例如压缩帧的两条代码分支与夹具错误分别编号；TCP 同时多会话混线与前一会话残留污染分别保留；Observer 崩溃、IPC 丢控制信息与手动 armControl 则是三种独立撤权路径。
- 此 61 项中整理优先级：**P0 = 5、P1 = 37、P2 = 17、待确认 = 2**。优先级是跨报告的**统一排查排序**，而非真实环境复现后的漏洞级别；原报告对同一问题有 P0/P1 口径差异，不能把原始评级简单相加。

### 五份输入的处理

| 输入文件 | 原始编号 | 处理 |
|---|---:|---|
| `FurEverCraft-review-17cdf06-evidence-audit-2026-10-24.md` | 22 | 逐条吸收入综合条目；SHA-256 `5a5c50b71951…` |
| `FurEverCraft-P24-round2-independent-review-2026-10-24.md` | 25 | 逐条吸收入综合条目；SHA-256 `11ba0e59ee11…` |
| `FurEverCraft-P24-round2-independent-review-2026-10-24-1.md` | 25 | 与上一份字节相同，不再计数；SHA-256 `11ba0e59ee11…` |
| `FurEverCraft_review_round2_真实问题审查_2026-10-24.md` | 28 | 逐条吸收入综合条目；SHA-256 `005644d4af8a…` |
| `FurEverCraft-P24-Round2-Security-Boundary-Audit-2026-10-24.md` | 16 | 逐条吸收入综合条目；SHA-256 `d03afa65dcb1…` |

### 基线证据与范围保留

四份不同报告均指定同一个固定 SHA，并且多数问题附指向该 SHA 的文件、行号。主报告保留每项原始编号以便开发 Agent 从原文追踪，不把重复次数当“多次独立动态复现”。只有独立审查报告另引用了 **Windows CI 作业 `40074500831`**：`verify` 成功、`windows-static` 失败，所附测试摘要为 **2 failed / 400 passed / 7 skipped**；此为报告当时的 CI 证据，**不是本次重新访问 GitHub 后确认的最新状态**。

**证据分类**：`规格+静态` 指源报告核对公开 Minecraft 帧规格并给出代码机制；`静态` 指代码控制流可推断；`条件性` 指只在特定竞态、注入或环境下可能出现；`历史CI实测` 只指材料记录的 Windows 作业；`待确认` 是源报告明确无法证明的调用约定/接线前提。**这些标识都不等于这次整理重新运行了测试。**

## 1. 最需要优先处理的风险链

**协议事实链**：FEC-01/02 两类合法 compression-on 网络帧都可能被错误切包；FEC-03 错误单测格式恰好给错误实现背书。多 Session 混线和断线后旧缓存复用进一步污染观察。不能用“尚未做好 26.3 领域 packet decoder”掩盖已存在的帧层逻辑问题。

**观察失效仍写动作**：FEC-08/09/10/12 构成状态、心跳、IPC 事件、动作准入之间的撤权缺口；Windows FEC-15 是独立于 Node 父事件循环的放键问题。这些风险依赖对应真实输入链启用，报告并未证明默认产品已能对真实服务器执行这些动作。

**所有权、因果与范围**：FEC-22 在旧身体资源退出之前释放独占锁；FEC-23/24/25 使 effect ledger 在恢复竞态或外部世界变化时记错派发/成功归因；FEC-45~51 暴露知识、记忆和目标上下文隔离不足。

**长时 Agent 语义**：FEC-39~44 对工具幂等、assistant/tool 历史和动作顺序有直接影响；FEC-28 对规划世代屏障有潜在影响；FEC-53~59 是控制台、数据导出与诊断边界。

## 2. 去重后完整问题清单（61 项）

### 一、协议、旁路观察与 Relay

#### FEC-01 · P0 · 压缩帧将 Packet Length 与 Data Length 的语义反置

**证据属性**：规格+静态。 **原始编号**：有源码证据问题报告 `FEC-R01`；外部独立审查（25项） `FC-R01`；真实问题审查（28项） `P1-02`；安全/信任边界专项（16项） `SEC-01`。

**问题与影响**：压缩帧的外层 Packet Length 是内层 Data Length 字段与线上载荷的总长度；Data Length 非零时表示解压后的长度。解码器却使用内层值确定线上取帧长度、用外层值验证解压长度，使合法压缩流出现错位、解压异常或错误 UNKNOWN。原始 TCP 透传可能继续正常，但旁路观察证据不可靠。

**最小核查场景**：用真实规范编码的 zlib 压缩帧，尤其是可压缩 PLAY 包；不依赖 26.3 的具体 packet ID。

**固定 SHA 源码/CI 证据**：[`src/bridge/observer/framing.ts#L227-L286`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/observer/framing.ts#L227-L286)；[`tests/unit/framing-compression.test.ts#L15-L20`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/tests/unit/framing-compression.test.ts#L15-L20)。

#### FEC-02 · P0 · 已启用压缩但本帧未压缩时，多消费 Data Length 字段长度

**证据属性**：规格+静态。 **原始编号**：有源码证据问题报告 `FEC-R02`；外部独立审查（25项） `FC-R02`；真实问题审查（28项） `P1-01`；安全/信任边界专项（16项） `SEC-01`。

**问题与影响**：Data Length=0 的帧，外层 Packet Length 已包含该字段；现有分支却重复把内层 VarInt 所占字节加到 total。单包不出帧，连续包还可能吞下下一帧前缀，形成持续失步。虽然与 01 共享格式误解，但这是独立的非 zlib 分支。

**最小核查场景**：合法帧字节 `02 00 01`，随后分别测试独立投喂及追加下一合法包。

**固定 SHA 源码/CI 证据**：[`src/bridge/observer/framing.ts#L236-L249`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/observer/framing.ts#L236-L249)；[`tests/unit/framing-compression.test.ts`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/tests/unit/framing-compression.test.ts)。

#### FEC-03 · P1 · 压缩协议单测夹具和实现共享错误字段格式

**证据属性**：静态+规格。 **原始编号**：有源码证据问题报告 `FEC-R03`；外部独立审查（25项） `FC-R03`；真实问题审查（28项） `P1-03`；安全/信任边界专项（16项） `SEC-01`。

**问题与影响**：`compressedFrame()` 将未压缩大小、压缩大小按错误顺序编码；`uncompressedInCompressedFrame()` 少计内层字段。这是测试证据失效，不是第三种生产解码路径：已有绿色测试只证明夹具和实现互相一致，无法证明兼容 Minecraft wire format。

**最小核查场景**：对比测试构造器输出与协议标准字节，使用独立的协议正确 fixture 复测 01/02。

**固定 SHA 源码/CI 证据**：[`tests/unit/framing-compression.test.ts#L15-L20`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/tests/unit/framing-compression.test.ts#L15-L20)；[`src/bridge/observer/framing.ts#L237-L284`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/observer/framing.ts#L237-L284)。

#### FEC-04 · P1 · 不同 TCP 连接复用同一个方向解码缓冲

**证据属性**：静态。 **原始编号**：真实问题审查（28项） `P1-04`；安全/信任边界专项（16项） `SEC-02`。

**问题与影响**：Relay 为所有下游 Session 共享 ObserverWorkerHost；chunk 消息只带方向/字节，不带 session identity；worker 只有两套全局方向帧缓存。两个合法连接的字节可能被交错解释为同一流，压缩阶段、offset、gap 与 frameSequence 均无连接归属。

**最小核查场景**：两个回环客户端交错发送 VarInt 前缀和完整帧；检查各自观察序列是否串流。

**固定 SHA 源码/CI 证据**：[`src/bridge/relay/raw.ts#L17-L22`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/relay/raw.ts#L17-L22)；[`src/bridge/relay/entry.ts#L24-L45`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/relay/entry.ts#L24-L45)；[`src/bridge/observer/worker.ts#L18-L39`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/observer/worker.ts#L18-L39)；[`src/bridge/observer/host.ts#L139-L148`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/observer/host.ts#L139-L148)。

#### FEC-05 · P1 · 断线后复用旧会话残留帧、phase 和压缩状态

**证据属性**：静态。 **原始编号**：真实问题审查（28项） `P1-05`；安全/信任边界专项（16项） `SEC-02`。

**问题与影响**：连接关闭没有向 observer 下发按 session 划分的 reset；下一连接继承旧半包或 phase/compression 状态。与 04 同属会话边界根因，但触发于串行重连而不是并发多连接，故保留独立验证场景。

**最小核查场景**：先断开有半个帧的客户端，再接入新客户端并发送完整握手/帧。

**固定 SHA 源码/CI 证据**：[`src/bridge/relay/raw.ts#L204-L207`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/relay/raw.ts#L204-L207)；[`src/bridge/relay/entry.ts#L40-L45`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/relay/entry.ts#L40-L45)；[`src/bridge/observer/worker.ts#L31-L47`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/observer/worker.ts#L31-L47)；[`src/bridge/observer/host.ts#L139-L148`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/observer/host.ts#L139-L148)。

#### FEC-06 · P1 · Worker 入站 postMessage 队列位于有界 Observer 预算之外

**证据属性**：静态/容量未压测。 **原始编号**：外部独立审查（25项） `FC-R04`；真实问题审查（28项） `P1-06`；安全/信任边界专项（16项） `SEC-05`。

**问题与影响**：Relay 无条件 `worker.postMessage({type:"chunk",bytes})`，缺少在途 bytes、ack 或宿主级背压。Worker 内 maxQueuedBytes/Frames 仅覆盖收到后的任务；慢 worker 下跨线程消息/复制内存可以持续积压。

**最小核查场景**：以延迟消费的 mock worker 连续注入 chunk；观察 host 在途字节是否超出观察器上限。

**固定 SHA 源码/CI 证据**：[`src/bridge/observer/host.ts#L139-L143`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/observer/host.ts#L139-L143)；[`src/bridge/relay/entry.ts#L40-L46`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/relay/entry.ts#L40-L46)；[`src/bridge/observer/bounded.ts#L15-L30`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/observer/bounded.ts#L15-L30)；[`src/bridge/observer/worker.ts#L18-L34`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/observer/worker.ts#L18-L34)。

#### FEC-07 · P2 · Observer 任务超时后，仍运行的监听器被当作已释放并发槽

**证据属性**：条件静态。 **原始编号**：有源码证据问题报告 `FEC-R07`；外部独立审查（25项） `FC-R05`。

**问题与影响**：`Promise.race(work, timeout)` 超时只降低 inflight 计数，未真正取消 listener。新任务随即获准，真实仍在执行的异步回调数可超过 maxConcurrency；通常同步 postMessage 监听器不一定触发。

**最小核查场景**：注入永不 resolve 的异步 subscriber，按 taskTimeoutMs 连续送帧。

**固定 SHA 源码/CI 证据**：[`src/bridge/observer/bounded.ts#L240-L292`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/observer/bounded.ts#L240-L292)。

#### FEC-08 · P0 · Observer 失败只降级状态，不关闭之后的新写动作准入

**证据属性**：静态。 **原始编号**：有源码证据问题报告 `FEC-R04`；外部独立审查（25项） `FC-R06`；真实问题审查（28项） `P1-07`。

**问题与影响**：`onObserverFailure()` 标记 degraded 并派发事件，Runtime 可取消当时运行的任务，但 `admissionOpenValue` 与 `controlRevokedValue` 不变。原已 arm 的 service 因而仍可为后来的写动作返回 admissionOpen=true。

**最小核查场景**：armControl → 模拟 observer worker error/exit → 在旧任务取消后再次尝试启动写技能。

**固定 SHA 源码/CI 证据**：[`src/bridge/service/orchestrator.ts#L144-L166`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/service/orchestrator.ts#L144-L166)；[`src/execution/factory.ts#L250-L260`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/execution/factory.ts#L250-L260)。

#### FEC-09 · P0 · IPC 队列丢失控制消息后，unknown 状态未驱动撤权

**证据属性**：静态。 **原始编号**：有源码证据问题报告 `FEC-R06`；外部独立审查（25项） `FC-R07`；真实问题审查（28项） `P1-08`。

**问题与影响**：BoundedIpcOutbox 的 controlLost 状态在 BridgeService.emit 中只转为 globalUnknown/日志，没有真正发出 Runtime 监听的 ipc-overflow 事件，也没有调用 revokeControl。严重控制消息丢失与新的动作准入脱钩。

**最小核查场景**：调小 outbox 消息/字节预算制造控制消息被逐出，检查事件、cancelAll 与 admission。

**固定 SHA 源码/CI 证据**：[`src/bridge/service/ipc-outbox.ts#L35-L51`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/service/ipc-outbox.ts#L35-L51)；[`src/bridge/service/orchestrator.ts#L232-L246`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/service/orchestrator.ts#L232-L246)；[`src/execution/factory.ts#L290-L300`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/execution/factory.ts#L290-L300)。

#### FEC-10 · P1 · armControl 可在 stopped/failed/degraded 或未知状态直接重开准入

**证据属性**：静态。 **原始编号**：有源码证据问题报告 `FEC-R05`；外部独立审查（25项） `FC-R08`。

**问题与影响**：公开 `armControl(reason)` 不对生命周期、worker/helper 健康、观测新鲜度或 IPC globalUnknown 做条件检查，直接将 admissionOpen 设为 true、controlRevoked 设为 false；reason 只是文本，不是可信观测凭证。

**最小核查场景**：service.stop 后调用 armControl，比较 state、controlRevoked 与 admissionOpen。

**固定 SHA 源码/CI 证据**：[`src/bridge/service/orchestrator.ts#L122-L150`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/service/orchestrator.ts#L122-L150)。

#### FEC-11 · P1 · start-observer/stop-observer IPC 回执成功，但实际 Worker 不变

**证据属性**：静态。 **原始编号**：有源码证据问题报告 `FEC-R08`。

**问题与影响**：Bridge service 收到控制 IPC 后调用 RelayObserverMonitor 的空 start/stop 实现并返回 ok；Worker 生活在 Relay 子进程中，没有执行对应启停。调用方得到的成功回执和真实生命周期不一致。

**最小核查场景**：控制面发送 stop-observer，持续向 Relay 注入帧，检查 worker 仍处理。

**固定 SHA 源码/CI 证据**：[`src/bridge/service/entry.ts#L13-L20`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/service/entry.ts#L13-L20)。

#### FEC-12 · P1 · Relay 子进程卡住但不退出时，心跳 owner-loss 检查不被周期调用

**证据属性**：静态+条件。 **原始编号**：真实问题审查（28项） `P1-09`。

**问题与影响**：`ProcessSupervisor.checkOwner()` 可以识别心跳过期，但目前依赖外部显式调用，未看到定时巡检入口。child 存活、IPC 静默时无 exit 事件，service 可能持续报告 running 并维持准入。

**最小核查场景**：让 mock child 进程保持存活但停止心跳/IPC，持续观察 service 状态和控制撤权。

**固定 SHA 源码/CI 证据**：[`src/bridge/supervisor.ts#L164-L177`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/supervisor.ts#L164-L177)；[`src/bridge/service/orchestrator.ts#L122-L142`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/service/orchestrator.ts#L122-L142)。

#### FEC-13 · P2 · TCP Relay 缺少全局下游连接数和上游连接配额

**证据属性**：静态/容量未压测。 **原始编号**：安全/信任边界专项（16项） `SEC-04`。

**问题与影响**：每个新 downstream socket 立即建立一个固定目标的 upstream 连接；单会话写队列硬限制不约束总连接数、FD、内存与上游槽位。默认回环监听减轻远程暴露，不等于已有总容量上限。

**最小核查场景**：只对自建的回环 upstream 开大量无握手连接，测 sessions 与 accepted count。

**固定 SHA 源码/CI 证据**：[`src/bridge/relay/raw.ts#L70-L72`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/relay/raw.ts#L70-L72)。

#### FEC-14 · P2 · TCP 上游连接完成前客户端 EOF 时半关闭定时器缺失

**证据属性**：静态+条件。 **原始编号**：真实问题审查（28项） `P2-22`。

**问题与影响**：client end 早于 upstream connect 时仅设置 clientEndedBeforeConnect；后续 releaseUpstream 会执行 server.end，却没有启动普通路径的 halfCloseTimer，上游不 EOF 可让 Session 超过预期的半关闭寿命。

**最小核查场景**：client 连接后立即 EOF，上游延迟连接且保持不关闭。

**固定 SHA 源码/CI 证据**：[`src/bridge/relay/raw.ts#L121-L132`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/relay/raw.ts#L121-L132)。

### 二、Windows Helper、认证与输入安全

#### FEC-15 · P1 · Windows Helper 的 8 秒心跳/输入租约过期不会自主触发放键

**证据属性**：静态/真机未验证。 **原始编号**：有源码证据问题报告 `FEC-R22`；真实问题审查（28项） `P1-10`；安全/信任边界专项（16项） `SEC-03`。

**问题与影响**：`$heartbeatDeadline` 和租约只在下一次 Assert-Action 检查；Helper 主循环被 ReadLine 阻塞时没有独立时钟唤醒。若 Node 事件循环冻结但 stdin 未关闭，已按住的键可能持续保留，Node JS watchdog 也无法运行。

**最小核查场景**：授权的受控 Windows 假输入/测试窗口中保留 stdin，停止送行但不 EOF，越过 TTL。

**固定 SHA 源码/CI 证据**：[`native/windows/FurEverCraft.Helper.ps1#L34-L53`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/native/windows/FurEverCraft.Helper.ps1#L34-L53)；[`src/bridge/windows/driver.ts#L115-L118`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/windows/driver.ts#L115-L118)。

#### FEC-16 · P1 · Helper 活着但不回 JSONL 响应时请求可能永久 pending

**证据属性**：静态+条件。 **原始编号**：有源码证据问题报告 `FEC-R22`；真实问题审查（28项） `P1-11`。

**问题与影响**：前者文件的补充风险而非 FEC-R22 的同一细项：`JsonlHelperTransport.send()` 没有每个请求的 response timeout；只靠 Abort、进程 exit/error 或 write 异常 settle。故持续不回复的 helper 可卡住 bind、heartbeat、释放乃至 shutdown。

**最小核查场景**：FakeHelperTransport 接受命令但不回复也不退出，观察 Promise 是否永久挂起。

**固定 SHA 源码/CI 证据**：[`native/windows/FurEverCraft.Helper.ps1#L34-L53`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/native/windows/FurEverCraft.Helper.ps1#L34-L53)；[`src/bridge/windows/driver.ts#L115-L118`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/windows/driver.ts#L115-L118)。

#### FEC-17 · 待确认 · setHeldInputs 未提及的旧按键是否释放取决于未明确的契约

**证据属性**：条件性语义。 **原始编号**：安全/信任边界专项（16项） `SEC-15`。

**问题与影响**：Helper 对显式 true/false 做增量更改，遗漏字段不会移除 `$owned` 里的旧键。若上层把每次 inputs 当完整目标集合，会产生按键叠加；若明确规定 patch 语义则现行为可接受。原文未证成该契约，不能记为无条件 Bug。

**最小核查场景**：同 generation 依次发送 `{87:true}` 与 `{65:true}`，先核实调用方要求快照还是 patch。

**固定 SHA 源码/CI 证据**：[`native/windows/FurEverCraft.Helper.ps1#L80-L83`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/native/windows/FurEverCraft.Helper.ps1#L80-L83)；[`src/bridge/windows/driver.ts#L157`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/windows/driver.ts#L157)。

#### FEC-18 · P1 · Windows 长文本输入中途窗口切换后仍继续发送字符

**证据属性**：静态/真机未验证。 **原始编号**：安全/信任边界专项（16项） `SEC-11`。

**问题与影响**：`typeText` 在进入逐字符 SendInput 前只校验一次焦点、PID、代次及租约。由于 SendInput 面向全局前台窗口，运行过程中焦点改变会使后续文本可能进入另一应用。

**最小核查场景**：仅在授权的两个空白测试窗口内切换焦点，用虚构文本确认行为。

**固定 SHA 源码/CI 证据**：[`src/bridge/windows/driver.ts#L147-L162`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/windows/driver.ts#L147-L162)；[`native/windows/FurEverCraft.Helper.ps1#L41-L52`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/native/windows/FurEverCraft.Helper.ps1#L41-L52)。

#### FEC-19 · P2 · Windows mouse/text 的 commandId 去重集合无寿命/容量上限

**证据属性**：静态。 **原始编号**：真实问题审查（28项） `P2-26`；有源码证据问题报告 `FEC-R22`。

**问题与影响**：Node completedCommands Set 和 PowerShell `$seen` HashSet 随鼠标、点击、文本命令增长，未见容量、过期或重绑定清理。与心跳放键是不同资源边界，需独立统计。

**最小核查场景**：长时模拟大量唯一 commandId，观察集合大小与内存增长。

**固定 SHA 源码/CI 证据**：[`src/bridge/windows/driver.ts#L93-L101`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/windows/driver.ts#L93-L101)；[`native/windows/FurEverCraft.Helper.ps1#L29-L33`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/native/windows/FurEverCraft.Helper.ps1#L29-L33)。

#### FEC-20 · P2 · CLI 将可选 bearer/pairing 明文写入命令行参数

**证据属性**：静态/受部署影响。 **原始编号**：安全/信任边界专项（16项） `SEC-14`。

**问题与影响**：支持 `--cli-bearer`、`--token`、`--pairing-code` 等参数，可能进入 shell history、进程列表或本机审计。此为可选用法的本机凭据暴露，不等于环境变量路径也有相同问题。

**最小核查场景**：仅用 TEST_ONLY_TOKEN 在受控系统查看进程参数/历史。

**固定 SHA 源码/CI 证据**：[`src/cli/main.ts#L433-L445`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/cli/main.ts#L433-L445)。

#### FEC-21 · 待确认 · 认证执行器只拿 login/register 标签，缺少提示来源证明

**证据属性**：潜在接线边界。 **原始编号**：安全/信任边界专项（16项） `SEC-12`。

**问题与影响**：`CompositeClientBridge.authenticate(prompt)` 只收到枚举，不含发言主体、消息来源、可信 channel 或前置验证记录。若未来把普通聊天误分为 login/register，可能使用凭据执行输入；但现有材料没有证明伪造聊天能到达上线的认证调用链。

**最小核查场景**：确认真实调用来源和分类器后，在离线 fake credentials 上测试错误来源是否能被提升为认证。

**固定 SHA 源码/CI 证据**：[`src/bridge/composite.ts#L25-L29`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/bridge/composite.ts#L25-L29)；[`CLIENT_BRIDGE.md#L62-L70`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/CLIENT_BRIDGE.md#L62-L70)。

### 三、Runtime、执行语义与技能/Motor

#### FEC-22 · P0 · Runtime.close 在子进程/输入异步停机前释放跨进程 owner lock

**证据属性**：静态+竞态。 **原始编号**：有源码证据问题报告 `FEC-R09`；外部独立审查（25项） `FC-R15`；真实问题审查（28项） `P1-15`。

**问题与影响**：`close()` 对 sessionSupervisor.stop/bridgeService.stop/bridge.shutdown 使用 void Promise，不等待完成便 store.close/ownership.release。新 Runtime 可拿到锁时旧 Relay/Helper/held inputs 仍可能存在，形成两个 owner 的时间窗口；仅分析竞态，未称实机复现。

**最小核查场景**：让 stop/shutdown 故意 pending，旧实例 close 后立即尝试第二实例获取同一 DB lock。

**固定 SHA 源码/CI 证据**：[`src/execution/factory.ts#L302-L330`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/execution/factory.ts#L302-L330)；[`src/control/service.ts#L334-L349`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/control/service.ts#L334-L349)。

#### FEC-23 · P1 · 显式 recover 会触碰仍在执行中的 effect

**证据属性**：静态+竞态。 **原始编号**：有源码证据问题报告 `FEC-R10`。

**问题与影响**：恢复在 pendingEffects 调和阶段不检查所属 execution 是否仍由本进程活动执行，活跃执行仅在后续 suspend 循环排除。操作员在技能进行时发 recover，可把正在进行的效果写成 ambiguous。

**最小核查场景**：延迟一条放置技能观察，于 may-have-dispatched 窗口执行 control recover。

**固定 SHA 源码/CI 证据**：[`src/execution/session.ts#L82-L142`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/execution/session.ts#L82-L142)；[`src/control/service.ts#L313-L322`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/control/service.ts#L313-L322)。

#### FEC-24 · P1 · effect 单调 rank 吞掉已被恢复改写的派发屏障更新

**证据属性**：静态+竞态。 **原始编号**：有源码证据问题报告 `FEC-R11`。

**问题与影响**：`ambiguous` rank 高于 `may-have-dispatched`；被 recover 先改成 ambiguous 后，guardedReport(dispatch) 的 `updateEffect` 会返回旧值而非抛错，调用者不检查返回值仍派发真实动作，DB 不再能证明本次派发屏障。与 23 形成连锁，但这是独立的更新/调用合同失效。

**最小核查场景**：让 recover 抢先写 ambiguous，再检查 dispatch 前 updateEffect 的返回值与物理调用。

**固定 SHA 源码/CI 证据**：[`src/persistence/store.ts#L221-L228`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/persistence/store.ts#L221-L228)；[`src/agent/router.ts#L327-L336`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/agent/router.ts#L327-L336)。

#### FEC-25 · P1 · 恢复把目标方块当前存在错误归因于本动作已完成

**证据属性**：静态/归因不成立。 **原始编号**：有源码证据问题报告 `FEC-R12`。

**问题与影响**：恢复若见 effect 处于 may-have-dispatched/verifying、上下文一致且目标格 blocked，即写 confirmed。may-have-dispatched 是派发前屏障，且世界可能由第三方改变，所以“目标已满足”不能证明“我做到了”。

**最小核查场景**：只写派发屏障不真正放置，由外部 fixture 改成 blocked 再 recover。

**固定 SHA 源码/CI 证据**：[`src/execution/session.ts#L113-L125`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/execution/session.ts#L113-L125)。

#### FEC-26 · P1 · 恢复可能挂起来自其他世界/账号、但没有 pending effect 的执行

**证据属性**：静态。 **原始编号**：有源码证据问题报告 `FEC-R13`。

**问题与影响**：foreignExecutions 仅依据当前 pendingEffects 的 context 推断 foreign execution；executions 表缺独立 context 列。若另一个账号的 queued/running execution 没有 pending effect，会被当前 session 恢复当成本地悬挂任务处理。

**最小核查场景**：同 DB 两个 context，给外账号建立无 pending effect 的运行任务，随后本账号 recover。

**固定 SHA 源码/CI 证据**：[`src/execution/session.ts#L85-L143`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/execution/session.ts#L85-L143)；[`src/persistence/store.ts#L68-L72`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/persistence/store.ts#L68-L72)。

#### FEC-27 · P2 · pause 的异步 settled 路径会等待自己登记的 activeRun

**证据属性**：静态/时序。 **原始编号**：有源码证据问题报告 `FEC-R14`。

**问题与影响**：`pause` 在第一次 await 后通过 interruptExecutions 再次等 activeRuns，此时 pause 当前 Promise 也在集合里，直到 1 秒 timeout 才退出。该自等待仅有证据指向 pause 路径，不扩展推断 stop/quit 的初次快照。

**最小核查场景**：无其他执行时测 pause 响应延时，观察约 1 秒自等待。

**固定 SHA 源码/CI 证据**：[`src/control/service.ts#L285-L298`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/control/service.ts#L285-L298)。

#### FEC-28 · P1 · Scheduler generation 未作为 AgentLoop 写动作的实际 fencing

**证据属性**：静态+时序条件。 **原始编号**：外部独立审查（25项） `FC-R12`。

**问题与影响**：TaskScheduler.onWake(reason,generation) 的 generation 在回调完成后才用于过滤 woke 事件；Factory 没有把该代次绑到 AgentLoop 的工具动作准入。pause→resume 快速切换时，旧规划可能在新世代继续执行。

**最小核查场景**：让旧 onWake LLM 请求 pending，快速 pause/resume，再释放旧请求。

**固定 SHA 源码/CI 证据**：[`src/autonomous/tasks.ts#L70-L87`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/autonomous/tasks.ts#L70-L87)；[`src/execution/factory.ts`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/execution/factory.ts)。

#### FEC-29 · P1 · 并发重用 requestId 但 payload 不同时仍返回 in-flight accepted

**证据属性**：静态。 **原始编号**：外部独立审查（25项） `FC-R13`；真实问题审查（28项） `P2-19`；安全/信任边界专项（16项） `SEC-08`。

**问题与影响**：ControlService 先检查 inflight claimKey 并直接返回 accepted，未比较本次和首个请求的 payloadHash；只有 durable receipt 路径才比较。第二条未执行的异内容命令可能被误报已接受。

**最小核查场景**：相同 requestId + 不同 command/payload 同时发出，第一条刻意延迟。

**固定 SHA 源码/CI 证据**：[`src/control/service.ts#L209-L234`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/control/service.ts#L209-L234)。

#### FEC-30 · P2 · 持久命令失败回执重放时丢失原始错误 code

**证据属性**：静态。 **原始编号**：真实问题审查（28项） `P2-20`。

**问题与影响**：首次 CommandResult 带 goal-revision-conflict/paused 等 code；持久 receipt 只保存 result.result，许多拒绝没有对应结构。后续相同 requestId 从 receipt 重构时 code 缺失，造成同一请求两次响应语义不同。

**最小核查场景**：保存一次带 code 的失败命令，再用相同 requestId 重放并比较结果。

**固定 SHA 源码/CI 证据**：[`src/control/service.ts#L224-L232`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/control/service.ts#L224-L232)。

#### FEC-31 · P1 · MotionController 在 await body.observe 时无法由墙钟/取消立即退出

**证据属性**：条件性。 **原始编号**：外部独立审查（25项） `FC-R16`。

**问题与影响**：预算和 stopReason 检查发生在 await observe() 之前，observe 未接 AbortSignal；当 adapter 失联使 Promise 不 settle，wall-clock 预算超时/Executor cancel 不能及时中断卡住的 await。

**最小核查场景**：mock body.observe 永不 resolve，触发 pause/stop 与超时。

**固定 SHA 源码/CI 证据**：[`src/motor/controller.ts#L177-L201`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/motor/controller.ts#L177-L201)。

#### FEC-32 · P2 · 已在同一离散方块但连续落点超差仍返回 confirmed

**证据属性**：静态。 **原始编号**：外部独立审查（25项） `FC-R17`。

**问题与影响**：reached(pose,target,tolerance) 明确返回 false 后，同方块起终点的规划可能给出空 steps；controller 随即 finish confirmed，却未重新检查真实距离/支持状态，构成假到达。

**最小核查场景**：pose 在目标格边缘、与精确目标偏差超过 tolerance，规划输出零步。

**固定 SHA 源码/CI 证据**：[`src/motor/controller.ts#L202-L229`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/motor/controller.ts#L202-L229)。

#### FEC-33 · P2 · A* 周期性 yield 仅创建 Promise，没有让出事件循环

**证据属性**：静态。 **原始编号**：外部独立审查（25项） `FC-R18`。

**问题与影响**：同步 planRoute 内的 `void Promise.resolve()` 不会暂停调用栈；搜索期间仍可能连续占满事件循环，延迟 watchdog、控制 API 和关停任务。

**最小核查场景**：将搜索预算设较高，在执行中监测 timer/heartbeat 是否被明显延迟。

**固定 SHA 源码/CI 证据**：[`src/motor/action-graph.ts#L115-L136`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/motor/action-graph.ts#L115-L136)。

#### FEC-34 · P1 · Legacy gather 收到不确定回执后可能继续物理挖掘

**证据属性**：条件性。 **原始编号**：外部独立审查（25项） `FC-R19`。

**问题与影响**：`gatherBlocksLegacy()` 在 dig accepted 缺失或事后方块未 free 时只增加失败计数、继续循环，没有把“可能挖了但没确认”停留为 ambiguous。真实异步观察延迟时，下一次扫描可能重复挖掘或越过未知副作用。

**最小核查场景**：让 fake dig 实际改变世界，但其 receipt/后续观察延迟，count>1。

**固定 SHA 源码/CI 证据**：[`src/skills/skills.ts#L236-L267`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/skills/skills.ts#L236-L267)。

#### FEC-35 · P1 · gather_blocks(count>1) 只登记一个聚合 Effect，丢失单次 dig 归因

**证据属性**：静态。 **原始编号**：外部独立审查（25项） `FC-R20`。

**问题与影响**：Router 创建单个 effectId，而 3D gather 会发起多次独立 dig/collect。第 K 次成功后若崩溃，持久记录无法区分前 K 次已确认和后续未确认，恢复无法逐次对照副作用。

**最小核查场景**：count>1，在部分挖掘后崩溃并查看 effects/evidence 粒度。

**固定 SHA 源码/CI 证据**：[`src/agent/router.ts#L289-L384`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/agent/router.ts#L289-L384)；[`src/skills/skills.ts#L209-L234`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/skills/skills.ts#L209-L234)。

#### FEC-36 · P1 · 生产 Router 无条件把所有技能前置条件标为 true

**证据属性**：静态。 **原始编号**：真实问题审查（28项） `P2-27`。

**问题与影响**：`runWriteSkill` 将 manifest.prerequisites 转成每个名字都为 true 的 map，传入 SkillLifecycle，令 missingPreconditions 检查永远过关。个别技能内检验不能证明 manifest 检查链有效。

**最小核查场景**：为某技能提供 manifest 必须但环境不具备的前提，观察生命周期检查结果。

**固定 SHA 源码/CI 证据**：[`src/agent/router.ts#L357-L368`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/agent/router.ts#L357-L368)；[`src/skills/lifecycle.ts#L104-L123`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/skills/lifecycle.ts#L104-L123)；[`src/skills/registry.ts`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/skills/registry.ts)。

#### FEC-37 · P1 · 3D BodyAdapter 接线下仍把 legacy 2D place_one 宣称为可用

**证据属性**：静态。 **原始编号**：外部独立审查（25项） `FC-R14`。

**问题与影响**：availableSkills 有 3D 技能兼容判断，却未排除仅通过 planar bridge.cell(x,y)/bridge.place(x,y) 执行的 place_one。模型可收到不对应当前玩家身体的能力列表；实际会错误操作还是失败取决于 bridge 注入。

**最小核查场景**：仅注入 3D BodyAdapter 和 legacy shim，调用 find_skills/执行 place_one。

**固定 SHA 源码/CI 证据**：[`src/agent/router.ts#L104-L126`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/agent/router.ts#L104-L126)；[`src/skills/skills.ts#L83-L97`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/skills/skills.ts#L83-L97)。

#### FEC-38 · P1 · 3D gather 的已收集判定未与库存实际增量交叉验证

**证据属性**：条件性/回执语义。 **原始编号**：真实问题审查（28项） `P2-28`。

**问题与影响**：`gatherBody` 根据 dig.accepted、方块变 free、collected>0 和 items 长度确认为 gathered，但不核验本体 inventory 增量。若 adapter 报的是掉落预测而非拾取确证，可能把别人的拾取算给自己。

**最小核查场景**：伪造方块消失+掉落预测但玩家库存未变的回执，观察技能 confirmed。

**固定 SHA 源码/CI 证据**：[`src/skills/navigation.ts#L224-L255`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/skills/navigation.ts#L224-L255)；[`src/skills/skills.ts#L209-L233`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/skills/skills.ts#L209-L233)。

### 四、模型 Provider、工具调用与会话历史

#### FEC-39 · P1 · ToolExecutionLedger 以参数语义指纹跨轮永久抑制合法重复写动作

**证据属性**：静态。 **原始编号**：有源码证据问题报告 `FEC-R15`；外部独立审查（25项） `FC-R09`；真实问题审查（28项） `P1-12`。

**问题与影响**：writes map 的 key 是 name+canonical args，未包含新的 user turn、goal generation、执行请求或重试域。两次独立发同样文字/采集同参数技能，第二次只重播旧结果；甚至曾失败的首次结果也被当作永久去重。

**最小核查场景**：同一 ProviderSession 的两轮用户意图分别发送 send_chat("hello")。

**固定 SHA 源码/CI 证据**：[`src/providers/canonical.ts#L145-L179`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/providers/canonical.ts#L145-L179)；[`src/providers/session.ts#L92-L96`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/providers/session.ts#L92-L96)。

#### FEC-40 · P1 · 复用同一 tool_call_id 但参数改变时静默返回旧调用结果

**证据属性**：静态。 **原始编号**：有源码证据问题报告 `FEC-R16`。

**问题与影响**：`reuse()` 在指纹 miss 但 byId hit 后直接回传旧结果，没有校验工具名或参数。跨轮相同 ID 查询不同 execution 或发不同写命令时，模型看到与实际请求不一致的历史结果。

**最小核查场景**：用同一 call.id 连续查询 get_execution("A") 和 get_execution("B")。

**固定 SHA 源码/CI 证据**：[`src/providers/canonical.ts#L166-L176`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/providers/canonical.ts#L166-L176)。

#### FEC-41 · P1 · 无工具调用的最终助手文本未追加到规范会话历史

**证据属性**：静态。 **原始编号**：有源码证据问题报告 `FEC-R17`。

**问题与影响**：ProviderSession 在模型响应 toolCalls.length=0 时直接 return，未 history.appendAssistant(response.text)。下一轮历史保留上轮用户问题却丢失模型最后答复，影响指代、连续规划与 provider 切换。

**最小核查场景**：完成一轮纯文本回答后再次问“刚才第二个方案”，检查 CanonicalHistory。

**固定 SHA 源码/CI 证据**：[`src/providers/session.ts#L67-L87`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/providers/session.ts#L67-L87)；[`src/agent/router.ts#L463-L488`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/agent/router.ts#L463-L488)。

#### FEC-42 · P1 · 工具执行中取消会留下未配对的 tool_calls/tool_results

**证据属性**：静态+中断条件。 **原始编号**：有源码证据问题报告 `FEC-R18`；外部独立审查（25项） `FC-R10`。

**问题与影响**：先 history.appendAssistant(tool calls)，执行时 AbortSignal 可直接 throw 并跳过 appendToolResults。历史残留悬空 assistant tools，使 isToolHistoryComplete 失败，后续序列化到不同 provider 也可能被拒。

**最小核查场景**：模型一次返回两个工具，在第一条或第二条前取消，检查 history 配对。

**固定 SHA 源码/CI 证据**：[`src/providers/session.ts#L84-L135`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/providers/session.ts#L84-L135)；[`src/providers/canonical.ts#L184-L199`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/providers/canonical.ts#L184-L199)。

#### FEC-43 · P1 · revise_goal/cancel_execution 被误认只读并发工具

**证据属性**：静态。 **原始编号**：有源码证据问题报告 `FEC-R19`。

**问题与影响**：Canonical writeTools 集合只包含 start_skill/send_chat/remember_place；revise_goal 会写目标修订，cancel_execution 改执行状态，却可能跟其他只读调用一起 Promise.all，丧失模型指定的顺序语义。

**最小核查场景**：同轮发 revise_goal、cancel_execution 与 query 工具，观察并发执行和结果时序。

**固定 SHA 源码/CI 证据**：[`src/agent/router.ts#L411-L417`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/agent/router.ts#L411-L417)；[`src/providers/session.ts#L97-L118`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/providers/session.ts#L97-L118)。

#### FEC-44 · P2 · CanonicalHistory 的 trim 不约束工具密集型长期会话

**证据属性**：静态。 **原始编号**：有源码证据问题报告 `FEC-R20`；外部独立审查（25项） `FC-R11`；真实问题审查（28项） `P2-21`。

**问题与影响**：`trim(maxEntries=200)` 不删除带 toolCalls 的 assistant 及其 tool result；当历史主要由成对工具信息组成时无法缩至上限，还可能优先删掉相关 user 消息而保留工具副产物。内存和 prompt 上下文可能无限增长。

**最小核查场景**：连续模拟超过 200 条工具调用/回执，记录 history 长度与保留结构。

**固定 SHA 源码/CI 证据**：[`src/providers/canonical.ts#L203-L214`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/providers/canonical.ts#L203-L214)；[`src/agent/router.ts#L463-L479`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/agent/router.ts#L463-L479)。

### 五、记忆、知识、世界隔离

#### FEC-45 · P1 · query_knowledge_facts 未绑定可信 world scope，跨作用域 facts 可混入

**证据属性**：静态。 **原始编号**：外部独立审查（25项） `FC-R21`。

**问题与影响**：Router 将模型参数直接送 KnowledgeService.query，而工具 schema 无 scope；`scopeCompatible(requested=undefined)` 返回 true。带 server/account/world/dimension 限制的 facts 可能出现在不相关世界结果中。

**最小核查场景**：准备跨账号/维度有冲突 facts 的知识包，在当前 context 直接查询。

**固定 SHA 源码/CI 证据**：[`src/agent/router.ts#L209-L215`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/agent/router.ts#L209-L215)；[`src/autonomous/knowledge.ts#L100-L104`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/autonomous/knowledge.ts#L100-L104)。

#### FEC-46 · P1 · /api/v1/memories 的 episodes 不按当前账号/世界过滤

**证据属性**：静态。 **原始编号**：有源码证据问题报告 `FEC-R21`；外部独立审查（25项） `FC-R22`；真实问题审查（28项） `P1-17`；安全/信任边界专项（16项） `SEC-06`。

**问题与影响**：响应里 places 走带 scope 的 control.places()，但 episodes 直接 runtime.store.listEpisodes() 无条件取全表。完成控制台认证仍可能读取同一 SQLite 内其他账号/世界/维度的经历。是作用域/租户隔离失配，不是匿名绕过配对。

**最小核查场景**：同 DB 插入 A/B 两个 scope 的 episodes，以 A 访问合法配对的 memories。

**固定 SHA 源码/CI 证据**：[`src/server/index.ts#L196-L204`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/server/index.ts#L196-L204)；[`src/persistence/store.ts#L516-L520`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/persistence/store.ts#L516-L520)；[`src/control/service.ts#L190-L194`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/control/service.ts#L190-L194)；[`src/autonomous/memory.ts#L194-L207`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/autonomous/memory.ts#L194-L207)。

#### FEC-47 · P1 · goals/executions/effects/status 的控制读视图也可能跨上下文

**证据属性**：静态/部分模型依赖。 **原始编号**：安全/信任边界专项（16项） `SEC-06`。

**问题与影响**：ControlService.goals()/executions()/effects() 直接调用对应全表读取，status() 选第一个 active/paused goal 不校验当前 context。与 46 同属 scope 隔离根因，但影响独立的目标、执行、效果及状态端点，故单列验证。

**最小核查场景**：双账号/世界共享 DB，分别检查 /goals、/executions、/effects、/status 输出。

**固定 SHA 源码/CI 证据**：[`src/server/index.ts#L196-L204`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/server/index.ts#L196-L204)；[`src/control/service.ts#L190-L195`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/control/service.ts#L190-L195)；[`src/persistence/store.ts#L309-L330`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/persistence/store.ts#L309-L330)；[`src/autonomous/memory.ts#L194-L207`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/autonomous/memory.ts#L194-L207)。

#### FEC-48 · P1 · 记忆时间戳把 performance.now 当成 Unix 毫秒

**证据属性**：静态。 **原始编号**：真实问题审查（28项） `P1-13`。

**问题与影响**：SystemClock.now 默认返回进程相对 performance.now；rememberPlace 使用 new Date(now) 持久化，日期落在 1970 附近。重启后新旧进程的 age 还可能为负，导致过期地点误判 fresh，UI 时间也失真。

**最小核查场景**：真实时钟运行保存位置→重启进程→ query_memory/return_to_place 检查 age 和 lastVerifiedAt。

**固定 SHA 源码/CI 证据**：[`src/execution/factory.ts#L213-L216`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/execution/factory.ts#L213-L216)；[`src/autonomous/memory.ts#L101-L105`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/autonomous/memory.ts#L101-L105)；[`src/contracts/index.ts#L19-L28`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/contracts/index.ts#L19-L28)。

#### FEC-49 · P1 · memoryScope 在 Runtime 构造时固定，换世界后沿用旧 scope

**证据属性**：静态+上下文切换。 **原始编号**：真实问题审查（28项） `P1-14`。

**问题与影响**：memoryScopeOf(bridge.context) 在工厂阶段计算一次后传 readonly Router；若账号、维度或 worldGenerationId 更新，query_memory/remember_place/return_to_place 仍沿用旧值。身体 context fencing 并不能修正记忆源作用域。

**最小核查场景**：同进程切换 dimension 或 worldGenerationId 后读写地点记忆。

**固定 SHA 源码/CI 证据**：[`src/execution/factory.ts#L266-L272`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/execution/factory.ts#L266-L272)；[`src/agent/router.ts#L93-L103`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/agent/router.ts#L93-L103)。

#### FEC-50 · P1 · Scheduler 选目标未校验 goal 所属账号/世界

**证据属性**：静态+多世界。 **原始编号**：真实问题审查（28项） `P1-16`。

**问题与影响**：自动任务从 store.listGoals 选首个 active，而 ExecutionAdmission 主要核对 goalId/revision，未验证持久目标 body_context 与当前 bridge.context 一致。旧世界目标可能在新账号/世界继续驱动动作；即使 start 后 epoch 没变化也拦不住。

**最小核查场景**：跨账号共享 SQLite，旧账号留下 active goal，新账号启动自动任务。

**固定 SHA 源码/CI 证据**：[`src/execution/factory.ts#L277-L285`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/execution/factory.ts#L277-L285)；[`src/execution/admission.ts#L84-L100`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/execution/admission.ts#L84-L100)；[`src/control/service.ts#L98-L109`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/control/service.ts#L98-L109)。

#### FEC-51 · P1 · remember_place 可将模型生成坐标直接升级成已验证事实

**证据属性**：静态/可信源。 **原始编号**：真实问题审查（28项） `P1-18`。

**问题与影响**：remember_place 接受任意模型 JSON 坐标，未核验即时身体 observe/evidence，却设置 lastVerifiedAt=now；returnToPlaceTarget 只看新鲜度与有限数值，会把推算乃至错误位置视作可信返航地点。

**最小核查场景**：给工具一个未经观测的有限坐标，检查 persisted lastVerifiedAt 和 return_to_place 的接受。

**固定 SHA 源码/CI 证据**：[`src/agent/router.ts#L47-L49`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/agent/router.ts#L47-L49)；[`src/autonomous/memory.ts#L101-L105`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/autonomous/memory.ts#L101-L105)。

#### FEC-52 · P2 · Knowledge coverage 的 predicate 覆盖被误当每个 subject 的否定证据

**证据属性**：静态/知识完备性。 **原始编号**：真实问题审查（28项） `P2-25`。

**问题与影响**：当 predicate 有 coverage 声明时，即使 subject/scope 没查到任何事实，unknown 也会变 false。稀疏知识包里“本地没有这条记录”可能被模型当作“已确定不存在”。

**最小核查场景**：manifest 标 covers(predicate)，查询缺失的 subject，核对 items=[] 与 unknown 标志。

**固定 SHA 源码/CI 证据**：[`src/autonomous/knowledge.ts#L197-L225`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/autonomous/knowledge.ts#L197-L225)。

### 六、HTTP、SSE、诊断与持久化数据边界

#### FEC-53 · P2 · SSE 先发送 head snapshot 再 replay 较旧 ID，游标逆序

**证据属性**：静态。 **原始编号**：外部独立审查（25项） `FC-R23`；真实问题审查（28项） `P2-23`。

**问题与影响**：连接时先发 id=head 的新 snapshot，再发 id=cursor+1... 的旧事件，导致 EventSource Last-Event-ID/React cursor 回退、补播中断后可能重复事件，还可能用旧数据覆盖新视图。

**最小核查场景**：以小于 head 的 Last-Event-ID 连接，记录流中 id 顺序与断线重连行为。

**固定 SHA 源码/CI 证据**：[`src/server/index.ts#L309-L342`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/server/index.ts#L309-L342)；[`web/src/api.ts#L110-L124`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/web/src/api.ts#L110-L124)；[`web/src/App.tsx#L132-L143`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/web/src/App.tsx#L132-L143)。

#### FEC-54 · P2 · SSE 回放预算计算未预留 snapshot 自身占用

**证据属性**：静态/边界条件。 **原始编号**：真实问题审查（28项） `P2-24`。

**问题与影响**：replayBudget=maxEvents-sent 在发 snapshot 前计算；backlog 恰好等于预算时预判不 overflow，但 snapshot 消耗一个 event，最后补播产生额外 stream-budget gap。与 53 的游标逆序不同。

**最小核查场景**：设置 backlog 刚好等于 replayBudget 且 maxEvents 紧边界，检查是否意外 gap。

**固定 SHA 源码/CI 证据**：[`src/server/index.ts#L318-L335`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/server/index.ts#L318-L335)。

#### FEC-55 · P2 · SSE 只有单连接额度，没有服务级连接总量与写背压治理

**证据属性**：静态/容量未压测。 **原始编号**：安全/信任边界专项（16项） `SEC-09`。

**问题与影响**：每个认证 SSE 都自带定时器/快照，缺少所有连接合计配额；emit 不基于 raw.write(false) 暂停事件发送，仅 heartbeat 查看 writableNeedDrain。慢读消费者可累计内存和序列化成本。

**最小核查场景**：回环授权客户端并发打开多条慢读 SSE，计数连接、轮询与缓冲。

**固定 SHA 源码/CI 证据**：[`src/server/index.ts#L253-L291`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/server/index.ts#L253-L291)。

#### FEC-56 · P2 · API 和 trace 导出对全部 effects 先读全表再限制输出

**证据属性**：静态/资源风险。 **原始编号**：安全/信任边界专项（16项） `SEC-10`。

**问题与影响**：`listEffects().all()` 物化并 JSON.parse 全表；`exportTraceFromStore` 只在全部读取后 slice(maxEffects)。SSE snapshot、控制 API 也读取大量全表。输出行数预算不能保证加载阶段内存/延时有界。

**最小核查场景**：大 SQLite DB 上导出 maxEffects=1，同时观察执行前读取行数与峰值内存。

**固定 SHA 源码/CI 证据**：[`src/persistence/store.ts#L309-L330`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/persistence/store.ts#L309-L330)；[`src/diagnostics/trace.ts#L458-L485`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/diagnostics/trace.ts#L458-L485)；[`src/server/index.ts#L289-L297`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/server/index.ts#L289-L297)。

#### FEC-57 · P1 · 持久化 goal/effect 原文与 HTTP 响应绕过已有事件脱敏

**证据属性**：静态/读取需授权。 **原始编号**：安全/信任边界专项（16项） `SEC-07`。

**问题与影响**：EventHub/TraceRecorder/doctor 采用 redaction，但 send_chat 的 effect.intent.text 与 goal.text 按原文写 SQLite，/effects、/goals、/status 返回的记录缺同类脱敏。若文本含敏感凭据会在本地 DB/受权控制界面暴露，未证明存在真实密钥泄露。

**最小核查场景**：使用虚构 `token=TEST_ONLY_DO_NOT_USE` 对比 event/trace 与 DB/API 的输出。

**固定 SHA 源码/CI 证据**：[`src/diagnostics/redaction.ts#L1-L20`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/diagnostics/redaction.ts#L1-L20)；[`src/agent/router.ts#L311-L324`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/agent/router.ts#L311-L324)；[`src/persistence/store.ts#L201-L218`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/persistence/store.ts#L201-L218)；[`src/server/index.ts#L196-L208`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/server/index.ts#L196-L208)。

#### FEC-58 · P2 · trace:export 以非只读 SQLiteStore 构造绕过 runtime ownership

**证据属性**：静态/并发风险。 **原始编号**：安全/信任边界专项（16项） `SEC-13`。

**问题与影响**：CLI trace:export 不持有 runtime ownership，但 new SQLiteStore 会设置 WAL、运行迁移/索引 DDL，初始化并非只读。占有者运行时诊断进程可能发生 schema/WAL 写入或锁冲突；不能由此直接断言数据损坏。

**最小核查场景**：旧 schema 的本地 DB 在被 runtime 占用时执行 trace:export，检查变更和锁冲突。

**固定 SHA 源码/CI 证据**：[`src/diagnostics/trace.ts#L454-L459`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/diagnostics/trace.ts#L454-L459)；[`src/cli/main.ts#L401-L414`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/cli/main.ts#L401-L414)；[`src/persistence/store.ts#L54-L114`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/persistence/store.ts#L54-L114)；[`src/execution/factory.ts#L226-L246`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/execution/factory.ts#L226-L246)。

#### FEC-59 · P2 · trace:replay 可一次性装入超大本地 JSON 和无界结果数组

**证据属性**：静态/本地输入。 **原始编号**：安全/信任边界专项（16项） `SEC-16`。

**问题与影响**：CLI readFileSync + JSON.parse 将整份任意大小 trace 载入内存，replayTrace 遍历 records/effects 并克隆生成新数组，只有格式基础检查，没有文件大小或记录总数配额。风险是本机资源耗尽，不是回放执行输入/RCE。

**最小核查场景**：导入逐步增大但结构合法的虚构 trace，测 CLI 内存/耗时。

**固定 SHA 源码/CI 证据**：[`src/cli/main.ts#L505-L519`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/cli/main.ts#L505-L519)；[`src/diagnostics/trace.ts#L368-L438`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/diagnostics/trace.ts#L368-L438)。

### 七、Windows CI 的已观察失败

#### FEC-60 · P1 · Windows CI 的 adapter manifest 字节/哈希校验实际失败

**证据属性**：历史CI实测。 **原始编号**：外部独立审查（25项） `FC-R24`。

**问题与影响**：固定 SHA 的公开 Actions 作业 `40074500831` 中 windows-static 测试失败：manifest 期望 Helper.ps1 为 10376 bytes，Windows 实际读到 10266 bytes，同时 SHA-256 不一致。换行差异是候选原因，原材料未证明唯一根因。

**最小核查场景**：查看 Windows CI job `120814865166` 的 adapter-manifest.test.ts 断言与文件读取结果。

**固定 SHA 源码/CI 证据**：[`tests/unit/adapter-manifest.test.ts#L146-L151`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/tests/unit/adapter-manifest.test.ts#L146-L151)；[`Windows CI job 120814865166`](https://github.com/THEWOLFWALKER/FurEverCraft/actions/runs/40074500831/job/120814865166)。

#### FEC-61 · P1 · Windows CI 的 ownership-lock 单测实际未抛预期异常

**证据属性**：历史CI实测。 **原始编号**：外部独立审查（25项） `FC-R25`。

**问题与影响**：同一 CI 作业里用固定 `{pid:1, hostname:当前, createdAt:0, epoch:"unknown"}` 造锁，测试期望 runtime-control-owned，但 Windows 实际没有 throw。可确定的是跨平台测试/实现假设不一致；不能据此推出一定会抢占真实存活进程。

**最小核查场景**：查看 job `120814865166`、p01-p04.test.ts 与 ownership.ts；使用真实存活进程 fixture 区分测试假设与实现。

**固定 SHA 源码/CI 证据**：[`tests/unit/p01-p04.test.ts#L62-L70`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/tests/unit/p01-p04.test.ts#L62-L70)；[`src/execution/ownership.ts`](https://github.com/THEWOLFWALKER/FurEverCraft/blob/17cdf063cd8b97af8d7a8d7094116870e11fdd1e/src/execution/ownership.ts)；[`Windows CI job 120814865166`](https://github.com/THEWOLFWALKER/FurEverCraft/actions/runs/40074500831/job/120814865166)。

## 3. 原始问题编号 → 综合编号交叉索引

### 有源码证据问题报告（22 个编号）

`FEC-R01` → **FEC-01**；`FEC-R02` → **FEC-02**；`FEC-R03` → **FEC-03**；`FEC-R04` → **FEC-08**；`FEC-R05` → **FEC-10**。
`FEC-R06` → **FEC-09**；`FEC-R07` → **FEC-07**；`FEC-R08` → **FEC-11**；`FEC-R09` → **FEC-22**；`FEC-R10` → **FEC-23**。
`FEC-R11` → **FEC-24**；`FEC-R12` → **FEC-25**；`FEC-R13` → **FEC-26**；`FEC-R14` → **FEC-27**；`FEC-R15` → **FEC-39**。
`FEC-R16` → **FEC-40**；`FEC-R17` → **FEC-41**；`FEC-R18` → **FEC-42**；`FEC-R19` → **FEC-43**；`FEC-R20` → **FEC-44**。
`FEC-R21` → **FEC-46**；`FEC-R22` → **FEC-15/FEC-16*/FEC-19***。

### 外部独立审查（25项）（25 个编号）

`FC-R01` → **FEC-01**；`FC-R02` → **FEC-02**；`FC-R03` → **FEC-03**；`FC-R04` → **FEC-06**；`FC-R05` → **FEC-07**。
`FC-R06` → **FEC-08**；`FC-R07` → **FEC-09**；`FC-R08` → **FEC-10**；`FC-R09` → **FEC-39**；`FC-R10` → **FEC-42**。
`FC-R11` → **FEC-44**；`FC-R12` → **FEC-28**；`FC-R13` → **FEC-29**；`FC-R14` → **FEC-37**；`FC-R15` → **FEC-22**。
`FC-R16` → **FEC-31**；`FC-R17` → **FEC-32**；`FC-R18` → **FEC-33**；`FC-R19` → **FEC-34**；`FC-R20` → **FEC-35**。
`FC-R21` → **FEC-45**；`FC-R22` → **FEC-46**；`FC-R23` → **FEC-53**；`FC-R24` → **FEC-60**；`FC-R25` → **FEC-61**。

### 真实问题审查（28项）（28 个编号）

`P1-01` → **FEC-02**；`P1-02` → **FEC-01**；`P1-03` → **FEC-03**；`P1-04` → **FEC-04**；`P1-05` → **FEC-05**。
`P1-06` → **FEC-06**；`P1-07` → **FEC-08**；`P1-08` → **FEC-09**；`P1-09` → **FEC-12**；`P1-10` → **FEC-15**。
`P1-11` → **FEC-16**；`P1-12` → **FEC-39**；`P1-13` → **FEC-48**；`P1-14` → **FEC-49**；`P1-15` → **FEC-22**。
`P1-16` → **FEC-50**；`P1-17` → **FEC-46**；`P1-18` → **FEC-51**；`P2-19` → **FEC-29**；`P2-20` → **FEC-30**。
`P2-21` → **FEC-44**；`P2-22` → **FEC-14**；`P2-23` → **FEC-53**；`P2-24` → **FEC-54**；`P2-25` → **FEC-52**。
`P2-26` → **FEC-19**；`P2-27` → **FEC-36**；`P2-28` → **FEC-38**。

### 安全/信任边界专项（16项）（16 个编号）

`SEC-01` → **FEC-01/FEC-02/FEC-03**；`SEC-02` → **FEC-04/FEC-05**；`SEC-03` → **FEC-15**；`SEC-04` → **FEC-13**；`SEC-05` → **FEC-06**。
`SEC-06` → **FEC-46/FEC-47**；`SEC-07` → **FEC-57**；`SEC-08` → **FEC-29**；`SEC-09` → **FEC-55**；`SEC-10` → **FEC-56**。
`SEC-11` → **FEC-18**；`SEC-12` → **FEC-21**；`SEC-13` → **FEC-58**；`SEC-14` → **FEC-20**；`SEC-15` → **FEC-17**。
`SEC-16` → **FEC-59**。

索引中 `*` 表示原始编号下的**补充风险段落**（非新增原始编号）；一条原始编号映射多个综合编号，表示该原始条目合并叙述了多个可独立核查的行为分支。

## 4. 已知差异、保守处理与排除项

**原始严重度存在差异**：如压缩未压缩分支、压缩测试夹具、Observer 撤权、runtime.close 等，有报告列 P0 也有报告列 P1；本整理统一优先级并保存原文映射，**不宣称源报告等级完全一致**。SEC 报告使用高/中/低而非 P 等级，未进行机械换算。

**两个真正的 CI 失败是测试结果，不自动等于两个已证明的生产漏洞**：manifest 不一致已经观察到，但导致 hash/size 不同的换行原因仍只是候选；ownership lock 的固定 pid=1 测试在 Windows 未抛异常，但不能直接得出“真实活进程的锁可被夺走”。详见 FEC-60/61。

**两个待确认项单独标注**：FEC-17 的 `setHeldInputs` 是否应接受完整状态快照还是增量 patch，需要上游实际合同；FEC-21 的认证提示来源问题需要证明真实分类器/调用链可达。保留风险，不把有前提的设计担忧包装成已实证漏洞。

**同根因但是不同可观测后果不混同**：FEC-04/05、FEC-08/09/10/12、FEC-23/24/25、FEC-45/46/47/49/50、FEC-53/54 等存在关联，不能仅因为涉及同一模块就合成一条宽泛“可能不安全”；本报告按可独立触发、验证和结案的行为边界计项。

**没有额外捏造能力缺失型 Bug**：全部源报告都将正式 Minecraft Java 26.3 codec/data 尚未完整接线、真实原版客户端互通、真实 Windows SendInput、付费模型端到端测试未完成列为已披露边界；不在本 61 项内再次计数。源报告也没有证据证明默认回环+配对模式存在匿名公网 HTTP 接管，没有证明 trace:replay 会执行 OS 写输入。

**另有未计入 61 项的文档复现提示**：安全专项报告指出 `REVIEW_SCOPE.md` 中仍出现旧的 `review/furevercraft-p01-p23-2026-10-24` checkout 示例；仅按该旧命令切分支不能保证拿到本次 P24 Round 2 固定 SHA。该提示是报告复现导航注意事项，不作为新的运行时问题编号。

**审查独立性限制**：这些是多份审查材料的“汇编去重”，不是对所有文件逐行重新验证；源码行号和链接来自原始报告。在开发 Agent 修复/验收时，仍应在固定 SHA 上核实触发前提、随后对修复 commit 回归，不应把本综合报告的多个交叉引用当成额外运行证据。

## 5. 汇总结论

综合这四份不同审查（第五份为确实相同的文件），有效交付是 **61 项可追踪的唯一核查项**，而非简单拼接出 116 项。最核心的阻断优先级集中在**协议 framing、观测故障后的写动作撤权、IPC 丢控制消息，以及 Runtime 所有权在停机期间过早释放**。另有 Windows CI 两条红测提供真实自动化运行证据。所有问题都在上文保留原报告编号和固定提交源码链接，可以直接交由开发 Agent 按项处理、回查和验收。

---
*整理完成于 2026-10-24。原文仅作为来源，不包含修改项目的动作；未运行游戏、Windows 输入或外部 API。*
