# FurEverCraft：顶层设计

版本 v0.2 · 2026-10-17 · L1：系统责任与技术决策

下位合同：[L2 客户端桥与核心合同](minecraft-agent-client-bridge-contracts-v0.2.md)；[L3 运动、导航与恢复](minecraft-agent-motion-navigation-recovery-v0.2.md)。本组三份文档取代 v0.1 的当前设计地位；旧版保留为历史。架构决策已确定，不代表实现或真实环境验证已经完成。

## 1. 产品目标与固定边界

建设一个长期自主活动的普通 Minecraft 玩家：能观察、规划、执行、交流、记忆、失败恢复，并接受操作员消息调整方向。真实原版 Java 客户端是唯一身体，Agent 不另建一个协议 bot 玩家。

当前游戏目标固定 **Java Edition 26.3**；26.4 快照和其他历史版本不在本基线。后续正式版升级走显式适配与回归，不启动时安装 latest、不静默退回 1.20.4。用户研究登记 protocol777、DataVersion5023、游戏 Java25、SDL3；这些数值与运行要求保留来源证据等级，实施时由锁定版本档案校准。Agent 目标环境 Node22，与游戏 JVM 要求独立。

固定约束：

- 普通玩家权限，无客户端 Mod、Java Agent/注入、内存读取、服务端组件、管理员遥测或第二玩家辅助观察。
- 原版玩法多人服务器；本期 offline-mode 身份，支持服务器内注册/登录。正版认证留后续独立设计。
- Windows10/11 作为真实身体输入平台，Node Runtime 跨平台。原版客户端通过本地代理连接预配置目标；正式使用前仍需环境兼容验证。
- OpenAI Chat Completions 与 Anthropic Messages；通用多模态模型使用工具，确定性本地控制为基础，不依赖训练控制模型。
- 结构化优先、真实画面按需；不建设视觉重建主链路，不要求每动作截图。
- CLI＋网页控制台，前后端分离，共享同一个 Runtime。操作员默认通过消息和目标介入，不逐帧遥控。
- 允许死亡，已知目标服 keepInventory 开启；重生仍重新观察库存，不按配置制造事实。
- 动态生成执行代码仅预留隔离能力边界，本期不开放。

本轮为设计修订，无源码开发。当前授权验证范围仍是离线 fixture，无真实服务器/世界、游戏服务端、资产下载、付费 API、真实桌面输入/截图。目标架构可以描述未来真实运行，不能将其写成已取得的测试结果。

## 2. 决策依据与源码起点

依据：原研究交接与六项专项研究；26.3 版本调查；接口第三轮核实；最新《26.3 接入路线与最小复用栈定案研究》；main@2cd72cec945298bc86d5be5df9b66493ce066c6f 的源码初读。

源码初读只覆盖关键入口、桥、执行/恢复、相关测试与 lockfile，没有运行测试或审计全仓。观察到的现状：

| 范围 | 已有基础 | 尚未贯通 |
|---|---|---|
| 工程 | TS strict/ESM、SQLite、工具路由、provider adapter | 生产装配、共享时钟与控制权 |
| 身体 | FakeBridge、Windows driver/helper、Composite 外形 | 三维异步合同及真实输入验证 |
| 协议 | 1.20.4 编解码与内存分片 fixture | TCP 转发、压缩/阶段跟踪、26.3 领域观察 |
| 执行/恢复 | 记录、租约、副作用表、恢复入口 | ambiguous 保留、发送边界、跨 epoch 历史核对 |
| 交互 | commander/demo | 持续 CLI、网页、共享服务 |

因此本次是在给尚未落地的生产接入选型，不是拆除一套已投入使用的终止代理。不从“42 tests passed”推导上述链路完成。

## 3. 身体接入定案

### 3.1 主路线 A：原始转发＋旁路观察

```text
真实客户端 ←══ 原始 TCP 转发 ══→ 26.3 目标服务器
    ↑                 │ 只读、有界副本
系统输入              ↓
    ↑           帧/压缩/阶段跟踪 → 领域观察 → World State
输入网关 ← Motor ← Executor ← Skill/Local Planner
                           ↑
                   Goal/Agent 工具循环
```

