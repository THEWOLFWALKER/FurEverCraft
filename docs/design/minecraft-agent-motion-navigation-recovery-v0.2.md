# FurEverCraft：运动、导航与恢复设计

版本 v0.2 · 2026-10-17 · L3：动作图、控制周期与模式恢复

上位：[L1 顶层设计](minecraft-agent-top-level-design-v0.2.md)；接口与数据：[L2 客户端桥合同](minecraft-agent-client-bridge-contracts-v0.2.md)。目标Java26.3，运动参数、SDL3输入映射和各地形能力尚需验证。本文件定义目标行为，不把模拟物理当原版真实性证明。

## 1. 分层与所有权

| 层 | 输入/输出 | 责任边界 |
|---|---|---|
| Goal/Task | 目标、依赖、预算→技能提案 | 不产生逐帧输入 |
| Skill | 前提/子目标→原语序列与核对 | 不直接写世界或调用OS/socket |
| Global Route | 地点/区域/frontier→路线候选 | 历史通道需再验证 |
| Local Planner | 当前几何/能力→可执行ActionEdge | 不创造尚无控制器的转移 |
| Motor/Primitive | 一致局部视图→有限InputPlan | 不等待模型、SQL、截图或重搜索 |
| InputGateway | 计划/租约/身体绑定→native尝试 | 最后时效/权限门禁，不宣称游戏效果 |
| Reconciler | intent/receipt/新观察→结果确定性 | 不继续操控已取消的旧动作 |

输入经真实客户端产生协议消息，Observer只读这些消息；Motor不能发teleport确认、移动包或keepalive来替代客户端。模型/Planner可替换，但统一经过L2合同。

## 2. 当前26.3身体状态与数据资格

### 2.1 两轴模式

physicalMode＝GROUND/AIR/WATER/CLIMB/INCAPACITATED/UNKNOWN；interactionMode＝GAMEPLAY/CHAT/INVENTORY/CONTAINER/MENU/UNKNOWN。开UI不意味着身体静止或已在地面。

GROUND至少依赖姿态报告与当前支撑证据；AIR不是一次缺包即可确认；WATER/CLIMB要几何/模式证据，不能因缺字段自动套用地面控制。氧气/姿态等不是保证每个本地玩家都有协议直读字段，缺失保留unknown。

UI事件、OS前台和执行预期不是同一证据。玩家背包界面可能没有服务器open事件；必要时使用受控主动观察/真实截图建立模式和布局，缺能力就拒绝相关交互。这里不要求每次移动截图。

### 2.2 三维与时间

位置x/y/z，y向上；连续Pose与整数BlockPos分开。yaw/pitch统一度；碰撞距离/速度/轨迹采样单位在adapter内转换。客户端报告和服务端修正并存；网络到达间隔不等于模拟tick。

Motor读取不可变LocalControlView：context、pose/velocity estimate、physical/interaction mode、邻域几何/形状资格、实体短期轨迹、观察时间与不确定性、revision依赖。读视图不做数据库查询或触发网络请求。

实体26.3相对entityDelta缺增量后不能继续累加；PositionPath是绝对轨迹锚点，不作相对位移。server correction使旧预测锚点和关联动作失效。不能因客户端未收到修正就把所有预测升级为server-confirmed。

### 2.3 几何与公平信息

查询碰撞盒、脚下支撑、头部净空、可触达面、流体/危险与形状来源；以blockstate＋邻接上下文＋registry/data profile作为解释依赖。

unknown/approximate不默认为完整方块或空气。可靠路径只使用具资格的几何；实验档案可允许明确有界试探，不能由模型自行将shape晋升。已验证旧版本形状不自动迁移为26.3已验证。

碰撞查询与资源识别分投影：可接收区块并不授权发现隐藏矿石。探索目标来自已观察/允许探索的frontier，不读取fixture真值全图。地图和记忆维持相同用途过滤。

## 3. 原语合同与阶段

