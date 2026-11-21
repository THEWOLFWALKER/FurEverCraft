# FurEverCraft：客户端桥与核心合同

版本 v0.2 · 2026-10-17 · L2：接入、状态、执行与控制接口

上位：[L1 顶层设计](minecraft-agent-top-level-design-v0.2.md)。下位：[L3 运动、导航与恢复](minecraft-agent-motion-navigation-recovery-v0.2.md)。本文件类型为领域合同示意，不是依赖库可直接调用的 API；确切 packet 字段以固定26.3适配数据和测试为准。

## 1. 会话、版本与身份

```ts
interface StableScope {
  serverProfileId: string;
  accountId: string;
  worldGenerationId: string;
  dimensionId: string;
}
interface RuntimeContext {
  scope: StableScope | null;
  identityStatus: 'unresolved' | 'provisional' | 'resolved';
  connectionEpoch: string;
  bodyEpoch: string;
  registryEpoch: string;
  controlGeneration: string;
}
interface GameVersionProfile {
  edition: 'java'; release: '26.3';
  protocolVersion: number; dataVersion: number;
  gameJavaRequirement: string;
  inputBackend: 'SDL3';
  adapterVersion: string;
  dependencyManifestRef: string;
  dataManifestRef: string;
  validationProfileRefs: string[];
}
```

26.3目标确定；777/5023/Java25/SDL3按照用户报告登记，档案记录具体来源与验证状态。配置不能用改字符串冒充实现支持。未知/不匹配版本拒绝自主接入；如显式保留手动隧道，标 unsupported-observation。

配置包含目标 host/port、serverProfile/account、世界代次、本地监听、可选 handshake 映射、限额与四个独立权限开关 allowMinecraftUpstream/allowModelNetwork/allowOsInput/allowScreenCapture。默认关闭危险外部能力；loopback fixture 通过注入式测试授权，不允许假 transport 回退真实目标。

STATUS探测和LOGIN可为不同连接，各自 connectionEpoch，不将服务器列表 ping 当身体会话；同一控制实例最多绑定一个活动LOGIN身体。维度切换不是新TCP连接；死亡产生新bodyEpoch；registryEpoch按实际配置变化管理，不把所有维度切换机械等同 registry变更。

## 2. TransportRelay 合同

### 2.1 写权限与字节等价

TransportRelay只接受配置目标、真实客户端socket和受限控制面。ProtocolObserver、模型、技能、HTTP均无应用字节写接口。

默认每方向目标收到的串联字节与源串联字节相等，不要求TCP分片边界相同。只允许配置启用的首次handshake host/port改写：完整读该帧、校验目标版本/nextState/长度、仅替换指定字段、重算该帧长度；后续余字节一次且按序转发。STATUS与LOGIN分别适用各自首次握手。改写失败按配置拒绝会话，不能错误拼接后续流。

服务器看到的是代理socket源地址，不承诺IP透明。不发送PROXY/Velocity/Bungee身份头，不改UUID/username/sessionId，不代答keepalive或配置同意。服务器要求transfer/另目标连接时进入显式不支持/需配置，不自动连接任意新地址。

### 2.2 背压与关闭

主通路只做有界socket读写、流控和小型元数据追踪；write=false时暂停相应源，drain恢复。两向独立维护队列、水位、deadline，另一向不被无理由阻塞。记录应用队列、socket writableLength及可见缓冲；不能仅测一层就声称总内存有界。

关闭合同区分EOF/half-close/error/timeout：已收到的在途字节在有界期限内flush，之后对应end；两向结束或错误执行一次幂等close并报告未送达范围。致命缓冲/连接异常允许关闭，不静默丢游戏字节保持“成功”。Observer异常通常不关闭转发，由能力门禁处理；可显式配置需要观察时主动断开，默认保留转发并暂停自主控制，不自动循环重连。

## 3. 旁路观察管线

```text
有界 TCP 源副本/引用
 → 每方向增量 frame boundary tracker
 → 有界完整 frame 队列
 → 异步解压＋关键控制状态处理（有序）
 → packetId/phase 分类
 → 有界领域工作队列
 → 领域归一化与失效事件
```

