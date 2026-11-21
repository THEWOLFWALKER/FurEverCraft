# FurEverCraft L1：增量架构与责任边界

v0.3 · 2026-10-24 · 设计已确定，主体迁移待实施。基线 `17cdf063cd8b97af8d7a8d7094116870e11fdd1e`。

本组三层文件是下一批实施目标，不是当前能力声明。L2见[合同](minecraft-agent-client-bridge-contracts-v0.3.md)，L3见[控制与恢复](minecraft-agent-motion-navigation-recovery-v0.3.md)，执行顺序见[迁移交付](v0.3-implementation-handoff.md)。v0.2保留历史；与本组三层无冲突的产品边界继续适用。

## 1. 保留与目标

目标仍是普通原版Java玩家长期自主活动。唯一原版客户端，无Mod/注入/内存读取/服务端遥测/第二个bot。结构化观察优先，真实截图按需；模型OpenAI Chat Completions与Anthropic Messages；CLI和网页共同控制一个Runtime；Windows输入，Node22 Runtime；当前真实游戏目标26.3，不自动追latest。正版认证、生成代码执行、高级战斗与全地形控制继续留后续。

不重建工程、不重写历史。远端main与Round2分支同指17cdf06；P01–P23与P22分支都是祖先恢复点，无待合并分叉。保留现有TypeScript、SQLite、Executor、InputArbiter、MotionController、Provider、Fastify/SSE/React、relay/observer和测试。只重构失效的责任边界，不复制第二套Runtime或动作框架。

本轮预实现已覆盖通用framing、四模块兼容注册/解码合同、BridgeService控制资格以及Runtime异步停机；其余本文标为目标设计。预实现已接现有入口，但不是全部架构迁移。不得凭文档更新宣布61项已修或P24完成。

## 2. 已查明根因与唯一责任

| 现状 | 根因 | 目标唯一责任 |
|---|---|---|
| Router从dispatch进度事件写派发屏障 | 遥测承担正确性 | ActionGateway负责动作授权与持久屏障；report只记录进度 |
| degraded、admission、revoked分别变化 | 同一控制资格多处维护 | ControlAuthority计算资格、撤销generation；BridgeService提供健康事实 |
| lifecycle和executor均解释成功 | 工作结束与游戏效果混合 | Executor独占执行终态；EffectCoordinator独占效果调和；Lifecycle只管技能阶段 |
| 2D bridge、3D BodyAdapter、Symbol附件共同承载身体 | 旧实现泄漏到生产 | Runtime注入显式BodyPort；legacy只在legacy composition |
| snapshot blocked即confirmed | 满足目标与本人因果混淆 | 两轴结果，未知因果不晋升 |
| 测试与压缩实现同用错误格式 | 缺独立外部判据 | 标准字节、独立几何、入口故障三层证据 |
| scope冻结、Clock局部重建 | 生命周期边界不显式 | ContextProvider和TimeServices统一注入，执行捕获快照 |

协议adapter不拥有动作权；Motor不拥有execution/effect状态写权限；Router不持有raw driver。长时模型请求、SQLite批量导入与解压不得阻塞控制循环。SQLite保持唯一写owner；诊断只读连接不迁移。

## 3. 主通路

```text
CLI / Web -> ControlService -> Goal / canonical AgentLoop
                                  -> Executor -> SkillLifecycle / Skill
                                                  -> Navigation / Motor
                                                  -> ActionGateway -> InputArbiter -> InputDriver
                                                           |                 -> real client
                                                    EffectCoordinator
real client <-> raw TCP relay <-> configured server         |
                      -> bounded observer -> ProtocolAdapter -> canonical events
                                                               -> WorldState / LocalControlView
versioned GameDataPack / GeometryProfile -> knowledge / navigation / verification
```

每个执行捕获context，异步返回后重新核对。输入驱动只接受由ActionGateway生成的封闭命令；helper验证owner、generation、epoch、deadline。控制故障先同步关本地资格，再异步通知helper释放；父进程故障由helper独立watchdog处理。不能保证跨OS调度/焦点切换的零时间竞态，报告实际证据与剩余不确定性。

## 4. 可插拔版本组成

