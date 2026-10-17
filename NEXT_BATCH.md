# FurEverCraft v0.2：下一批完整实施计划

## 0. 最终要交付的行为

用户能启动一个simulated服务，在网页或CLI对同一个Agent发目标/消息，看到真实执行进展；Agent用生产模型serializer＋fixture transport做多轮工具决策，在局部可观察三维世界探索、采集、记录地点并返回。改向、取消、模型故障、外部改图、观察缺口与进程重建都走真实执行/持久化路径。

同时交付可运行的原始TCP Relay、26.3版本观察适配、分域失效与生产输入/生命周期接线代码；离线三角色socket和已具备来源的数据样本检验其边界。真实原版/Windows/API互通仍不宣称完成。

这是一批30项必做任务，不是30个独立迭代待用户选择。工程依赖按下表推进，可交错实施但不能跳过末尾项目。

| 顺序 | 任务 | 贯通结果 |
|---|---|---|
| 1 | F01–F06 | 旧执行/恢复/状态/provider合同补齐 |
| 2 | B01–B06 | 26.3 raw relay与旁路观察、身体适配基础 |
| 3 | U01–U04 | 同一Runtime的服务、CLI和网页 |
| 4 | M01–M05 | 三维状态、动作图、闭环Motor与独立模拟身体 |
| 5 | A01–A05 | 持续自主任务、组合技能、记忆与会话恢复 |
| 6 | V01–V04 | 集成、故障、长运行、文档及协同review |

F底座先完成；B与U中独立项可交错；M依赖中立接口，不必等真实环境证据；A依赖F/M。真实26.3数据无法补齐时，其解析能力如实降级，但不让它阻止其他实现。所有生产代码和模拟代码共用领域逻辑，能力档案分开。

### 固定证据状态，不许“有缺口就问用户选什么”

- exact上游获取失败：保留失败命令/原因，冻结对应adapter为unavailable，仍完成接口、Relay和其余实现；不随意改用master或其他版本。
- 字段/组件没有可靠格式：缺失codec必须fail closed，不按void继续消费；不能编造长度跳过，也不为看起来绿灯而删包。
- 缺独立黄金样本：完成有明确schema来源的离线测试，标schema-fixture；独立样本验证单列not-run，不能宣称真实兼容。
- 碰撞只有近似数据：允许明确标approximate做诊断，不进入可靠路径。模拟场景使用明确定义的测试形状，不冒充26.3原版形状。
- 无Windows/浏览器/Node22：按后文约定取得运行时或完成代码/可执行替代检查；实际没跑的分开列。无需索要API Key或真服务器。

不得把“无法确认真实兼容”写成“没有必要实现任何代码”。同样不得把“代码实现了”写成“真实环境验证通过”。

## 1. F：旧遗留与运行时底座

### F01 — 统一Runtime装配、Clock和控制所有权

createRuntime接受受校验profile和明确注入的Bridge/Store/Clock/Provider，返回唯一ControlService、Executor/InputArbiter、EventHub、Session、AgentLoop。Router不自行new另一套Executor；所有执行共享Clock，生产单调时钟＋真实调度，ManualClock只用于显式测试。

client-offline不得静默创建FakeBridge。该profile装配Relay IPC/真实能力适配；默认门禁关闭则清楚显示unavailable，而不是伪装simulated。simulated明确装配独立世界/身体。单实例锁防两个Runtime控制同DB/body，异常退出的锁可验证PID/进程代次后恢复，不删除活锁。

清理统一有界、幂等，尽力执行所有close/release步骤并汇总错误。没有创建成功的资源也不导致清理再次异常。Clock、Provider、Worker、Store和输入所有权均可注入测试。

### F02 — 执行结果、取消和工具准入纠正

必须消除src/execution/runtime.ts读取outcome后无条件改confirmed的路径。执行lifecycle、SkillResult、effect确定性、目标满足和因果归因分别保存。ambiguous/partial不会被finally或reconcile普通路径升级确认；取消不是回滚。

异步行为测试必须await并使用rejects，不能对Promise用同步toThrow；不把fake初始库存/固定sequence当真实事实。

每个运行实例有owner token、AbortSignal、lease和上下文；取消真实传播至技能/子技能/调度，不继续传isCanceled:()=>false。终态不可被普通cancel覆盖，旧watchdog/finalizer不能覆盖新owner。