```ts
interface PrimitiveSpec {
  id: string; version: string; implementationId: string;
  parameterSchemaRef: string;
  requiredCapabilities: string[];
  acceptedPhysicalModes: string[];
  interactionRequirements: string[];
  entryPredicates: string[]; invariants: string[];
  resources: string[];
  progressPolicyRef: string; terminationPolicyRef: string;
  handoffPolicyRef: string;
  effectClass: 'motion'|'interaction'|'world-mutation'|'message';
  validationProfileRefs: string[];
}
interface PrimitiveInvocation {
  id: string; executionId: string;
  primitiveId: string; primitiveVersion: string;
  parameters: unknown; contextRef: string;
  snapshotRef: string; dependencyRefs: string[];
  leaseRefs: string[]; budgetRef: string;
}
interface PrimitiveFeedback {
  invocationId: string; phase: string;
  progress: { kind: string; value?: number; evidenceRefs: string[] };
  status: 'running'|'stopping'|'verifying'|'settled';
  reason?: string; effectRefs: string[];
  handoff: 'now'|'phase-boundary'|'recovery-required'|'unknown';
}
```

内部状态：created→checking→waiting-resources→executing→verifying→settled，旁路可进入stopping/suspended/recovery-required。SETTLED的执行结果和外部effect确定性分开，不把函数return当世界完成。

预算对象跨原语/技能/目标共享，包含期限、无进展窗口、重试、材料和允许风险。新executionId不重置累计失败。等待资源/区块/服务端证据必须有原因与唤醒/期限，不无限占部分资源。

## 4. 原语目录与能力演进

| 原语 | 阶段/成功证据 | 当前设计定位 |
|---|---|---|
| orient_to | 估计→有限旋转→姿态核验，朝向进容差 | 基础闭环，需SDL3校准 |
| walk_corridor | 对齐→推进→减速→目标域与支撑 | 首批地面能力 |
| step_up | 入口净空/支撑→跨越→稳定 | 首批明确形状档案 |
| jump_short | 接近/起跳/空中/落地/稳定 | 仅有界已验证轨迹，不泛化parkour |
| controlled_drop | 对齐→落步→落地稳定 | 首批限定高度与落点 |
| swim_to_surface/region | 上浮/推进→可呼吸/目标态 | 后续独立水中能力，不自动启用 |
| exit_water | 贴岸→上岸→地面稳定 | 需要水岸/模式验证 |
| climb_surface | 接触→攀爬→脱离稳定 | 后续，不用地面控制替代 |
| interact_once | 可触达→瞄准→一次交互→核对 | effect可能未知 |
| dig_one/place_one | 工具/材料/目标→输入→释放→结果证据 | 接L2账本，不以计时/点击确认 |
| enter/exit_ui | 合适交接态→切换→模式证据 | 缺UI证据拒绝后续文本/槽位输入 |
| click_slot | 窗口/布局版本→点击→槽位核对 | data component缺口会阻断 |
| submit_text | 明确文本模式→输入→提交→核对 | 文本partial/unknown不整串重发 |

这是目标目录，不代表全部本批实现。真实profile与simulated profile分别启用。首批模拟可限定平地、合格半砖、1格短跳与最多1格落步；这些是可测试范围，不是原版物理常数或全部26.3能力。

### 4.1 跳跃与取消

APPROACH确认速度/方向/支撑→TAKEOFF确认离地→AIRBORNE相位控制→LANDING核对落脚域→STABILIZING。撞头、未起跳、偏离落点分别报告。y增大或onGround=true不单独证明完整成功。

正常取消尽量完成受限落地/交接；紧急撤权后新恢复owner接管。无适用空中恢复器时，尽力停止危险持续输入并报告control-lost，不宣称松键就安全。

### 4.2 搭桥、采集与战斗

搭桥组合：靠边→保持支撑→瞄准→place→验证新支撑→前移。未确认支撑不能踩上规划假设。当前只保留合同，不为了目录完整就启用自动搭桥。

采集组合：已观察目标→到可交互站位→选物/瞄准→dig→掉落观察→collect→库存目标。实体消失不能证明我拾取，方块被别人破坏不归因自己。

战斗未来分保持距离/移动/攻击/撤退，显式共享视角与手部资源；不以combat=true覆盖导航，首批不承诺完整战斗。