四类buffer不可混淆：TCP chunk；含外层长度的frame；去掉外层长度的frameBody；解压后的packetId＋payload。NMP writeRaw不是TCP转发接口；主通路不使用它。

帧追踪不在接收回调执行同步zlib/NBT/chunk解析。不无界复制Buffer，不允许work item引用一个永不释放的大buffer。所有累积字节、帧/解压上限、并发、期限和压缩比策略属于版本化预算配置；有限但合法的大包若超本地观察预算，只降级观察，不能声称协议本身非法。

压缩开启后先解压才可能知道包类别，因此**不能无条件保证过载时总能保留关键控制包**。前置队列或解压预算超限，若不能证明控制连续性，整个Observer变unknown；不能随机丢帧后继续PLAY解析。只有完成分类且确认不影响控制的完整包，才可按领域策略舍弃并发布domain gap。

Observer Worker提交的结果携带connection/registry/frame序号；即便并行解析，投影提交仍按领域依赖有序。旧worker迟到结果不得写入新会话。worker重启若没有完整有界检查点和无缺口重放，不能继承healthy；一般等待新连接或明确可证明的领域重同步。

## 4. 双向阶段、压缩与协议所有权

状态按connectionEpoch＋direction管理，记录byteOffset/frameSequence/phase/compression/关键控制完整性。TCP只保证同方向顺序，不提供两方向总序。

| 控制语义 | 消息owner | Observer责任 |
|---|---|---|
| handshake/STATUS | 真客户端/真服务器 | 观察nextState；可选受限host映射；STATUS正常关闭 |
| login start/success/session | 真客户端/真服务器 | 关联身份事实，不创建本地success或profile |
| compression通知 | 真服务器 | 识别精确生效边界，每方向状态与因果关系 |
| login ack/config/known packs/settings | 真实双方 | 记录实际选择与阶段，不自动代答 |
| registry/config结束及确认 | 真实双方 | 双向阶段跟踪，建立registry epoch与有效基线 |
| PLAY→CONFIG→PLAY | 真实双方 | 热重配置invalidate→重建，不复用旧registry |
| keepalive/teleport确认/chat | 真实双方 | 记录意图与响应，不自行补包 |
| encryption协商 | 真实双方 | 立即收缩能力；后续密文转发但不可解释 |

表内是语义名，不作为client.write的字面包名。26.3 sessionId/post_effects/teleport字段变更按固定schema校准，禁止填默认0完成构造。

**压缩边界：**S→C通知后的同向帧可按已知规则切换；C→S可能存在客户端尚未收到通知时已发出的在途旧格式帧。不能凭代理接收墙钟先后设置一个共享布尔值。实现需有可证明的26.3因果锚点和协议约束；允许有限缓存候选解释供诊断，但“某解释能parse”不是唯一证明。歧义无法消解时不提交权威事件，不自动替客户端发送同步包；降级或新会话恢复。

**加密边界：**发现请求先暂停受影响自主准入，协商后加密时连明文frame length都不可继续假定。不要把密文当坏VarInt去扫描。

## 5. 故障范围与重新同步

| 故障 | 转发 | 观察失效范围 | 恢复依据 |
|---|---|---|---|
| 单个已知非控制包typed parse失败 | 原样继续 | 对应领域及依赖 | 同领域权威全量或可证明完整增量 |
| unknown item component/void codec | 原样继续 | 当前包涉及的库存/窗口；范围不明则库存全域 | 新完整内容包且可解码 |
| chunk/light完整帧解析失败 | 原样继续 | 可定位区块；定位也不可信则扩至相关维度投影 | 完整区块/必要light基线 |
| 领域队列舍弃已分类完整包 | 原样继续 | 被舍弃域 | 带边界的重新同步 |
| 不能确定未知包是否控制 | 原样继续 | phase依赖的全域 | 可靠控制锚点，否则重连 |
| byte gap/畸形frame/前置队列溢出 | 原样继续或策略关闭 | 全局framing/control unknown | 通常新连接，禁止扫描字节猜边界 |
| 控制帧丢失/压缩歧义 | 原样继续 | 全局或关联方向全域 | 可证明因果锚点，否则新连接 |
| 加密/代理进程崩溃 | 密文可转发/崩溃断线 | 全域 | 新可观察会话 |