同轮模型工具严格原始顺序准入，不再先并行读再写。逐个写动作在dispatch前检查goalRevision/decisionGeneration/context/Abort；模型请求前检查不够。长技能返回accepted/executionId，读取须显式查询完成状态，不能把accepted当succeeded。

wait_for_condition真实注册定时/事件谓词并等待，可取消，不能schedule空回调后立即成功。navigate成功基于实际位置/终态，不基于计划步数。所有工具严格schema、有限数值、unknown字段拒绝，读工具未知值也不得伪填。

### F03 — durable dispatch、回执与恢复

chat/place及后续dig共用同一副作用路径：事务intent/prepared→持久化may-have-dispatched屏障→最后准入复核→Bridge dispatch→receipt→verifying→confirmed/partial/ambiguous。屏障持久化失败不得发送。dispatch后即使取消仍保留调和任务。

统一receipt区分not_dispatched/accepted_for_delivery/injection_attempted/possibly_dispatched/outbound_intent_observed/effect_observed。accepted或SendInput计数不等于世界成功；出站包与command无法唯一关联则记录限制。去重pending/completed/unknown跨Runtime所需部分持久化；相同commandId不同payload拒绝，在途重复合并/拒绝。

SessionRuntime不再用旧connection/body相等作为历史调和前提。先按serverProfile/account/worldGeneration/dimension筛选，再新鲜证据核对；旧epoch仍严格禁止继续输入。目标格已被他人满足与动作因果确认分开，不凭blocked一项认定我放置成功。

prepared/dispatch屏障/外部应用/receipt/最终commit各窗口可注入故障。重新打开DB、新Runtime/租约，外部FakeWorld独立保留。模糊结果不自动重发、不删除pending，不阻断无关执行。

### F04 — Store、身份、事件与状态

使用SQLite迁移事务、外键、版本、CAS、scope查询/分页和effect状态守卫；确认态不被普通迟到upsert倒退，允许显式有证据的版本化纠错。测试旧schema升级/中断回滚，不换内存替代生产存储。

稳定scope固定serverProfileId/accountId/worldGenerationId/dimensionId；世界代次来自本地明确档案，不把localhost临时端口或每次connection作为世界身份。registryEpoch只属解释版本，不切割长期记忆。身份不明隔离旧数据，不猜测合并。

Session idle/starting/running/recoverable-failure/closing/closed；并发start/recover只有一个owner，失败清理后能重试，shutdown竞态不能复活资源。

WorldState输入先校验，读取时算TTL，sticky unknown需明确覆盖基线解除；新source full snapshot可从任意seq开始，缺基线delta不能算完整。状态通知不可变、订阅异常隔离。

EventHub live {bootEpoch,sequence}与durable eventId分开，kind过滤不制造gap，返回scannedCursor。订阅有界/可取消，慢消费者显式gap。关键目标/effect事务耐久，高频运动不逐tick fsync。

### F05 — 两家生产provider贯通

canonical history支持文本、图片引用、工具调用/结果、终止原因；OpenAI/Anthropic独立serializer，保留工具配对/错误和多轮历史。切换取消fence旧请求，从规范历史重建，不直接转发私有消息块；不可迁移内容记录lossy和摘要策略，不展示隐藏推理。

SSE持续UTF8 decoder、索引重组、完整结束验证、流中error/截断处理；半JSON不进执行层。限制SSE单record1MiB、整响应8MiB、单工具参数256KiB，超本地预算报limit错误不谎称供应商格式非法。图片fixture使用可解码synthetic PNG。

生产fetch实际发送前检查allowModelNetwork/配置；test transport显式标记且绝不退回真实fetch。无Key的生产选择返回未配置；API测试全部注入Fake/Record transport。

默认单个活动决策请求＋一个合并唤醒。每逻辑请求总期限60s，最多额外2次重试，指数基值500ms/上限8s并遵守Retry-After和总期限；每目标修订共享最多6次重试。工具已提交后不能通过重试模型回合重放写操作。原生fetch不叠SDK自动重试。

### F06 — 当前规则与报告纠偏

更新入口文件中旧1.20.4/765、无Web、禁止一切薄层自研的冲突；v0.2三设计为当前架构，历史文档标过期。把“基础修复已有”与“完全完成”分开。已有问题只做修改相邻合同review，不重新扫200项。

## 2. B：26.3原始Relay与旁路观察

### B01 — 版本档案与最小适配依赖