## 5. 局部动作图

```ts
interface ActionEdge {
  id: string; primitiveId: string; primitiveVersion: string;
  startRegionRef: string; terminalRegionRef: string;
  entryPredicateRefs: string[]; dependencyRefs: string[];
  assumedEffectRefs: string[];
  costs: { durationEstimateMs?: number; materials?: Record<string, number>;
           damageEstimate?: number; uncertainty: 'low'|'medium'|'high'|'unknown' };
  admissibility: 'validated-profile'|'conditional'|'unsupported';
}
```

基础节点以可站立区域/支撑面表达；对跳跃才扩展必要速度/朝向状态，避免全图维度爆炸。走廊用swept volume查碰撞，不只查起终点；对角不穿角；跳跃查全程头顶净空、落点/支撑和控制入口域。

复用可用几何/数据模型；A*局部搜索自行组合动作边，Mineflayer Pathfinder/Baritone只按明确可借鉴算法参考，不安装Mod或引入第二玩家。无需训练模型或默认引入完整physics库。

搜索有节点/时间/内存预算、分批让出或worker隔离，可取消。结果回来检查相关依赖，不因无关聊天/远处更新丢弃，也不能只看一个全局revision相同便放行。

### 5.1 搜索结果

- COMPLETE：当前条件下候选路线，执行前再检查。
- PARTIAL：到稳定可交接终点，后续附待观察条件。
- NEEDS_OBSERVATION：具体缺口、允许的观察方式。
- BUDGET_EXHAUSTED：预算不足，不等于不可达。
- NO_PATH_IN_KNOWN_GRAPH：已知图无路，不是永久世界无路。
- UNSUPPORTED_TRANSITION：几何可能有路但控制器不支持。

### 5.2 依赖、施工与动态障碍

路径绑定scope、registry/data/shape profile、相关区域revision、原语版本与材料前提。地形更新只失效相关段；动态实体用有期限的障碍估计，不永久写成地形。

施工后的假设保存在规划层；只有新观察可提升为LiveState。有限候选施工方案逐段实施，不在全局搜索枚举无限改图。当前无可靠dig/place控制或材料核对能力时不生成施工边。

### 5.3 空间记忆与探索

全局图存地点、区域、入口、路线摘要、危险和frontier。按稳定scope查询，连接变化不失忆；每条历史路径带最后核实、适用版本和重验条件。未知世界身份隔离历史但可保留当前局部观察的有限活动。

探索到当前可执行frontier后重新观察，再规划下一段；partial终点不能是悬空/无法维持状态。资源目标来自许可可见投影，不从完整网络chunk挖隐藏信息。

## 6. 控制周期与输入时效

一个本地周期：读LocalControlView→核验context/能力→处理修正/相关失效→原语生成候选→监督器检查模式/期限/资源→网关提交→发布轻量反馈。

默认20Hz软实时；测量调度延迟和观察年龄，延迟过大按合同停止/恢复，不通过补发历史输入追赶时间。没有精确clientTick就标估计，不假称与游戏结算逐tick同步。

InputPlan遵守L2：issue clock/maxAge、snapshot age、deadline、lease和generation共同检查。跨进程时钟未校准时拒绝严格时效动作；不能到达后重新计算TTL使旧命令变新。

held set取最新有效状态；相对鼠标增量、点击、文本不合并重播。响应丢失先读新姿态/效果，不累计补发鼠标历史。校准变更（灵敏度/布局/分辨率/GUI缩放/SDL路径）使相关能力与正在使用的映射失效。

可选模型action chunk携起点域、快照、有限输入、终止条件和交接点；每周期可提前终止，不能盲播到结束。未验证控制profile不向模型开放该工具。

## 7. 仲裁、交接与单写入者

逻辑资源映射实际keyboard/pointer/UI冲突；移动与聊天不天然并发。复合资源原子获取，gameplay共享模式与UI切换独占。模型不能自行提高优先级越过恢复控制。

优先级：生命周期紧急异常→模式恢复→人类改向→当前任务→普通社交；公平性在安全阶段边界处理。普通聊天在跳跃/危险水域可等待并显示原因，不永久隐藏饥饿。