两条 TCP socket 组成同一玩家的应用层会话通道，不在两侧另建协议身份。客户端和目标服务器继续拥有 login/session、配置协商、客户端设置、keepalive、传送确认和聊天协议。旁路不自动回包、不代替玩家同意规则或资源包。

原始转发默认不改应用字节。仅用户配置要求的初始 handshake host/port 映射允许一次受限改写；目标地址来自配置，不从客户端任意 host 字段选取。其余流量不解码重编码后转发。

offline-mode 不是绝不加密的证明。观察到加密协商即收缩自主能力；进入不可观察加密流后最多保留纯转发和人工使用，不 MITM、不悄悄改成视觉主控。

### 3.2 不选本期路线 B

双端终止代理要重新承担身份、sessionId、registry、配置和自动回包所有权，当前收益不匹配维护成本。NMP createServer/createClient 的高层默认行为不用于主通路。需要主动改写游戏包或跨协议转换时，另起设计评审，不把旁路逐渐扩成隐藏终止代理。

### 3.3 三个相互独立的状态

| 状态 | 问题 | 不可推出 |
|---|---|---|
| TransportHealth | 字节是否按序到达，缓冲是否有界 | 观察正确、已进入世界 |
| ObservationCoverage | 哪些领域有有效基线、连续增量和可信解释 | 输入能被客户端消费 |
| ActionReadiness | 当前动作所需证据、能力、焦点、租约是否满足 | 游戏已经产生效果 |

连接可以继续而观察降级。只限制依赖失效领域的动作；framing/phase/加密等全局失效则撤销依赖结构化身体状态的自主控制。禁止一个 enabled 布尔值代表整个系统可用。

## 4. 责任层与所有权

| 模块 | 唯一责任 | 不得拥有 |
|---|---|---|
| TransportRelay | socket pair、字节顺序、背压、受限握手映射 | 玩家协议身份、游戏动作决策 |
| ProtocolObserver | 双向 framing/compression/phase、版本化解析 | 主通路写回、自动协议答复 |
| ProjectionManager | 校验观察、领域投影、有效性与缺口 | 模型推测冒充观察 |
| GoalManager/AgentLoop | 目标、承诺、证据查询、工具提案 | 租约授予、OS/socket 原始写入 |
| Executor/Skill | 准入、生命周期、组合、结果与恢复协调 | 绕过输入网关 |
| LocalPlanner/Motor | 可执行动作图、本地阶段控制与进展 | 全局目标事实、同步模型/数据库调用 |
| InputGateway | 身体绑定、租约、时效、实际输入与释放 | 宣称游戏效果已确认 |
| EffectReconciler | 持久意图、回执、证据核对 | 将 unknown 改成功以解除阻塞 |
| Memory/Knowledge | 历史、规则、索引与技能资产 | 当前 WorldState 写权 |
| ControlService | CLI/网页共用的操作员命令合同 | 第二套执行器/世界事实 |

核心领域只看版本化接口，不持有 NMP/Win32/provider 私有类型。第三方兼容薄层封在 adapter 内。

## 5. 复用、自研与版本资产

优先复用 Node net/stream、NMP 低层 framing/compression/serializer、ProtoDef、minecraft-data、chunk/block 模型。允许自行实现小型有界 framing adapter、连接协调器和领域投影；不为复用强行加载高层登录插件，也不从头重写完整协议生态。

研究选定候选 schema/native 契约为 minecraft-data #1301＋NMP #1538 的 **entityDelta**。#1539 vecDelta 不并装，可借其测试向量作跨实现参考。PositionPath 是独立绝对轨迹类型。chunk #334 为候选，不把 PR 存在当成完整可用依赖组合。

版本档案至少含 release、protocol/dataVersion、运行需求、库 exact refs、schema/native codec 配对、数据生成方式、registry/shape 来源和验证范围。固定提交清单见 L2。研究给出的固定 SHA 是候选来源，不是本项目测试通过证明。