GameVersionProfile固定release26.3，登记protocol/dataVersion/Java需求/SDL3和来源。精确候选：

| 范围 | 固定引用 | 决策 |
|---|---|---|
| data #1301 | 924e26d6b3bb8f97a5d1e73d6190b09879c2e1e2 | schema/data候选，与前置内容核对，不只加版本号 |
| data #1300 | e4cbec4b17815d6ce8d8ba991dd3b2d9d8f4a57d | scaffold前置，不另当完整支持 |
| NMP #1538 | a1a33809c49553e544a7efd3d8bc03eb0867f4ab | entityDelta契约，interpret/compiled一致 |
| NMP #1532 | a3c018efbf1b8645f16427e7b4a8185ea4218ee2 | 版本前置；不重复叠加已含提交 |
| chunk #334 | 7382b4fef1c56290524665e7b9af58b7d1f34791 | 核对前置映射和global palette，不盲合多个PR |
| vecDelta测试 | f8f8a20a300e9bf3914580b8cea6573691c55036 | 仅参考向量，不并装第二线上codec |

这些是研究候选、不是已验证锁文件。获取固定源码、核对祖先和必要生成步骤，做一个隔离兼容adapter。npm minecraft-data消费物需data.js/版本索引/codegen齐全；仅把数据仓当npm包安装不算完成。所有生成产物可重复构建，保存exact refs/lock/integrity和许可来源。

复用NMP createDeserializer/ProtoDef；framing/compression内部路径只出现于adapter。若现有Transform无法满足有界性，固定自研薄VarInt/frame/zlib wrapper，使用Node zlib并测试边界，不重写全部codec/完整physics。上游release升级不是本批自由选择项，不改追踪master。

已知五项无codec组件进入显式unsupported清单，禁止沿用void假装消费。近似shape保留来源标记，不能verified。提供版本/数据诊断命令，能显示覆盖矩阵，不输出“26.3全部支持”。

### B02 — 真正的原始TCP Relay

实现独立Relay进程，Node net/stream监听127.0.0.1，固定目标映射，一个LOGIN身体绑定一个上游连接。STATUS是独立探测连接；不把ping当占用身体。双向直接socket原始字节，不创建高层NMP client/server，不通过writeRaw重封。

默认handshake不改。显式配置启用时仅改首次完整handshake的host/port，保留其他字段和后续所有字节；目标来自档案，不受客户端任意host重定向。默认handshake上限8KiB/期限5s，超限拒绝该会话，记录这是产品限额。

双向独立pause/resume/drain，应用在途字节计数；默认每方向高水位256KiB、低水位64KiB、硬上限4MiB、write-stall30s。达到硬限额受控关闭，不静默丢字节。错误、half-close、flush、双端shutdown幂等；关闭flush最长2s。

observer异常不修改主通路，默认保留转发并暂停自主控制。Relay crash断线；Runtime crash时Relay可继续，必须由独立本地Supervisor持有进程生命周期。不得声称同socket热恢复。

### B03 — 有界Observer与控制状态

Relay只做有界frame追踪/投递，重型解压、typed parse、chunk/NBT进Worker。双向各自维护byteOffset/frameSeq/phase/compression，registry解释版本和跨向因果状态单独记录。不能用单个inPlay/compressionEnabled布尔值。

初始限额：完整帧8MiB、解压32MiB、观察队列128frames且合计32MiB、解压并发2、单任务期限2s；压缩比超过256且展开超过1MiB视为观察预算拒绝。以上是可配置本地预算，不是MC官方最大值；超观察预算降级观察，原始转发仍按独立流控。

前置字节/framing/解压无法保留控制连续性时全局unknown，不能丢任意TCP chunk后继续猜同步。只有已解出ID/phase且确认非控制包，才允许按域跳过完整包；发domain gap。压缩后未知类别的队列超载不能假定关键包没丢。

实现LOGIN/CONFIG/PLAY/STATUS及热重配置跟踪；两方向压缩切换不按墙钟粗暴同步。没有可证明因果边界时有限挂起并标compression-ambiguous；schema可parse本身不足以认定唯一解释。不主动发送同步包解决歧义。

未知包不能排除控制作用时phase unknown；加密请求立即收缩能力，协商进入密文后停止明文framing。worker迟到结果fence；worker重启没有无缺口检查点/重放则不得恢复healthy。主通路不持久化原始游戏流。

