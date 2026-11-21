# FurEverCraft 下一批开发补丁：生产装配与完整离线能力

日期：2026-10-18。基线来自开发者报告，规划方本轮没有重新审计源码，也没有独立核验其 171 测试结论。设计 v0.2 随包参考，本文件明确更新之处优先；不要把老设计中的开发状态当成现状。

## 1. 六项规划决策（已定案）

1. **26.3 codec**：接受候选档案和 fail-closed 作为数据缺失时的真实状态，但不是本批整体完成的替代。核实当前锁定依赖与既有研究中指定的固定候选，候选实际存在、版本身份与 schema/native 一致且离线验证通过才允许注册为 experimental adapter。允许锁定上游提交、最小 vendor 和可重复 codegen；不猜字段，不凭报告中的 SHA 直接信任，不把最新版依赖等同于26.3。没有证据时保持该 decoder unavailable，完成版本注册、导入校验和其余通路。protocol/data version 也必须保留可核对来源，不静默更改目标游戏版本。
2. **Motor 接入**：本批明确授权且必须实现。独立 M 模块不算完成，工具 → Skill → Executor → Navigation/Motor → 输入仲裁 → BodyAdapter 必须贯通。生产路径禁止落回二维 bridge.walk。真实输入不开启，使用相同装配链的 injected sink 做离线验证。
3. **208 条未实现**：逐项映射本包、既有设计和明确排除项。不是全部无条件实现，也不能因以前标 design-gap 就永远不做。与 P01–P24 等价的全部纳入；高级战斗/水下/飞行/自动生成代码/完整生产技能等继续明确排除。没有原清单则用现有任务与设计映射，不臆造编号。
4. **Observer**：解压边界、压缩状态与独立方向状态跟踪纳入。可验证的通用 framing/compression 必须完成；依赖缺失26.3字段的阶段转移和领域投影局部受阻。unknown 不得猜测同步；观察不可用时 relay 仍可转发，动作准入关闭。仅写 unsupported 不算完成可独立实现部分。
5. **五项争议审计**：不预判旧报告对错，按最终实现重新判断。无静态路由只能说明旧路径不适用；新增静态路由要测路径限制。进程内锁只满足进程内合同，需单 Runtime 所有权。未使用 hash 不作为保护证明：删除死路径或给出实际用途。Origin/Host 按浏览器请求、CLI token 与 SSE 分别验证。E2E not-run 可以诚实报告，恒成功脚本不能叫测试；本批实现真实 E2E。
6. **提交轨迹**：沿用当前已集成历史，不重写、不强拆过去提交。新任务按可审阅增量提交，记录实际基线。遇用户并行改动先识别并保留，不覆盖。仅当无法安全合并的具体冲突才请求处理。

## 2. 不被调研阻塞的架构边界

保留 Node22 / TypeScript strict / ESM / npm / SQLite / Zod、Fastify + SSE、React + Vite、CLI 与网页共用 ControlService。使用现有依赖，不为本批引入消息中间件、向量数据库或第二套状态机框架。

独立 relay 进程、observer worker、Windows helper、一个 Runtime 所有者；网页与 attach CLI 不能各自创建新 Runtime。控制循环不等待 LLM、SQLite 长操作或解压。允许不具备真实数据的 adapter 保持 unavailable；不得默认创建 FakeBridge 冒充 client profile。

长期 scope 为 serverProfile/account/worldGeneration/dimension；connection/body/registry epoch 用于当前证据和控制 fencing。重连不是删除历史知识/副作用的理由；旧输入不可重放，历史 pending 用新证据核对。

只复用已有技能研究的流程/失败案例，不在本批导入整套 Mineflayer 技能，不引入未经核实的26.3知识全集。调研结果若到达：先登记证据、评估接口兼容；在本包 adapter 边界内补齐数据，不临时扩大成新的完整开发阶段。

## 3. 任务与验收（P01–P24）

### A. 基线、合同与执行（P01–P04）

**P01 现状与缺口映射**：读取实际源码、当前设计与500项分类（若存在），建立任务到入口/模块/测试的映射，避免重做已实现部分。记录所报修复的现行不变量，不再机械找500条问题。验收：每项 P 有执行路径或明确待实现位置，208项能追溯归属或资料缺失。

**P02 Runtime 装配统一**：所有 profile 使用同一显式依赖容器，注入 Clock/Store/Events/Provider/Body/Nav/Motor。client profile 无真实能力必须返回不可用，不能切 Fake。验收：从公开启动入口追踪到实际实例；禁用输入时无 sink side effect；所有权和实例数有断言。