重新收到一个普通增量不抹掉sticky unknown。局部完整快照只恢复其覆盖域；不存在“刷新全部服务器状态”的万能工具。

## 6. 三维身体与观察合同

```ts
type Vec3 = { x: number; y: number; z: number }; // y垂直，世界坐标
interface Pose { position: Vec3; yawDeg: number; pitchDeg: number }
interface EvidenceStamp {
  sourceId: string; sourceEpoch: string; sequence: string;
  receivedMonoNs: string; clockDomain: string;
  capturedMonoNs?: string; capturedWallTime?: string;
  byteRange?: [string, string]; frameSequence?: string;
  timingUncertaintyMs?: number;
}
type Field<T> =
 | { status: 'available'; value: T;
     kind: 'server_observed'|'client_reported'|'predicted'|'inferred'|'historical';
     evidenceRefs: string[]; revision: string; stamp: EvidenceStamp;
     permittedUses: string[]; expiresAtMonoNs?: string }
 | { status: 'unknown'; reason: string; lastEvidenceRefs?: string[] }
 | { status: 'conflict'; reason: string; evidenceRefs: string[] };
interface ObservationEnvelope {
  context: RuntimeContext; stamp: EvidenceStamp;
  source: 'client'|'fixture'|'simulated';
  domain: string; baseline: 'full'|'delta'|'reset';
  coverage: unknown; payload: unknown; gapRefs: string[];
}
```

类型分层：BlockPos有限整数，连续Pose有限数；单位从packet转到领域时统一，不把byte angle或网络固定点裸值外泄。旧二维x/y只能留显式fixture兼容层，旧平面y映射新z，不自动迁移成高度。

Bridge拆分只读WorldReader/BodyReader、CapabilityProvider与异步InputGateway。不存在通用`walk(x,y):void`或可写`position`；真实动作由InputPlan驱动，观察决定结果。FakeWorld直接改图只允许fixture控制面，不能出现在生产技能接口。SessionRuntime依赖中立合同，不引用Fake类型。

## 7. 领域归一化与数据质量

| 领域 | 输入与语义 | 资格/失效规则 |
|---|---|---|
| 本体姿态 | C→S报告、S→C修正 | 报告不等于服务器逐帧确认；修正建立新锚点 |
| entity轨迹 | spawn、相对entityDelta、绝对PositionPath、remove | 相对缺包后不继续累加；entityId＋spawnGeneration |
| inventory/UI | 服务器slots/window、客户端交互意图 | stateId按目标合同解释；未知组件不能字段跳过 |
| chunk/block/light | chunk与增量、卸载 | 未加载不等于空气，light缺失不必等同碰撞缺失 |
| registry/dimension | 配置/世界与维度事件 | 旧numeric ID不可跨registryEpoch解释 |
| health/food/effects | 服务端最近状态 | TTL/初始缺失显式unknown |
| chat/auth | 双向消息与可信度 | 来源文本不赋予内部权限，不以发出当认证成功 |
| OS/UI/capture | 进程/窗口、执行预期、可选真实帧 | foreground不证明游戏focus/鼠标捕获；UI推断不能冒充观察 |

碰撞数据保留shapeOrigin（vanilla_verified/upstream_generated/inferred_analogue/unknown）与validationProfile。generated不是自动verified；approximate只允许明确实验档案，不作为可靠通过的依据。动态连接形状如门/栅栏依赖邻接与状态；缺条件返回unknown。

原始chunk已接收、附近可用于碰撞、表面已探索、相机可见分别建投影。模型和网页不看原始包、隐藏矿石或未见实体；内部几何查询也受用途策略约束。

字段TTL读取时计算；新值校验后更新；通知不可变、订阅者异常隔离。各sourceEpoch内sequence单调，初次完整基线可从任意数值开始，缺基线delta不能建立完整状态。跨进程单调时钟需偏移/误差估计，不能直接相减。