### B04 — 领域投影与按依赖降级

实际实现以下adapter：本地姿态报告/服务端修正、health/food、聊天、inventory/window/cursor、实体spawn/move/remove、chunk load/unload/block/light、respawn/dimension、registry事件。按固定schema实现，未证实字段不填默认0。

每项带scope/context、source、frameSeq、observed/received时标、版本、完整性和证据引用。entityDelta相对轨迹与PositionPath绝对轨迹分开；missing relative delta使该实体轨迹unknown。entityId加spawnGeneration。

unknown item component不能包内盲跳；整包不提交，相关库存/窗口incomplete，下一frame仍可继续。chunk无法定位受影响坐标时扩大失效范围；light失败不自动抹掉独立完整的碰撞信息。全量恢复只解除其coverage覆盖的缺口。

CapabilityProvider动态计算，不因对象存在就ready；source fixture/simulated/client不可升格。完整新baseline后发布恢复，模型/技能执行时再次检查。实现domain coverage查询，网页和CLI看同一真值。

### B05 — Windows真实命令分支与异步Bridge

Bridge拆BodyReader/WorldReader/Capabilities/InputGateway，不暴露可写position、size、单个inventory数值、同步walk/place。真实Bridge适配Relay IPC＋Windows helper；模拟Bridge适配独立身体。生产技能不引用Fake类。

helper同一解析/绑定/期限/去重/held-set状态机，最后INativeSink分real/no-op。完整键盘＋鼠标集合替换；PID/进程开始时间/HWND/bindingEpoch精确核对，未知focus/窗口状态拒绝。

独立C# worker单调watchdog，stdin阻塞不阻塞期限检查；driver heartbeat成功后更新状态。pending/completed/unknown去重有界，helper重启control-uncertain，重新绑定前拒绝输入，不重放旧增量/文本。清理release/shutdown/transport.close分别尽力。

SDL3 physical/logical key与Win32 scan code分开建映射和calibration profile，未校准真实运动unverified。当前不执行真实输入/截图；Linux只能报告静态/平台无关测试，Windows若可用只跑no-op分支。

### B06 — IPC、Supervisor和CLI装配

Relay采用Node child_process IPC/版本化Zod消息；Observer用worker_threads。IPC只包含控制状态、脱敏观察/引用、能力与诊断，不向Runtime暴露任意socket write。hello/session epoch、requestId、timeout、背压和断连有明确语义，默认IPC请求期限5s。

本地Supervisor分别持有Runtime、Relay；Runtime退出不能让Relay误继承新的控制owner。helper心跳默认250ms，owner失联默认1s撤权/尽力release。Supervisor显式quit关闭全部；不自动重启游戏进程。进程重启最多3次/60s，超过暂停，避免坏循环。

CLI bridge --mode fixture执行独立两端peer＋本项目relay的真实socket场景；inspect只本地装配检查；live代码存在、门禁关闭默认拒绝，本轮不运行。测试peer不是Minecraft引擎。

## 3. U：CLI＋网页完整可操作控制台

### U01 — ControlService、服务模式和附着CLI

共享一个Runtime/ControlService，提供goal set/show、message、pause、resume、stop、cancel、chat、executions、effects、events、places、provider、save、status、doctor、quit/help。

pause停止新决策/准入并等稳定交接，显示pausing；resume用新鲜状态；stop撤销自主goal generation并尽力停身体；cancel指定execution及子执行；save是Runtime checkpoint不是保存游戏世界。

命令requestId＋payload hash幂等、expectedRevision CAS、明确accepted与terminal；所有写动作同Executor。人类控制消息和游戏聊天权限不同；未认证远端文本不能变内部命令。

`npm run serve -- --profile simulated`启动持久服务，默认127.0.0.1:3000；`npm run cli -- attach --url http://127.0.0.1:3000`操控同实例。保留standalone兼容但不能共享同body/DB。服务默认DB为用户配置数据目录，测试用临时目录；status/doctor读实际组件，不new一个空内存Runtime作答。

SIGINT/EOF/quit统一清理；attach EOF仅关闭CLI连接，不终止服务，明确shutdown命令才关闭Runtime。浏览器关闭/刷新也不改变Agent生命周期。

### U02 — Fastify API、SSE和本地配对