隔离补丁必须记录来源/许可、差异、生成索引、撤补条件。内部库 API 只允许在一个适配层引用；升级时测适配层，不能让内部路径扩散到技能。

## 6. 进程与调度边界

固定采用模块化单仓库，有限隔离：

1. Runtime 服务进程：ControlService、HTTP/CLI attach、AgentLoop、Store、Executor、内存状态与轻量 Motor。
2. Relay 进程：独立 socket 生命周期与有界帧追踪；重型解压/语义解析放有界 Observer Worker，不在转发回调同步执行。
3. Windows helper 进程：串行输入状态机、native sink、独立 deadline watchdog。

本地监督器负责启动/关闭，不因模块数拆微服务。Relay 与 Runtime 分开启动和监督，Runtime 异常时 Relay 可按配置保持纯转发；代理本身崩溃仍会断线，不承诺无损热恢复。Helper 失去 owner 心跳应尽力释放并进入 uncertain；进程/OS 冻结不保证立即释放。

Motor 默认软实时20Hz，避免重型搜索、JSON/chunk 解析阻塞；LocalPlanner 搜索分批或进入 worker。模型不参与每 tick 按键；模型停顿只影响决策边界，不阻止停止控制。所有队列、任务、缓存、history 与归档有界。

## 7. CLI＋网页控制台

React/TypeScript/Vite 前端；Fastify HTTP＋SSE 后端；CLI 和 HTTP adapter 调用同一 ControlService。前后端代码与 API 合同分离，生产可由后端托管静态文件，无需额外常驻前端服务。

服务拥有 Runtime；浏览器刷新/断开不改变执行。CLI attach 连同一服务；兼容 standalone 模式明确是独立实例，同 DB/body 资源不能被双实例同时控制。

网页提供对 Agent 的消息、目标与控制、任务/执行/effect、当前状态与来源、背包/地点/记忆、局部已知地图、能力/诊断。发给 Agent 与发送游戏聊天分开；不展示隐藏思维链。地图仅是用途过滤的投影，不是游戏画面重建。

命令有 requestId、expectedRevision、accepted/terminal 区别；并发操作做 CAS/去重。SSE 快照＋cursor 防接入缺口，gap 后刷新完整查询视图。初期 loopback-only，同源会话、配对认证与写入保护；不默认绑定公网。详见 L2。

## 8. World State、信息使用与记忆

当前状态由 ProjectionManager 写入；字段保存来源、版本、时间、作用域、完整性、未知原因和证据引用。client_reported、server_observed、predicted、inferred、historical 不混用。运动上报不是服务器每帧确认。

Motor 读取近身一致内存视图；Skill 读取前提、局部路线、库存与效果；模型读取有限摘要和按需查询。原始 chunk/包不直接进模型。附近碰撞辅助不等于资源发现权限；不得把未见隐藏矿藏通过地图、工具或历史摘要泄露给决策。

稳定数据作用域为 serverProfile/account/worldGeneration/dimension；connection/body/registry epoch 是运行时证据版本，不是长期记忆分库键。无法从普通协议证明服务器未换档，worldGeneration 由明确本地档案管理，身份不明时隔离，不猜测合并。

Knowledge 保存游戏/服务器规则和来源版本；Spatial 保存地点、路线、frontier 与再验证条件；Episodic 保存经过、失败与证据；SkillAsset 保存不可变方法版本和验证档案。SQLite 事务元数据＋有界热状态＋可归档 blob，索引可重建；首期不依赖向量服务。

近似碰撞 shape 与未知 item component 是数据质量缺口，不能通过模型推理自动晋升为 verified。shape 资格按状态/上下文/证据记录，不要求盲目相信整个上游包。

## 9. 模型、任务与技能生命周期

两个 provider 从 canonical history 独立序列化；保留工具 ID 和完整配对。切换可能有不可迁移信息，明确映射/损失，不声称所有私有内容可无损迁移。流式工具完整终止并校验后才提交。