## 8. 输入网关与回执

```ts
interface InputPlan {
  commandId: string; executionId: string;
  context: RuntimeContext;
  ownerId: string;
  leaseRefs: Array<{ resource: string; leaseId: string; generation: string }>;
  sequence: string;
  issuedAt: { monoNs: string; clockDomain: string };
  maxAgeMs: number; validForMs: number;
  snapshotRef: string; expectedInteractionMode: string;
  controls: { heldKeys: string[]; heldMouseButtons: string[];
              mouseDelta?: { x: number; y: number } };
}
```

准入核验owner、connection/body/control generation、租约、生成/排队年龄、原始观察年龄、UI/焦点/校准，实际native提交前再检查。转发器无输入权。relative mouse不是yaw/pitch，SDL scancode/keycode与Win32 scan code不可直接互换；用有版本校准映射。

held-set为完整替换，释放old-new、按下new-old；含键盘和鼠标。增量/点击/文本单独command去重，pending合并或拒绝，completed不重发，unknown不自动再试。helper重启控制不确定，空去重表不是可重放证明。

网关状态disabled/ready/active/releasing/control-uncertain/faulted。进程开始时间＋PID＋HWND＋bindingEpoch防句柄复用；窗口关键字段缺失按unknown拒绝，不按默认true。独立helper watchdog使用单调deadline，stdin卡住仍检查。清理逐项尽力，不因release异常跳过shutdown/close。

回执层级：not_dispatched、accepted_for_delivery、injection_attempted、possibly_dispatched、outbound_intent_observed、effect_observed。保留各证据，不能用一个accepted布尔值替代全部层级。出站包难以唯一归因command时标相关性不足；不注入协议标记强造关联。

文本事务使用secretRef或受控文本，不把明文凭据放InputPlan/trace。UI未知拒绝输入；敏感区间按token/refcount，不因一次typeText finally就宣称屏幕/聊天历史已无秘密。原始流仅转发，不默认落盘或把敏感包全文送观察日志。

## 9. 执行、副作用与恢复合同

proposalId是本地逻辑提案，executionId是执行，effectId是可能副作用，provider toolCallId只服务消息配对。相同proposalId需校验scope＋规范参数hash，相同返回原执行，不同拒绝；不能把旧DB running直接视为当前仍调度。

生命周期与结果分开：queued/running/stopping/verifying/suspended/succeeded/failed/canceled；结果not-dispatched/observed-applied/partial/observed-not-applied/ambiguous/not-applicable。目标满足与动作因果归因另存。需要外部效果的技能结果ambiguous时不能被finalizer改confirmed。

副作用最小序列：

1. 事务保存intent、scope、dispatch epochs、target、before evidence与prepared。
2. 检查当前准入，持久化may-have-dispatched屏障；失败则不发送。
3. 输入及分层receipt，进入verifying。
4. 新鲜证据核对confirmed/partial/ambiguous；有版本转换守卫。

允许ambiguous进入新核对轮次，但不退回“未发出”。prepared若能证明dispatch屏障未完成可当未发送处理；屏障后即使实际上未输入也可能只能保守unknown。DB与helper/服务器不能原子提交，明确崩溃窗口。

历史恢复按稳定scope筛选，使用新context证据核对；旧connection/body epoch不强制等当前，但旧命令仍必须被拒绝。confirmed的迟到普通upsert不能回退；发现旧核对错误可通过显式版本化纠错事件修正。

Session idle/starting/running/recoverable-failure/closing/closed；失败清理后可重试，start/recover/shutdown单owner。恢复新建执行和租约，不恢复旧input。pending分页/退避/预算，未决记录不被保留清理删除。

## 10. 模型工具与操作员API

工具基本集：get_state、query_local_world、get_inventory、capture_view、start_observation、find_skills、start_skill、get_execution、cancel_execution、read_events、query_memory、query_knowledge、revise_goal、send_chat。低层action chunk仅对应控制器验证后开放。