/api/v1提供status/capabilities、goals/tasks、executions/effects、places/memories、provider/config脱敏分页查询，POST /commands提交统一命令。共享Zod DTO；冲突409、未知/不允许字段400、无能力返回稳定code，不能用200伪装成功。

SSE /events快照＋一致cursor避免订阅竞态，gap触发重新拉查询快照。每连接最多256事件/1MiB，heartbeat15s，客户端不可保留无限history。事件只包含脱敏领域数据，不原样推provider/协议流。

默认loopback，同源生产静态托管，开发Vite proxy。初次一次性配对码交换HttpOnly/SameSite会话；不把token放URL，校验Host/Origin和写入CSRF token；无Origin的CLI使用本地配对取得独立bearer凭据，CLI认证方式不能绕过浏览器Origin检查。配对码单次、5分钟有效，不写日志/历史；终端受控展示。默认不配置公网/远程TLS。

### U03 — 实用React网页

React/TS/Vite，简单CSS和Canvas2D，无额外大型UI/3D框架。至少五个区：

1. 对话/控制：给Agent的自然语言消息、目标/暂停/继续/停止/取消；游戏聊天单独入口，清楚显示已接纳/处理中/结果未知/已完成。
2. 总览：会话/观察/身体/模型健康、当前目标与技能相位、等待原因、budget和恢复。
3. 任务/执行/effect：依赖列表、时间线、取消、证据摘要、ambiguous解释，不提供强制成功按钮。
4. 世界/记忆：姿态、维度、背包、地点/经历查询，选择高度层的已知局部顶视图；未知/历史/近似不同显示，不展示隐藏矿藏或fixture全图。
5. 设置/诊断：provider选择/切换、profile/能力限制、过滤事件、trace导出；秘密只configured，不提供明文Key读取/编辑。

自然语言消息实际进入ControlService/canonical conversation，不只是聊天气泡；展示Agent公开说明和工具摘要，不展示隐藏推理。UI处理空态、过期、断开、重连、拒绝；accepted不乐观变succeeded。按钮依能力禁用，后端仍校验。

前端最多10Hz批更新，列表分页/窗口化、地图局部增量。浏览器重连不重放离线写命令，先按requestId查询。synthetic capture明确来源，不做真实桌面采集或网页WASD遥控。

### U04 — CLI/Web同时操作与UI测试

实现readline持续输入与序列化事件输出；CLI和网页同时改目标应CAS冲突，不last-write-wins覆盖。相同requestId从两入口提交只执行一次。服务退出有界，客户端离开清理订阅不泄漏Runtime。

新增dev:web/build:web/test:web/test:web:e2e；测试React组件使用真实DTO和受控后端响应。Playwright E2E仅本地headless：配对→发目标→实际进展→改向→effect→刷新仍同Runtime→CLI attach取消→SSE重连。禁止截图，E2E操作网页不等于真实SendInput。

环境缺浏览器时先检查已有可执行文件；没有则代码和HTTP/组件测试仍完成，E2E留明确not-run。可安装普通依赖，不以浏览器缺失为由做静态假页面。

## 4. M：三维状态、规划与闭环Motor

### M01 — 稀疏三维投影和几何资格

连续Pose与BlockPos分开，y垂直，旧二维平面y→新z仅显式兼容层。稀疏chunk/section，状态ID按registry/data profile解释；未知区块/形状不当空气。

查询AABB、支撑、净空、触达面、危险/流体；shapeOrigin与validationProfile独立保存。原版数据可靠项可用，approximate不放进可靠路径。首批模拟用明确定义full cube/上下半砖；stairs/door/fence/water复杂行为没有资格就unsupported。

Motor近身内存一致视图，Skill局部前提，模型有限摘要；碰撞/可见/资源发现用途分开。区块已接收不等于玩家看见；模型和地图不得看到fixture未探索隐藏资源。

### M02 — 局部动作图与预算A*

ActionEdge关联primitive/version、入口/终点域、几何依赖、资源/风险、能力档案。固定首批walk、slab step、上升最多1格的短跳、下降最多1格的落步；不生成未知水/梯子/长跳/施工边。

swept-volume查整段、禁止对角穿角，跳跃用有限轨迹和净空/落点检查。默认每搜索20,000扩展上限、每256次让出；重型搜索用worker，旧快照返回复核相关依赖，不阻塞Motor。