任务有依赖、预算、目标 revision 和 checkpoint。默认一次只运行一个模型决策请求，唤醒合并；模型重试与副作用重试独立，服从共享期限/预算。工具按原始顺序准入，第一版不做读写重排；长技能返回 executionId，事件触发复核。

Skill＝参数/版本＋前提/资源/能力＋进展/终止/取消＋effect/恢复合同。固定生命周期 queued/running/stopping/verifying/suspended/terminal；执行状态、技能结果确定性、目标满足、因果归因分开。成功不来自“输入调用返回”。

未来替换模型、规划器、原语实现必须经过相同合同；可替换不等于版本和能力无限互通。生成代码未来只能用能力接口，无原始 socket、OS、密钥和核心状态写权。

## 10. 运动、效果与恢复

局部规划产生控制器真正支持的动作边；复杂地形逐项验证，不把二维寻路升级宣传成三维物理。控制器用阶段、进展、终态证据和模式特定交接；详见 L3。

离散副作用先持久 intent 与 dispatch 屏障，再输入；回执分 local accepted、injection attempted、outbound intent、observed state 与 attribution。没有与世界原子提交的事务，不承诺 exactly-once。ambiguous 保留；无法证明未发送就不盲重试。

历史 effect 以稳定 scope 筛选，新会话新鲜证据核对；原 dispatch epochs 只记录来源并防旧控制，不能要求等于当前 epoch。恢复目标与检查点，重新取得租约，不复活旧输入队列。

断线、死亡、维度/registry 变化和 Observer 降级分别处理。优先局部恢复；同签名失败有预算/冷却，模型和父技能不能各自重置重试次数。认证凭据用 secretRef，仅受控执行器解析；服务端提示只作证据，不作为内部授权。

## 11. 验证层级与推进门槛

| 层级 | 证明什么 | 未证明什么 |
|---|---|---|
| T1 | 两向原始字节序列、背压、关闭与唯一握手改写 | Minecraft 包语义正确 |
| T2 | frame/压缩/双向控制状态与错误隔离 | 完整世界领域解释 |
| T3 | 固定来源样本的领域映射、epoch、失效与恢复 | 原版真实互通和真实输入 |
| T4 | 未来受控原版互通、输入和观察闭环 | 所有服务器/地形稳定 |

另设执行与数据合同测试：ambiguity、CAS、崩溃窗口、旧 callback、身份隔离；UI 测试通过真实 ControlService；模拟运动用独立身体模型，不能直接把位置赋成目标。

当前只允许离线 T1–T3 和模拟/UI/provider fixture。已有真实环境禁令不被此设计解除。外部 oracle 的强度单列：不同 PR 的作者样本可有价值，但不是本团队抓包或官方权威数据。

推进顺序：先修现有执行/时钟/桥合同→建立26.3可复现观察适配→完成T1/T2和必需领域T3→启用相应模拟/未来真实能力。控制台、provider和记忆的独立工作可同步推进。高级技能扩展不得掩盖身体证据缺口。

## 12. 待补证据与设计不变量

剩余工程证据：固定源码组合构建产物/依赖图/Node22结果；CONFIG与热重配置样本；未知物品组件、PositionPath、chunk/light 独立向量；碰撞真实性。剩余真实环境证据：握手hostname、加密分支、原版互通、SDL3输入与焦点/界面映射。它们影响能力开放，不阻塞当前路线选择；不要求再做泛泛研究。

必须始终成立：

1. 同一个真实玩家；代理不生成第二身份、不注入游戏动作或自动答复。
2. 转发字节和观察解析分离；解析失败不能把转发成功升级为观察可信。
3. 旧 connection/body/control generation 不再写输入；旧 registry 投影不继续解释新状态。
4. 观察、推测、历史、近似和未知严格区分；无可靠基线不做完整状态承诺。
5. ambiguous 不被普通终态覆盖；取消不代表回滚，目标满足不代表本次动作导致。
6. 工具/CLI/网页共用执行协调器和控制权，不能形成多个身体写入者。
7. 恢复历史效果允许跨旧会话，恢复控制权必须新建。
8. 首选复用，必要薄层自研，依赖和验证范围都可追溯。