**P03 执行/效果边界补全**：逐写检查 goal revision、owner、epoch、capability；prepared 持久化成功才允许进入 may-have-dispatched 边界，派发开始后崩溃保持不确定。receipt 与 effect 各有明确状态，不以 handler 返回冒充观察确认。取消、超时不覆盖终态、不隐式回滚。验收：写盘失败/派发前后崩溃/并发取消/旧 finalizer/部分效果，均验证外部动作次数与数据库结果。

**P04 会话恢复和资源所有权**：存储路径同一时只允许一个 Runtime owner，attach 客户端不持锁；使用适配现有依赖的原子所有权机制，不能仅靠 PID 文件存在判断存活或随意删除未知锁。实现死进程恢复、恢复预算、recoverable failure 可重试、跨 epoch 新证据核对。验收：双进程争用、崩溃后重启、world隔离、不完整快照、恢复失败再试；不删除 pending 制造成功。

### B. 原始转发、观察与进程（P05–P09）

**P05 真正原始 TCP relay**：实现 downstream listener / upstream connector、连接生命周期、connect前有限缓冲、双向背压、半关闭、错误与资源释放。只允许显式配置的初始 handshake 地址映射，其余字节不变；不自动应答协议控制包。验收：本地无游戏引擎 sockets 上分片/合并/慢消费者/断连；核对双向字节，包括 observer 不认识的数据。生产 live 路径实现但不连游戏服务器。

**P06 framing / compression**：有界 VarInt、帧长、解压输出、声明长度核对、超时/预算与非阻塞隔离；阈值启用前后逐方向维护，禁止共享一个 phase/compression 变量。压缩比可作防护但不假定高压缩比一定非法。缺少可识别控制事件时状态 unknown，停止解释而不是扫描猜边界。验收：截断/超长/损坏zlib/长度不符/同chunk多frame/切换边界/合法高压缩样本。禁止游戏数据透传受观察解析阻塞；转发自身背压仍按资源政策关闭或限流。

**P07 adapter 导入和能力矩阵**：固定版本 manifest、schema/native/data provenance、哈希、可重现生成入口；安装目录内容核实与报告区分。公开支持矩阵按 packet/domain 展示 verified-fixture、experimental、unsupported，不能用一个 supported=true 概括。验收：版本错配、native缺失、未知字段、错误schema拒绝；自编合成夹具不能标作原版互通证据。

**P08 领域投影**：用实际有证据的 schema 实现位置/朝向、方块/区块、实体、背包/UI、聊天和生命周期的独立 projector。未知变长字段使该完整包不可安全解析时拒绝投影，不能跳字节。观察队列丢失控制信息则全局不确定；已分类非控制域丢失可以局部降级。验收：provenance、sequence gap、复位、sticky unknown、重同步、旧epoch拒绝。无26.3数据域用显式 synthetic projector合同夹具验证装配，保持真实域 unavailable。

**P09 进程编排**：实现服务启动/停止、relay/helper子进程与observer worker监控、有限IPC队列、退出传播、退避重启预算、日志脱敏、优雅关闭期限。helper失活先撤销控制；重启不恢复旧held输入或未确认动作。验收：从进程入口做子进程退出/IPC关闭/队列拥塞测试，不能只测 ChildSupervisor 单类。不开真实native sink。

### C. 导航和 Motor 接入（P10–P13）

**P10 三维桥合同迁移**：新增或完善异步 BodyAdapter / Observation / InputSink 合同；世界坐标、速度/朝向和维度不再复用二维x/y。2D demo留在明确 legacy/simulated profile，用户工具默认走新合同。兼容入口显式迁移，禁止悄悄把z=0补成真实三维。验收：工具schema、持久化位置、网页/CLI目标、技能、日志中的坐标一致。

**P11 导航到 Motor 全链路**：现有有界3D动作图A*与Motor真正接入 navigate_to / return_to_place / explore / gather。路线携带预期前提、落点/容差、可支持动作和观察版本；执行前再验证。只实现已有证据支撑的基础转向、平地步行、停止及已定义基础跳跃动作；物理证据不足动作禁止真实启用。验收：调用公开工具驱动 input sink 并由独立 simulated body 更新世界，不可直接改位置作为“执行”。