结果固定COMPLETE/PARTIAL/NEEDS_OBSERVATION/BUDGET_EXHAUSTED/NO_PATH_IN_KNOWN_GRAPH/UNSUPPORTED_TRANSITION。partial终点必须可稳定，搜索预算耗尽不报永久不可达。动态障碍/地形只失效受影响段。

### M03 — 五原语闭环和输入期限

实现orient_to、walk_corridor、step_up、jump_short、controlled_drop。默认20Hz软实时，用观察位移/角度/支撑核对；相位包含检查/运行/核对/稳定/取消交接。跳跃接近→离地→空中→落地→稳定，撞头/未起跳/偏离分原因。

InputPlan含context、owner/lease、issue time/clock domain、maxAge、deadline、snapshot/观察年龄、held-set/有限增量。过期不重新封装延长；鼠标丢回执读新朝向，不补发历史增量。UI/focus/校准未知拒绝。

逻辑资源映射实际keyboard/pointer冲突，复合原子申请；地面正常改向停稳，空中有已验证恢复才接管。旧finally不能global clear新owner。无适用身体模式能力报control-lost/unsupported，不凭空保证松键安全。

### M04 — 独立VoxelFixtureWorld/SimulatedBody

世界独立持久/对象生命周期，不随Runtime重建清空。身体消费生产InputPlan，按版本化有限规则产生连续位置、yaw、碰撞、支撑、重力/短跳；不得沿规划path直接teleport或set目标位置。

fixture控制面可注入改图、输入drop、观察延迟/gap、server correction、掉落/库存变化，Agent只读受限局部观察。生产规划/技能只依中立Bridge，不拿场景答案。保留旧二维测试做兼容，明确不能证明原版物理。

### M05 — 进展与恢复控制器

区分观察没更新、观察新但无进展、相位等待、外部阻挡、控制通道异常；不能以到终点欧氏距离每帧下降判进展。共享failureSignature/budget，连续相同失败3次冷却30s；无新证据不换ID无限试。

局部纠偏→相关路段重规划→任务改选/暂停。observer局部失效只禁依赖动作，全局phase/framing失效撤自主身体控制；仅有独立新鲜证据和适配恢复器时允许有限稳定，否则control-lost。trace记录原因和接管owner。

## 5. A：自主任务、记忆与技能闭环

### A01 — GoalManager/TaskScheduler与事件驱动Agent

任务有依赖/优先级/revision/budget/checkpoint/完成谓词，状态proposed/ready/running/waiting/succeeded/failed/canceled。模型提案最多32节点，拒绝环、未知技能/无能力；Runtime授予执行权，模型不授租约。

唤醒固定目标变化、相关观察、技能结束、异常、有限idle timer；去重合并，不每tick调用模型。无模型时继续有效有限任务，到决策边界waiting-provider，不用隐藏全能硬编码Agent假装模型决策。

人类message/goal最高正常改向来源，游戏聊天参与合作但不获内部权限。checkpoint保存任务语义/证据，恢复重算动作，不还原旧按键或脚本栈。status能解释当前工作、等待对象和继续条件。

### A02 — 三类知识记忆实际工具

Knowledge为版本化JSON规则文件；Spatial/Episodic用现有SQLite扩展。真实实现query_knowledge/query_memory/remember_place，规则与经历不能同函数返回同一places数组凑数。

按稳定scope、类型、条件查询，默认最多20条/16KiB文本，分页；证据/时间/observed或inferred/再验证条件完整，冲突版本保留。关键完成/失败自动形成结构化经历摘要，无须额外模型调用。

地点、frontier、路线摘要带版本/验证时间；重连不分库失忆。按知识版本过滤再检索，失败按primitive/环境条件检索防重复。普通轨迹可归档，pending effect/关键恢复证据不被清理。

### A03 — 十一项技能与统一生命周期

补齐旧五项navigate_to/place_one/send_chat/observe_ui/wait_for_condition，并增加look_at、explore_area、dig_one、collect_nearby、gather_blocks、return_to_place六项。

- look_at走Motor并核验朝向。
- explore到可执行frontier→观察→记录，按半径/步数/期限停止，不读真值地图。
- dig检查站位/触达/目标/工具→瞄准→有限持续输入→释放→观察变化，接effect账本。
- collect据实体/背包核对，消失不单独等于拾取成功。
- gather分解已观察目标→导航→dig→collect→库存增量，外部抢先改变可换目标。
- return查询scope内地点，重验路线，失败明确，不传送。