正常交接：请求→新控制器检查→旧owner受限完成交接→撤旧lease→新鲜核验→新lease→验证首个输入。旧owner不能启动新副作用或无限延长。

紧急交接：原子撤旧资源代次→新恢复owner取权→依据剩余有效证据维持/停止→核对→稳定或control-lost。旧finally只释放自身仍持有的lease，不能clearAllInputs伤及新owner；全局release仅网关生命周期使用，并同步失效相关租约。

人为直接操作游戏窗口可检测时暂停Agent；无检测证据不能保证没有外部键鼠，保持不确定性。网页/CLI控制同一个Executor，不分别获得身体写权。

## 8. 进展、能力与失败经验

| 行为 | 合理进展 | 不可靠替代 |
|---|---|---|
| 导航 | 当前走廊推进、中间区域/阶段通过 | 到最终目标距离每帧必须减小 |
| 跳跃 | 相位推进、落脚/稳定证据 | 按jump或y升高 |
| 水中 | 向呼吸/目标区域实际推进 | 有位移就等于脱困 |
| 挖掘/放置 | 正确目标状态和相关新证据 | 动画、计时或API成功 |
| UI/聊天 | 模式/窗口变化、提交/接收分层证据 | 按过T/E、SendInput返回计数 |

进展监测分无新观察、观察新但无位移、外部阻挡、相位等待、服务端响应慢。滑动窗口＋阶段期限；等待不直接误判成卡死，但必须有界。

CapabilityProfile绑定backend、26.3 adapter/data、原语版本、身体模式/地形/输入校准和证据来源。状态unverified/experimental/enabled/degraded/disabled；simulated enabled不传播为client enabled。一场成功不晋升所有条件。

FailureSignature含目标语义、原语版本、局部区域、失败分类和关键前提。没有新证据反复同签名触发共享预算/冷却；恢复和重新验证可解除临时限制，不永久推翻整个知识规则。

## 9. 与旁路观察联动的恢复

```text
FAULT → CLASSIFY_AND_SCOPE → REVOKE/CONTAIN
      → STABILIZE_IF_SUPPORTED → REOBSERVE/RECONCILE
      → RETRY_LOCAL / REPLAN / WAIT / SUSPEND
```

| 异常 | 行为 |
|---|---|
| 小偏差/静默输入drop | Motor有限纠偏；阶段无进展后升级，不以计划路径长度确认 |
| 动态堵路/相关几何变化 | 停止进入无效边，有限等待/局部重规划 |
| 局部库存/窗口unknown | 暂停相关交互；不必要地冻结仍有有效证据的导航是不对的 |
| 局部chunk gap | 失效相应路段；已有完整邻域足够时可去稳定点，不跨未知区 |
| phase/framing/compression全局unknown | 禁新自主身体动作，撤旧输入，尽力停止；不凭旧地图继续跑 |
| 全局观察丢失时身体在空中/水中 | 只允许使用独立、仍新鲜证据且已有适配能力的恢复；否则control-lost，不凭空保证保命 |
| server position correction | 新锚点/control generation，拒绝旧预测计划；不抹掉全部历史地图 |
| 加密不可观察 | 保留隧道可选，结构化自主暂停，不自动转纯视觉/注入 |
| API不可用 | 有效技能有限继续至决策/安全边界，等待provider |
| UI/focus/helper异常 | 撤权、尽力释放、控制uncertain；重新绑定/校准后再取权 |
| 死亡/断线 | 新body/connection epoch，重建基线，核对effects，恢复任务语义 |

unknown effect只阻塞依赖它的后续动作，不应阻断无冲突避险；但“避险”也不能绕过失效的身体观察和输入能力。

### 9.1 Session与重连

连接恢复与客户端菜单操作分开：Relay重新listen/connect不等于原版客户端已重连。SessionSupervisor调度退避/预算；ClientLifecycleAdapter只有对应窗口/UI和输入能力验证后才可操作重连/respawn。缺适配能力时等待人工，不能另起NMP bot凑连接。