| 模块 | 拥有 | 不拥有 |
|---|---|---|
| ProtocolAdapter | direction/phase下packet schema与native依赖，控制事件识别、数字ID与registry绑定、规范事件 | 网络身份、自动控制包回复、系统输入 |
| GameDataPack | 配方、tags、默认组件、注册表、source_version、coverage、release | 现场背包/容器/服务器自定义规则事实 |
| GeometryPhysicsProfile | 状态映射、碰撞/交互形状、运动支持范围、继承来源 | 危险未知场景的保证 |
| ClientControlProfile | 游戏输入模式、动作绑定、校准要求、兼容证据 | OS实现、直接派发 |
| InputDriver | OS事件、焦点/窗口身份、实际held state、独立期限 | 世界成功判断、导航 |
| ModelProvider | API序列化/流/usage/错误 | 独立业务历史、执行去重规则 |
| RoutePlanner | 有界搜索、候选动作与前提 | 键鼠或effect更新 |
| PrimitiveController | 观察反馈、短输入意图 | 绕过网关写入或证明模拟物理真实 |

首期项目内静态注册，build时依赖；不自动扫描目录加载代码、不做远程插件市场或沙箱框架。AdapterRegistry显式注册一个26.3 bundle及测试用两个synthetic bundle。领域合同版本独立于游戏版本；major不兼容拒绝装配，允许的minor兼容由注册迁移器和合同测试证明，不凭semver字符串推断。

bundle由4类模块引用+哈希组成，一个模块可被多个bundle共享。元信息、协议能力、数据完整性、输入校准分别验证。`minecraftData('26.3')`返回非空不构成支持证明。manifest记录实现可用/证据/覆盖，当前资格还取决于身体观察、gate、焦点和租约，禁止一个supported布尔值代表全部。

## 5. 版本切换与生命周期

游戏版本选择：配置指定bundle -> 读取握手版号 -> 一致才绑定LOGIN身体；未知版可以保留显式手动转发但不自主解释。STATUS独立，不作为身体。每连接独立observer状态；同一Runtime最多一个LOGIN身体，新LOGIN不得抢占，先显式结束旧身体并确认资源退出。relay允许同时8个连接供有界状态查询，最多1个LOGIN；超额在创建upstream前拒绝，超时/背压预算沿用现有配置。

加密协商使旁路无法观察时保留透传并撤销相应自主能力，不MITM也不自动转视觉主控。首次握手host/port映射是唯一允许的显式字节改写；不跨版本翻译游戏包。

热替换：Provider在旧请求取消且工具历史闭合后切换；知识release原子激活，单查询/规划锁定release。协议、物理和输入profile切换必须结束身体会话、撤权、释放、清空连接缓存再装配。旧pending保留原bundle供历史核对，不因版本变化自动重放。

shutdown：关闭资格 -> abort规划/执行 -> 等待有限结算及释放 -> observer/relay/helper退出或确认结束 -> flush存储 -> close -> release owner。`close(): Promise<ShutdownReport>`幂等共享Promise；CLI退出attach和关闭Runtime不同。不能确认残余输入/子进程已退出时记录control-uncertain，禁止同存储新owner接管控制，见L2。

## 6. 研发防复发规则

新增功能按一条完整垂直链验收：正常、失败、取消、崩溃恢复，再扩数量。模块存在不算接线；方法存在不算能力；接受不算效果。迁移每个入口立即移除它原来的派发/状态写路径，不长期双写。

三类检查必须独立：外部规范样本、各adapter共享合同套件、公开CLI/Web/工具入口故障注入。禁止planner/预测器与sim body共享相同核心作为唯一正确性证据。静态依赖测试限制版本实现、原始输入、SQL写权限的导入方向。

本批不重新开启五轮全仓审查：保留历史Round1–2与外部61项，完成逐项处置、合同检查、集成故障检查、最终差异检查。未核实前提不能记fixed；not-run不能记pass。用户会协同review，开发无需在每个小阶段等待许可。

## 7. 控制台视觉合同

采用用户提供的frontend-design-style：蓝白、克制、工具型界面，复用现有tokens和React结构。主宽1200px，820/560断点，指标窄屏两列；系统字体、轻边框、分级圆角和低阴影。主信息回答当前状态/原因/更新时间，字段证据可展开；不添加营销画面、假统计或外部字体。

运行中灰黄、成功绿、失败红；禁用/未知中性，不按错误染红。未知计数为—，已加载空集合才为0，读取失败保留旧值并提示可能过时。每个输入有label，行选择可键盘操作，有skip link、focus-visible、40px触控目标、reduced-motion与停止确认。

代码已调整，web TypeScript/构建和展示逻辑单测已执行；未启动浏览器，360/768/1024实际布局及视觉验收待用户或后续有条件环境核对。CSS断点存在不等于真实视口检查通过。