生命周期validate/admit/run/verify/settled、子执行/cancel、资源/预算/能力统一。注册不可变version/schema/effect class/test profile，可配置禁用；未知版本fail closed。fixture只实现声明的普通方块/掉落规则，不宣称全MC合成/工具/掉落支持。真实profile无能力则拒绝，不能直接改真实世界投影制造成功。

### A04 — SessionSupervisor、认证与客户端生命周期

连接状态offline/connecting/observing/ready/disconnected/reconnecting/recovering/suspended；默认退避1/2/4/8/16/30s上限，连续8次暂停，人工resume开启新预算。只一个恢复owner。

disconnect撤lease、fence模型、保留effects；新身份/基线后恢复任务。死亡bodyEpoch变化，重新读取实际库存；即使keepInventory配置也不伪造保留数量。

Relay重连不等于原版客户端重新点进服务器。实现ClientLifecycleAdapter生产命令接线和fixture验证；真实菜单/截图能力未验证时unavailable，等待人工，不另起bot。当前不要求启动游戏验证。

AuthCoordinator用配置化allowlisted模板＋提示证据＋secretRef，不硬编码唯一/login字符串。模型可建议模板/引用，但看不到密码、不任意指定外发目标或命令。fixture至少两种提示/模板，认证结果来自后续流程证据，不以发送成功认定。未知流程进入waiting-configuration并说明缺项，不反复猜密码；这不是向用户开放技术选型题。

敏感输入refcount/token，结束后聊天历史仍可能有秘密；屏蔽capture与普通日志/history/trace敏感payload，不丢弃整个无关世界流。认证响应丢失保留ambiguous，attempt budget有界。

### A05 — 按需视觉、能力目录与有界长期运行

capture_view带用途/来源/帧时间/相关版本/敏感标记，真实capture未验证不启用；synthetic PNG走两个provider图片请求fixture，不截图真实桌面。不建设渲染重建。

工具目录随能力发布，旧调用执行时再核验。所有边界ModelProvider/ClientBridge/WorldReader/LocalPlanner/PrimitiveController/SkillRegistry/MemoryStore可替换，沿用现有有效目录结构，不为了命名重构全库。

默认上限：event ring1024、trace ring4096、普通history200条或256KiB、chat queue16、Task最多32活动节点、运行command去重4096条/24h（durable pending/unknown不因缓存TTL删除）。history裁剪保留工具配对并保留目标/未决effect引用；旧归档可分页查询。单个饱和对象有明确拒绝/合并/归档策略，禁止无限数组。

## 6. V：综合验证、长运行和交付

### V01 — 十四个贯通场景

每场景使用真实RuntimeFactory/ControlService/Router/Executor/Store，只注入时钟/模型传输/身体/外部世界。不能直接save succeeded或打印预置成功字段。

| 场景 | 必须出现的证据 |
|---|---|
| S01 网页＋CLI改向 | 尚未完成的运动中换目标，旧响应不能写，新目标实际推进 |
| S02 三维净空/绕障 | swept collision拒绝穿角/撞头，逐周期输入产生位置变化 |
| S03 外部堵路 | 相关route失效并绕行/解释无已知路，预算有界 |
| S04 探索与地点 | 局部观察发现frontier/地点，重启后检索和重验返回 |
| S05 采集组合 | observe→navigate→dig→collect→库存谓词，别人先挖也能处理 |
| S06 ambiguous保留 | 技能ambiguous不被Executor/Router改confirmed，依赖受限 |
| S07 dispatch崩溃 | place/chat/dig应用后丢receipt，重建不盲重发 |
| S08 跨会话scope | 同世界新epoch可核对，异账号/世界/维度不误确认，旧输入被拒 |
| S09 provider故障 | 429/截断/取消/切换，多轮实际请求合法且无重复写 |
| S10 真socket Relay | 三角色字节相等，拆包/合包、半关闭、背压、握手唯一改写 |
| S11 Observer失效 | worker异常/队列超限不改转发字节，domain/global失效正确 |
| S12 26.3领域 | entityDelta/PositionPath区分、void组件拒绝、chunk/light可用范围与来源明确 |
| S13 认证/生命周期 | 两类fixture模板、重连新epoch、secret不落日志、真实菜单不可用诚实显示 |
| S14 UI/进程重建 | 刷新不重启Agent，CLI看同execution，服务崩溃恢复且Relay边界清楚 |