**P12 实时控制与动态变化**：使用单调时钟、有限控制预算、进度检测、方向/位置偏差判断和局部重规划；未知地形不得视为空气。暂停/换目标/断连/观察过期/焦点丢失立即撤销租约并释放输入。单次卡住有恢复预算和临时失败边记录，不能无限重试。验收：障碍插入、过期观察、位置修正、目标CAS变化、停机和模型慢响应时输入行为。

**P13 独立离线身体与局限**：复用已有体素sim body但不调用规划器的可达性函数作为执行真值；至少提供解析几何可核对场景，并标明仍共享的模型假设。固定seed、虚拟时间、延迟和扰动注入。验收：非零z、头部障碍、台阶/边缘unsupported、跳跃可用性限制、偏航与停止。报告只能称模拟控制闭环，不能称真实26.3物理兼容。

### D. 用户控制与 Agent（P14–P18）

**P14 完整 attach CLI**：实现help/status、goal set/show、pause/resume/stop/cancel、chat、executions/effects/events/places/provider、save/quit。命令调用同一ControlService，区分退出CLI和停止Runtime。参数错误不崩服务；断连/重连及状态订阅明确。验收：readline输入驱动真实控制面并核对状态，不能仅解析命令字符串。

**P15 网页完成主工作流**：沿用现有界面，至少覆盖状态/目标与控制、执行/效果、事件、世界/地点、provider与能力配置；展示来源/新鲜度/unknown/ambiguous、真实禁用原因。支持取消、恢复、错误反馈和连接状态。不要以只有五个区域作为缺陷，按功能覆盖验收；不引入冗余页面。验收：每个写操作能观察到服务状态改变，网页不复制业务状态机。

**P16 安全与 SSE 一致性**：完成本地配对、同源Host/Origin策略、CSRF、CLI bearer、SSE授权/断连清理；未提供Origin的非浏览器请求不能借此绕过token。静态路由限制到构建目录，SPA fallback不能吞API错误。快照和事件cursor一致，溢出明确gap并重同步。验收：未经配对、错误来源、过期凭证、目录穿越编码变体、CLI合法访问、cursor replay和重连，不记录凭证。

**P17 Provider 完整多轮与切换**：OpenAI Chat Completions / Anthropic Messages完整规范历史转换、工具ID和顺序、并行工具准入、图像块离线fixture、流取消/截断/非法JSON拒绝。共享retry budget、超时、队列上限、退避；写工具已执行后不可因模型重试而再次执行。切换provider从canonical history重建且保留任务一致性。验收：注入transport记录实际请求，覆盖429/5xx/abort/不完整tool args/切换后的tool结果；网络gate在factory到transport贯通。

**P18 技能与调度收口**：打通现有11技能的生命周期、暂停/取消、前提、进度、partial/ambiguous语义；采集数量不足不能报目标完成，实体消失不等于本玩家拾取，free cell不单独证明动作因果。模型负责任务/工具，不逐tick输入。高优先级人类控制打断旧计划；认证只做有明确观察和策略的有界流程，凭证脱敏；无证据不自动乱发命令。验收：任务中调整目标、部分采集、重复失败预算、工具后再检查abort、认证夹具，不增加全套craft/smelt。

### E. 知识、诊断与交付（P19–P24）

**P19 知识基础接线**：实现版本化source manifest、knowledge release、实际source_version、coverage和查询限额；有证据的小规则可查询，未验证示例单独测试命名空间。规则与经验/空间/现场事实分离；最小工具支持查事实、查来源与覆盖情况。无真实数据不伪造26.3知识量。验收：发布原子切换、查询固定release、缺源unknown、冲突可见；不需要本批实现完整获取超图求解。

**P20 空间与经验记忆**：地点可创建/查询/更新/失效并供return_to_place使用；scope隔离、新鲜度、来源可见。执行经验记录具体前提/失败类别/证据，不能把一次失败改写为世界规则。索引与分页有界，避免全库塞模型。验收：跨重启、跨维度、过期地点、世界重建、错误scope、历史经验不直接授权动作。

**P21 doctor / trace / replay**：doctor读取实际Runtime和Store能力，不返回静态乐观答案。可回放事件/输入意图/效果状态，敏感字段脱敏，大小/保留策略有界。Replay必须禁用真实输入、网络和付费API；不是重发历史side effect。验收：故障trace解释为何停机、导出不含secret、cursor gap、重放无外部派发。