工具结果含ok/result、snapshot/evidence refs、unknowns、warnings、cursor。未知查询可正常返回，不伪造成0或空世界；副作用accepted不是succeeded。

同轮工具保持模型原始顺序，第一版统一顺序准入；写后读若需技能完成必须等待execution事件再查询，不能把accepted当效果。每次写准入前检查goalRevision/decisionGeneration/Abort，旧响应不执行。长技能立即返回ID，不阻塞整个模型轮次等待游戏完成。

canonical history记录公开文本/图片引用/工具调用结果及provider扩展来源。OpenAI/Anthropic分别序列化；截断/错误/取消不会释放半成品工具。切换必须处理未配对工具并fence旧请求，不把一家的private块发给另一家。上下文裁剪保留完整工具边界，秘密不入history。

ControlService命令语义：goal set增加revision；pause停止新准入并等稳定交接；resume新鲜核验；cancel针对execution；stop撤销当前自主运行并尽力停止，不删除effects；chat明确是游戏发送；消息入口给Agent方向并记录处理状态。所有入口使用同一协调器。

HTTP /api/v1提供状态/能力、目标/任务、执行/effects、地点/记忆、provider与脱敏配置；POST /commands携requestId、command、args、expectedRevision，409表示冲突，幂等键含payload校验。SSE /events提供有界订阅和重连cursor。

live cursor为{bootEpoch,sequence}，durable eventId独立；过滤不制造gap，返回scannedCursor。快照与订阅用一致水位防竞态，gap后重新查询；逐tick样本不逐条fsync。CLI attach与网页并发CAS，不排队重放浏览器离线写操作。

服务默认loopback，配对码换HttpOnly/SameSite会话，校验Host/Origin和CSRF；生产同源托管，开发Vite代理。秘密只显示configured状态。进程/DB/body单实例锁，浏览器退出不shutdown。远程部署/TLS不是本期默认能力。

## 11. 固定源码候选与复用界面

以下为用户路线研究取得的候选引用，本设计未重新外部核验或安装：

| 组件 | 固定参考 | 用途/限制 |
|---|---|---|
| minecraft-data #1301 | 924e26d6b3bb8f97a5d1e73d6190b09879c2e1e2 | 26.3 schema/data候选；含void组件、近似shape缺口 |
| data #1300 | e4cbec4b17815d6ce8d8ba991dd3b2d9d8f4a57d | scaffold前置，不单独视为支持 |
| NMP #1538 | a1a33809c49553e544a7efd3d8bc03eb0867f4ab | entityDelta interpreted/compiled及低层codec |
| NMP #1532 | a3c018efbf1b8645f16427e7b4a8185ea4218ee2 | 版本支持前置 |
| chunk #334 | 7382b4fef1c56290524665e7b9af58b7d1f34791 | chunk/light候选，核对前置映射/global palette |
| NMP #1539 | f8f8a20a300e9bf3914580b8cea6573691c55036 | 仅对照向量，不并装vecDelta契约 |

npm minecraft-data消费物需包含生成索引/data.js，不只覆盖数据仓目录。锁定生成过程、依赖图、resolved/integrity或完整Git引用；PR package.json版本不代表npm已发布。保留许可/补丁来源。首选隔离低层库adapter；只有有界性或错误处理不适合时自研薄framing层，typed decode继续复用。

## 12. 验证证据与未决边界

遵循L1的T1–T4分层。T1用真实loopback sockets，验证未知包照样字节等价和observer故障；T2测分片VarInt、压缩切换/同buffer多帧、超限/截断、跨向歧义、热重配置；T3测真实来源/独立向量的消费字节数、单位、state/registry版本和局部gap恢复。

entityDelta单步ticks0可能重编码规范化，原始转发不受影响；测试不能把decode→encode不等价隐藏，也不把它当转发必须重编码的理由。PositionPath绝对与entityDelta相对分开。

当前未知：完整组件语义、部分chunk/light/CONFIG独立样本、碰撞真实性、固定组合Node22运行结果、真实输入与原版互通。缺证时能力unverified或unavailable，不能以fixture source改client消除缺口。本组三份是设计基线，不是上述验证报告。