T1传输、T2 framing/control、T3领域、T4真实原版证据分别报告。T4本轮不运行。S09/S01至少有生产provider serializer＋录制transport路径，不能全靠ScriptedProvider证明两家API集成。

T2用明确格式的frame/压缩fixture测试边界和歧义，schema测试标schema来源。T3优先使用研究提供vecDelta对照向量，记录它是上游作者来源，不称本团队抓包；缺独立PositionPath/chunk/config样本则not-run oracle检查，但实现/故障合同测试继续。

### V02 — 崩溃、写失败与低资源长运行

实际Store写入/commit边界注入失败；覆盖CAS冲突、过期checkpoint、旧finalizer、start失败重试、shutdown竞态。数据库独立临时目录并清理，不固定/tmp文件串测试。外部世界跨Runtime保留。

固定seed虚拟时间60分钟，至少50次任务转换、10次fixture连接中断/恢复、5次Runtime/Store重建。数值来自事件计数；不要求物理真实世界时间。检查队列/历史上限、租约/监听器/计时器/worker和pending promise清理，合理pending effects仍保留。

短真实调度smoke默认30s，不访问外网；记录事件循环延迟、RSS和队列峰值，不设机器相关虚假性能保证。默认测试单worker、虚拟时钟、不忙等或长sleep；失败先核对测试前提，不能弱化/跳过必做行为制造绿色。

### V03 — trace、回放与操作指南

有界JSONL trace包含scope/context及goal/execution/primitive/effect/command ID、证据引用、阶段/能力/错误和恢复关联。敏感值脱敏，原始协议默认不录。CLI trace export/replay，仅诊断回放，无输入/游戏外发；gap明确影响哪些视图。

提供真正可执行的统一命令：

```
npm run typecheck
npm run build
npm run build:web
npm run test:offline
npm run test:integration:offline
npm run test:soak:offline
npm run test:web
npm run test:web:e2e
npm run demo:offline
npm run demo:autonomy -- --scenario gather-return
npm run doctor -- --profile simulated
npm run bridge:fixture
npm run cli -- bridge --mode inspect --config configs/client-offline.example.json
npm run serve -- --profile simulated
npm run cli -- attach --url http://127.0.0.1:3000
```

serve/attach作为持续运行入口不要求最终验证永不退出，使用受控子进程脚本验证后shutdown。demo必须实际走共享应用路径，旧CLI默认demo行为可兼容，但README主入口改serve。

### V04 — Node22 CI、协同review与准确交付

目标Node22。优先使用已有Node22，缺少时允许安装该开发运行时；若网络/环境阻止，记录实际版本，仍完成CI配置和其他任务。不得把Node20结果称满足minecraft-protocol的>=22要求。CI不访问游戏/API，Node依赖安装与本地夹具是允许项；浏览器E2E单独job，Windows helper no-op可用则独立job，没实际运行的云端job不能写通过。

最终只更新已有PROGRESS/DELIVERY_REPORT/PLANNING_AGENT_HANDOFF和必要README，不新建重复文档集。每个F/B/U/M/A/V编号记录：implemented-offline / implemented-unverified / blocked / not-implemented，具体主要文件、实际测试名/命令和限制。实现状态与验证状态两列，不能有测试没实现或有实现冒充真环境通过。

报告必须单列：

- 哪些旧遗留真正解决，哪些仍未解决及根因。
- 支持矩阵simulated/protocol-fixture/Windows-no-op/真实client，代码存在、测试运行、能力启用分开。
- exact依赖与生成方式、原版样本来源/缺口、Node22与Windows实际证据。
- 本地HEAD、提交列表、review反馈及最终复验；不默认推送。

本批review只集中修改的契约和交界，不再全仓200项审计。先交完整可审阅工作，再处理用户review；不要提前以“剩下未来补”结束本批核心范围。

## 7. 明确暂不实现，避免范围漂移

本批不实现26.4快照/多历史协议、正版认证/加密MITM、双端终止代理、额外bot、服务端权限、客户端Mod/注入、完整战斗/合成科技树/建造/搭桥/水中攀爬、训练、自动生成代码执行、向量数据库、公网多用户部署。数据缺失不靠视觉重建、未知形状默认空气或模拟传送绕过。

这不缩减F/B/U/M/A/V既定30项；完整实现其中可实现代码、完成离线证据，并诚实保留确实需要外部数据/环境的验证边界。
