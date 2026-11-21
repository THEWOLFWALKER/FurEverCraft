# FurEverCraft L3：控制、几何与恢复的实施设计

v0.3 · 2026-10-24 · 已定案待迁移。上位[L1](minecraft-agent-top-level-design-v0.3.md)、[L2](minecraft-agent-client-bridge-contracts-v0.3.md)。本文件数值是默认工程预算/合成验收配置，不是26.3实测参数。

## 1. 现有模块迁移

保留ActionPlanner、MotionController、route/progress和模拟身体，按L2接口逐项替换：
- `src/skills/navigation.ts`只请求路线/primitive，不直接提交BodyAdapter写命令。
- MotionController的submit改为ActionContext.perform或对同primitive发受控pulse；stop最终落到releaseOwned，release不需新鲜世界观察，但必须校验owner。
- `BodyAdapter.observe(options)`支持signal/deadline；`WorldObservation`拆observed pose、server anchor、predicted pose，不把source固定为simulated或observed-server。
- legacy2D从单独composition注入，禁止Symbol附件或方法存在性自动选择生产身体。迁移期间显式adapter constructor连接旧fixture，完成该入口迁移即去除其旧调用。

## 2. LocalControlView与控制器

ControlView包含：captured context、当前字段revision、clientReportedPose、serverCorrectionAnchor、velocityEstimate及误差、support三态、geometry coverage、uiMode三态、focus、calibrationRef、age和gap。server未纠正不等于逐包确认；客户端ground flag不是独立支撑证明。

状态机固定CHECK→ACQUIRE→ACT→OBSERVE→VERIFY→SETTLE→SUCCEEDED。异常转CANCELING→RELEASE→VERIFY_RELEASE→CANCELED/CONTROL_UNCERTAIN。缺前提停CHECK并返回unknown，不继续猜测动作。

事件驱动重估，50ms软周期兜底；晚到只执行最新状态，不追帧补发。字段间因果按direction sequence/epoch与明确控制事件，不以收包墙钟顺序假装服务端tick。观察request默认250ms预算，单primitive默认5s，导航总预算30s、3次局部重规划、每签名最多2次恢复，均受上层更短预算限制。

移动时pose age默认<=100ms正常短脉冲，100–200ms限幅/只在安全包络可证时继续，>200ms撤新输入并释放；静止无新位置包不自动判丢失，只使用独立健康与字段适用证据。以上是合成配置，实机必须校准，未知延迟下不得批准危险运动。observe不settle也必须可取消；Promise.race只保护调用方，底层任务必须abort或隔离，不能积累未完成请求。每primitive至多1个在途observe。

## 3. 导航与几何

继续有界动作图A*。同步搜索搬到worker，默认最多4096 expanded nodes、10ms计算片段、20ms总墙钟预算；预算耗尽返回partial/needs-planning，不伪装不可达。worker需真正处理cancel，不用void Promise.resolve当yield。路线依赖bundle/geometry profile/region revisions，执行每段重验；变化只失效受影响后缀。失败边按scope+动作+前提签名有限TTL缓存，不永久宣布地形不可通行。

目标采用连续Vec3+明确tolerance，默认0.25 block；离散节点只是规划锚点。空路线必须重新检查真实到达条件；未达容差时使用局部短程控制，前提不足则partial，绝不因在同一格就confirmed。到达要求连续新观察支持稳定位置；没有持续发包时不能无限等“两个新包”，由可用观测/静止采样预算判断，缺证据返回unknown。

几何字段：stateId+registryEpoch、ResourceLocation+stateProperties、collisionAabbs、interactionAabbs、contextRequirements、sourceVersion/inherited、geometryVerification。两类shape不可互代。越出格子的AABB按资产全局外扩范围查询邻域并做broad-phase索引；不是只扫描当前位置方块。unknown不能作空气或可靠地面；脚下支撑必须存在可核实的水平接触区域。

资产路线：mcmeta核对状态属性；RosegoldMC固定26.3静态表导入并标继承；prismarine-block只参考映射方式，禁静默full cube回退；prismarine-physics作为异构参考，不作为原版真值。普通站立尺寸/物理参数随profile且注明证据，不固化成跨版本常数。

首期真实资格：普通站立、已知干燥完整地面、无特殊效果/外力、焦点与UI可知、短程走/停。复杂静态形状允许查询，不自动启用跨越。真实跳跃、冲刺、下落、液体、攀爬、粉雪、脚手架、移动活塞禁用；保留现有模拟跳跃测试，不降低既有模拟覆盖。

## 4. 输入模式、校准与helper

输入模式MOTION、AIM_USE、GUI、CHAT互斥；模式切换先空held-set并确认，GUI/chat时不得移动/转向/挖放。UI未知不可盲按Escape“恢复”。紧急release始终允许，不要求当前焦点等于游戏窗口。

`setHeldInputs`是完整集合替换：diff仅派发变化键，空集合释放本owner全部键/鼠标按钮。键标识固定physical action -> Windows scanCode+extended，SDL scancode与Win32 VK不得混用。保留旧VK协议仅显式legacy profile，不能称SDL3已校准。