**P22 真正 Playwright E2E**：运行本地服务与网页，用headless浏览器完成配对、设置目标、观察执行、暂停/恢复/取消、效果查看、断线重连；至少一条CLI与网页共同控制同一个Runtime的用例。使用隔离端口/DB、测试结束清理，不截图不录屏。启动失败、浏览器缺失、断言失败必须非零退出；不得恒成功。若环境无法安装浏览器则明确not-run阻塞，仍完成可运行实现；这不是通过。

**P23 故障组合与长期离线验证**：在已有场景上增加跨子进程崩溃、慢observer、IPC背压、DB写失败、目标竞争、provider中断、Motor停机的组合。虚拟时间60分钟场景验证预算/资源上界，短墙钟进程smoke验证真实调度与关闭，不能把虚拟时长当长期稳定证明。使用独立临时目录，无sleep堆时长，低资源串行或有限worker。

**P24 最终一致性与五轮review**：执行REVIEW.md；统一当前文档、配置示例、脚本、能力声明和Node22 CI。保留历史但标明过期。列任务完成证据与限定范围，测试数量只是信息。最终报告不得以“未测真实环境”遮蔽内部未接线，也不得把真实环境未测写成代码通过。CI实际运行结果与本地Node版本分开报告。

## 4. 阻塞分类与完成标准

- 外部数据阻塞：缺26.3实际schema/native/物理或知识来源，只影响相应decoder/数据/真实动作资格。记录来源、缺字段、需要资料；框架、装配、synthetic合同测试仍继续。
- 外部环境阻塞：真实游戏/Windows输入/截图/付费API本批禁止，统一未验证；Node22或浏览器无法实际运行时记录实际错误，不假称CI通过。
- 内部待开发：socket、进程、Motor接线、CLI/Web、恢复、E2E代码等，必须做，不能归入“等调研”。
- 现有研究未证实的数据，只能标候选。获取此前明确指定源码可继续，不能自行开展新一轮网页搜索。

每项状态只用：done-offline、done-limited（清楚列实现范围与验证边界）、blocked-external、not-done。发现部分外部受阻时拆子项，不整项涂绿。最后不得保留没有解释的内部not-done；若任务客观未完要诚实交接，不伪造完成。

实际可复用已有检查命令；至少覆盖typecheck/build/build:web、全部适用离线测试、demo、doctor、TCP fixture、headless E2E与Node22 CI配置。测试命令按仓库真实脚本，不新建同义脚本凑数。最终修改后重跑受影响检查；第五轮结束后做最终标准检查，失败修复后定向回归。

## 5. 不在本批范围

真实服务器互通测试、游戏资产/客户端运行、真实native输入和截图、完整正版登录、战斗/跑酷/游泳/飞行/全地形运动、模型训练、动态生成代码执行、全量Wiki/26.3规则导入、完整合成熔炼生产系统。后两类待现行研究返回后规划，不阻塞本批。

## 6. 禁止留下开放题（用户最新约束）

开发 Agent 不需要再次询问是否做上述功能、是否接Motor、是否做Web/E2E、是否实现socket、是否保持unsupported。以上均已决定。常规模块命名、文件拆分和局部编码方案由开发 Agent 在现有架构内决定并落地，不向用户抛选项。

- codec固定顺序：核实当前锁定数据 → 核实既有研究指定的固定候选 → 对通过来源与schema/native一致性检查的候选做可复现vendor/codegen。都不满足则该26.3域保持unavailable，继续其余任务；不切旧版游戏、不凭空手写未知字段、不要求用户在方案中二选一。
- 导航继续现有有界3D动作图A*，Motor继续既有确定性闭环；不等待算法调研再接线，也不本批更换成MPC或学习策略。未知动作禁用。
- 同存储目录Runtime采用独立、原子、跨进程的所有权锁；复用仓库已有合适实现，否则实现薄层并验证进程竞争。锁不能确认可回收就拒绝第二实例，不删除未知owner锁；CLI/Web通过attach工作。
- 本批知识实现来源/版本/coverage与有界查询，不实现全量数据导入或获取规划器；生产数据缺失返回unknown。研究返回后另行规划扩大功能。
- 五轮全面review由当前Agent连续完成；不要求用户安排五个人，不以等待协同review作为中途停止条件。
- 缺失外部资料以精确补件清单报告，不成为架构选择题；仅遇必须由用户处理的权限、不可安全解决的用户修改冲突或硬边界变更才暂停相关操作。