认证经配置化模板/已观察提示与secretRef，budget有限。登录成功必须有服务器流程证据与可活动状态；客户端聊天已发出不表示已认证。普通聊天提示不能单独授权泄露凭据。

### 9.2 稳定作用域与旧效果

原副作用保存dispatch scope/epochs。新会话先确认server/account/worldGeneration/dimension，再用新鲜世界证据调和。不得要求旧connectionEpoch/bodyEpoch等于当前；也不得因此恢复旧lease或旧未发送输入。

confirmed/partial/ambiguous与“目标满足”分别表示，其他玩家改变目标时不能归因自己。恢复不回放旧点击、文本、鼠标增量或任意脚本栈。

## 10. 四个端到端例子

### 10.1 导航中操作员说“回来”

ControlService写目标新revision→fence旧模型→当前原语进入受限交接（地面停稳/支持时落地）→撤旧lease→从新位置检索并重验地点→新规划→新执行。网页和CLI看到同一时间线。记忆地点不因取消旧目标失效。

### 10.2 桥沿放置后断线

durable intent→dispatch屏障→输入→未得足够证据即断线→effect ambiguous，撤旧控制。新会话确认scope、观察目标和材料，分别记录目标是否满足/是否能归因。不能因为重连epoch不同永远拒绝核对，也不能点一次就踩上假设方块。

### 10.3 新物品组件无法解码

原始frame照常到客户端→Observer整包库存投影失败→inventory incomplete→取消依赖库存/材料的交互准入。几何/姿态独立完整时可继续无库存依赖的有限活动；下次完整库存成功解析才恢复，不把未知组件当空/void跳过。

### 10.4 水中观察器崩溃

Relay继续转发、UI显示observer失效→撤旧自主输入权→核验是否仍有独立新鲜的水中/上方空间证据和恢复控制器。具备才有限接管；不具备则control-lost并请求人工，不承诺松键安全。worker重启不恢复旧healthy，需要可信基线。

## 11. 离线身体、回放与能力验证

SimulatedBody消费InputPlan并按明确版本化模型产生连续位姿/碰撞/跳跃观测；世界独立于Runtime保存。导航不能直接setPosition(target)，生产技能不拿fixture控制面或全图。旧二维fixture仍可用于历史回归，不能证明26.3控制能力。

trace包含scope/epochs、goal/execution/primitive/effect/command ID、证据引用、阶段/租约/输入摘要和错误关联。bounded ring/故障切片＋归档，认证敏感值脱敏，原始游戏流默认不录制。回放仅诊断，无真实输入/网络外发。

测试分层：

1. 控制合同：过期/迟到、旧finally、原子资源、取消相位、watchdog、真实共享Clock。
2. 观察合同：T1/T2转发与控制状态、domain gap、全局unknown、worker重启/热配置。
3. 几何/动作：净空、半砖、短跳、动态阻挡、unknown形状、server correction。
4. effect/恢复：写失败、dispatch崩溃窗口、跨Runtime独立世界、跨会话调和与身份隔离。
5. 操作员/API：网页/CLI并发revision、模型迟到、provider切换、有限重试。
6. 未来真实验证：SDL3输入、focus/UI、原版互通、动作与观察效果对应；本轮不执行。

指标区分规划误放行、控制偏差、观察缺失和因果不确定，附profile/样本数。模拟长运行只证明模型范围内的状态机/资源行为，不叫真实长期生存。原语晋升同时需要执行、停止/交接、故障检测、证据与回归，不能单凭一次成功。

## 12. 设计实施依赖

先统一三维异步Bridge、Clock/Executor和effect语义→建立26.3观察基线与T1/T2→使必需领域T3可用→启用相应基础原语→逐个组合技能→后续水中/攀爬/施工/战斗。UI、provider和记忆独立工作不必等待全部原语。

保持从v0.1继承的核心：Planner/Skill/Motor解耦、模式特定交接、部分路径稳定终点、共享恢复预算。新增定案：原始转发所有权、观察失效分域/全局、26.3数据资格、SDL3输入校准、稳定scope恢复和双控制台单写入者。具体任务交付包在本组三份设计确认后另行整理。