PowerShell保持启动/配置入口，固定Windows PowerShell 5.1与系统.NET Framework 4.8；C#源码使用该环境Add-Type支持的语法，通过Add-Type加载同进程native-control core，不新增.NET8运行时依赖。JSONL使用System.Web.Extensions中的JavaScriptSerializer，MaxJsonLength=64KiB、RecursionLimit=32，逐字段白名单验证；不得使用该环境没有的System.Text.Json。C#内独立线程读取stdin/反序列化，独立watchdog线程使用Stopwatch，所有owner/held-set/epoch更新与SendInput通过同一短临界区。stdout只写串行JSONL回执，stderr脱敏诊断。dry-run使用同核心及假OS sink，默认不开P/Invoke；不采用PowerShell timer scriptblock依赖runspace事件循环。

watchdog默认10ms检查、input pulse有效期最多150ms、heartbeat上限500ms；受OS调度约束，不声称硬实时。长文本分成最多16 UTF-16 code units的小批，代理对不拆开；每批前验证焦点/owner/期限并释放在途key-up。焦点改变停止后续批，partial或ambiguous，不补发整段。SendInput返回仅OS派发结果，不代表SDL/客户端消费。

跨进程时钟通过bind的5次ping-pong采样建立Node mono→helper Stopwatch偏移区间，选最小RTT样本但保留不确定度；映射误差>25ms时拒绝控制。driver将Node期限映射到helper时钟并取保守最早边界；helper同时限制本地最大TTL，旧deadline不得因晚到变新。每30s重校验映射，helper重启换epoch、旧映射失效；离线时间/延迟均可注入。

helper每请求默认500ms response timeout，关闭/释放用独立有界deadline；超时command标unknown，非幂等鼠标/点击/text不重放。重复commandId同payload只回原receipt，异payload拒绝；dedup缓存默认4096项/10min。缓存过期后通过单调commandSequence高水位拒绝旧命令，不把过期ID当新动作。新epoch清缓存但不能重放旧epoch动作。

标定profile键包含game release、input backend、窗口进程实例、游戏键位/灵敏度设置指纹和calibrationId。鼠标两轴正负方向分别标定，环形yaw误差，pitch限幅；DPI、模式或设置变化使profile失效。当前禁止实机输入，因此仅支持注入校准模型，真实turn保持unverified，不填经验gain冒充。

## 5. 恢复合同

| 故障 | 立即动作 | 重开条件 |
|---|---|---|
| framing/phase/全局IPC gap | 同步撤controlGeneration，abort，helper释放 | 新会话或可证明完整重同步，重新资格求值 |
| 单域投影失败 | 失效该域及依赖能力，停止依赖动作 | 新基线覆盖并且增量连续 |
| server位置纠正 | 丢弃旧预测/路线，停短输入 | 新anchor与环境前提有效，有限重规划 |
| helper重启/静默 | release-uncertain，撤权，不重发click/text | 旧owner退出，new helper epoch+绑定+映射+校准合格 |
| 恢复时见目标满足 | 记录targetSatisfied=true | 无本人因果证据则effect继续ambiguous |
| DB写失败 | 屏障前禁止派发；派发后保留unknown | 存储可用、执行隔离、pending调和后新动作 |
| 换world/account/dimension | generation失效，按新scope取状态 | 新scope和字段基线建立 |

recover只处理非活动execution；执行自身context必需，不从effect集合猜。跨epoch能用新观察判断当前目标，但因果条件更严格，不能一律拒绝历史核对，也不能自动confirmed。恢复预算默认每effect最多3次、总5s，一次失败可下次重试，不让Session永久started。只有明确可逆且已核验的补偿才创建新动作，取消不回滚。

认证提示封装为AuthChallenge(session/connection epoch、message source、server-channel、receivedAt、evidenceRef、register/login类型)。普通玩家消息不能提升可信度；服务器可伪装玩家内容，因此需要来源分类与目标服策略，不能只靠关键词。凭据secretRef仅交网关内部text renderer，效果只存脱敏模板。缺证据时等待操作员消息，不自动乱发密码。

## 6. 验证矩阵

A. 独立规范：literal压缩帧(02 00 01)、RFC1950存储块、两帧合并及所有split、声明长度/线上长度分别越限、内层VarInt跨帧禁止。实际小修已覆盖这部分，非真实Minecraft证据。

B. 几何Oracle：完整地面、x=1墙与半宽0.3的x<=0.7边界、负坐标floor、半砖支撑、低顶、越格AABB、未知邻区不能作为支撑、门变化。Oracle不调用生产碰撞函数。半宽数值只在对应合成profile使用。

C. 控制：同格未到容差、observe永不settle、位置纠正、100–600ms延迟/抖动、静止低频报告、过期pulse、焦点丢失、取消后旧finally、helper重启、全部held失效后sim body不能再走一步。

D. 效果：屏障写失败零派发；屏障后崩溃但未发；实际发后回执丢；第三方改目标；gather第K次崩溃；recover抢活动effect必须拒绝；状态CAS冲突必须不派发。

E. helper：真实子进程dry-run，stdin打开停止送行，watchdog自行清held；无响应请求超时；窗口身份切换、文本分批中焦点变化、旧sequence/dedup缓存淘汰与epoch切换。不得调用SendInput或桌面截图。

F. 综合：CLI/Web共一Runtime；取消与SSE重连；scope切换；provider工具中途取消和同参数新意图；正常/失败/取消/重启四条链。所有fixture声明proofScope=synthetic_contract。

离线证明只覆盖合同和数学/合成控制行为；真实26.3客户端校准和误差轨迹继续外部未验证。无训练模型/MPC/全游戏物理复刻作为本批前提。
