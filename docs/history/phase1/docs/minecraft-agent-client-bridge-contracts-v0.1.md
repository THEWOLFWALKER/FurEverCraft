# Minecraft Agent：客户端接入与核心合同细化

版本：v0.1 · 日期：2026-10-17  
上位设计：[顶层设计 v0.1](minecraft-agent-top-level-design-v0.1.md)  
状态：设计规格，未开展客户端、协议或服务器实测

后续细化：[动作原语、导航与恢复](minecraft-agent-motion-navigation-recovery-v0.1.md)。其中第 8.2 节补充命令传输年龄与重复鼠标增量处理，约束下方简化的 InputPlan 示例。

## 1. 本轮决定与边界

本轮细化 Client Bridge、字段来源、World State 核心类型、执行协议以及模型工具循环。不开启源码实现，不下载依赖，不自行检索外部资料。

保留已确认约束：真实 Java 客户端、普通玩家权限、无客户端 Mod、无服务端改造、结构化优先、按需截图、OpenAI Chat Completions 与 Anthropic Messages。协议观察代理仍是待验证候选，不是用户已经选定的部署方式。

核心决定：

1. 将结构化证据采集与动作输入分离，使用同一个身体会话关联。
2. 把协议旁路解析失败与连接转发失败分开处理；观察器不能随意改写客户端流量。
3. 本地输入网关独立维护租约与释放状态，模型和技能不能直接调用系统输入。
4. 按字段声明来源和可靠性；能力不足时拒绝依赖该字段的技能，不补假数据。
5. 模型只看到精简工具参数；身份、权限、租约和代次由 Runtime 注入，不由模型自报。
6. 工具读取默认无副作用；打开背包、打开聊天栏等主动观察属于可取消执行。

## 2. Client Bridge 的组成

```text
真实客户端 → 本地传输中继 → 目标服务器
                 │ 双向流量副本，观察模式
                 ▼
          版本化协议解码器
                 ▼
日志适配器 → 证据归一化 → World State
画面采集器 ──────┘

Runtime → 执行协调器 → 输入网关 → 系统输入 → 真实客户端
                           ↑
                  窗口状态与本地看门狗
```

这里的中继是单个客户端会话的转发，不是让 Mineflayer 另开一个玩家连接。到服务器的游戏消息仍由真实客户端产生。

### 2.1 观察代理验证原则

- 客户端可配置连接本地端点，中继连接实际服务器；握手中的目标地址、端口、虚拟主机路由等需要显式保留或受控处理，不能假定字节透传总能完成路由。
- 网络分片不是消息边界。解码器必须正确处理协议阶段、帧长、压缩变化、包组合与拆分；不能逐 TCP 数据块直接解析为一个游戏包。
- 转发路径与解析路径隔离，副本队列有界。解析积压不能无限阻塞游戏连接。
- 如果副本发生缺口，标记对应证据流不完整，禁止继续把增量状态作为完整快照。转发可以继续，Agent 的依赖能力暂停。
- 一旦协议变为当前桥无法解码的加密流，声明不可观察；不假定能从旁路获得密钥。正版登录未来需要重新验证此边界。
- 解码器崩溃可保留透明转发；中继进程退出仍可能导致游戏断线，不能把它描述成完全无故障影响。
- 启动时锁定实际协议版本与解码器版本；未知包是否允许跳过，取决于能否确定它不影响关键状态。无法判断则降级相应能力。
- 目标服务器地址、账号档案和代理会话分别记录，不能因客户端连 localhost 而把所有世界归为同一个服务器。

是否安装中继、如何启动真实客户端及输入后端如何选型，需要目标操作系统和 Minecraft 版本。当前只定义合同。

### 2.2 输入网关

输入网关拥有 Agent 产生的按键、鼠标按钮和相对鼠标移动。协议解析模块不发送游戏动作，日志模块也不执行快捷键。

网关状态：DISABLED、READY、ACTIVE、RELEASING、CONTROL_UNCERTAIN、FAULTED。

READY 条件包括：绑定窗口仍存在、身体会话匹配、输入后端健康、当前交互上下文允许操作。窗口在前台不证明客户端已处理输入，系统调用成功也不等于游戏动作成功。

持续按键用“期望按键集合 + 有限租约”表达，而不是无限持续的 keyDown。网关维护实际已注入集合，并在租约到期时释放自身持有的输入。离散点击和文本输入使用单独的受控事务。

焦点丢失、窗口关闭、会话变化时立即撤销新输入权限，尽力释放已注入输入。无法证实释放时进入 CONTROL_UNCERTAIN，恢复后先完成清理；不声称操作系统冻结时仍能保证释放。

用户若直接操作游戏窗口，输入可能与 Agent 冲突。可检测时进入人工活动暂停态；检测不到时也不能保证本地没有外部写入。项目默认的人类介入方式仍是控制台消息。

## 3. 结构化字段来源矩阵

以下是候选来源，必须按目标版本实测。S→C 为服务器发往客户端；C→S 为客户端发往服务器。接收到协议数据不自动赋予所有决策用途。

| 字段 | 候选来源 | 能说明什么 | 不能保证什么 / 失效条件 |
|---|---|---|---|
| 连接与协议阶段 | 中继连接、协议解码 | 当前连接状态与阶段 | 已认证、已进入可操作世界 |
| 位置与朝向 | C→S 移动报告、S→C 修正 | 客户端报告和服务端修正证据 | 逐帧服务器权威位置；无更新不证明未移动 |
| 速度 | 连续位置报告差分，必要时速度相关事件 | 有误差的运动估计 | 原版内部完整物理速度；网络到达间隔不是模拟步长 |
| 接地 | 目标版本的客户端报告、局部支撑推断 | 客户端声明与几何证据 | 服务器确认接地；两者冲突须保留 |
| 生命、食物 | S→C 状态更新 | 最近下发值 | 未收到初始值时完整可用；断线后仍当前 |
| 氧气、游泳姿态 | 版本相关元数据、流体几何推断、按需 HUD | 来源明确时可用于模式判断 | 所有字段一定下发给本地玩家；不得先假定可得 |
| 方块与区块 | S→C 区块、变化、卸载 | 已下发缓存与变化 | 可见性、原始地形真值、未知区块为空气 |
| 实体 | S→C 生成、运动、属性、移除 | 客户端接收的实体轨迹 | 实体当前可见、跨会话 ID 稳定 |
| 背包 | S→C 槽位、内容更新 | 已同步槽位 | 更新缺口后仍完整；本地操作预测已获确认 |
| 当前容器 | 打开、槽位、关闭相关消息 | 协议窗口上下文 | 当前屏幕和光标位置；玩家背包界面不一定有远端打开事件 |
| 手持槽位 | C→S 选择消息及版本相关更新 | 最近报告的选择 | 使用行为已生效 |
| 挖掘/放置意图 | C→S 交互消息 | 客户端确实提交了某请求 | 服务器执行成功、结果归因唯一 |
| 聊天 | 双向聊天与系统消息 | 发送请求、收到内容及可得来源元数据 | 其他玩家已收到；系统消息绝不会被插件伪造 |
| 界面模式 | 执行器预期、窗口事件、按需截图 | 预期/观察到的界面 | 仅靠按过 E 或 T 就确认 UI 已打开 |
| 焦点与窗口 | OS 窗口 API | 前台、窗口身份与尺寸 | 游戏鼠标捕获、画面实际渲染健康 |
| 游戏 tick | 可得版本事件、估计 | 若有则提供明确来源 | 通用精确客户端 tick 或服务器 tick |

### 3.1 最低能力组合

不追求一开始读全所有字段，而按技能声明要求：

- `ground_navigation`：位置/朝向报告、局部有效几何、输入能力、会话有效。
- `jump`：上述条件，加起始支撑、速度范围估计、落脚区与相应控制器验证。
- `water_recovery`：流体模式证据、上方空间、输入能力；缺少氧气字段时不能宣称可精确规划剩余潜水时间。
- `inventory_transfer`：完整目标窗口与槽位证据，加经验证的 UI 输入映射；只知道物品 ID 不足以正确点击。
- `chat`：UI 模式确认、文本输入能力、发送队列；无需为了普通回复进行整张场景截图。

缺少界面坐标映射时，通过一次主动观察建立当前分辨率、GUI 缩放和布局的映射。窗口尺寸、界面类型或资源包相关布局改变时使其失效，不能沿用旧像素坐标。

## 4. 观测、可见性与时间

### 4.1 World State 核心类型（概念 TypeScript）

```ts
type EvidenceKind = 'observed' | 'client_reported' | 'predicted'
  | 'inferred' | 'historical';

interface BodyContext {
  serverProfileId: string;
  worldGenerationId: string | null;
  worldIdentityStatus: 'unresolved' | 'provisional' | 'resolved';
  connectionEpoch: string;
  bodyEpoch: string;
  dimension: string | null;
}

interface EvidenceStamp {
  sourceId: string;
  sourceEpoch: string;       // 解释序号和时钟的作用域
  sequence: string;          // 十进制序号，避免 JSON 整数精度问题
  capturedMonoNs?: string;
  receivedMonoNs: string;
  clockDomain: string;
  capturedWallTime?: string;
  clientTick?: string;
  timingUncertaintyMs?: number;
}

type Field<T> =
  | { status: 'available'; value: T; kind: EvidenceKind;
      evidenceIds: string[]; revision: string; stamp: EvidenceStamp;
      freshness: 'current' | 'stale'; permittedUses: string[] }
  | { status: 'unknown'; reason: string; lastEvidenceIds?: string[] }
  | { status: 'conflict'; evidenceIds: string[]; reason: string };

interface SnapshotRef {
  id: string;
  context: BodyContext;
  stateRevision: string;
  completeness: 'complete-for-query' | 'partial';
  gaps: string[];
}
```

这是领域合同草案，不是上游库类型声明。当前快照 ID 由 Runtime 分配并可解析；模型不能自造一个版本号使动作通过校验。

### 4.2 时钟规则

- 每个 sourceEpoch 内序号单调；重启换 epoch。
- 不直接比较不同进程的单调时间。跨进程通过握手估计时钟偏移范围，或由接收方计算本地期限；消息携带有效时长与来源时钟域。
- 墙钟用于展示与持久记录，单调时钟用于当前进程超时。
- 帧关联采集时间区间与最近的状态版本，不能以收到图片的时间冒充画面发生时间。
- 增量流缺口使依赖投影失效。没有完整重新同步途径时，等待自然重发、受控重新打开界面或重连，不编造“刷新所有服务器状态”工具。

### 4.3 信息使用边界

区块已下发、表面暴露、视线可达、当前相机可见是不同概念。对可见性建立可替换判定模块，输入位置、朝向、相机参数、遮挡几何及其不确定性。

可见性算法只能产生带误差的证据，不把其结果当实际渲染的完美替身。未知相机姿态或时序冲突时，不暴露隐藏资源身份；需要时请求截图确认。

原始协议缓冲不直接提供给模型或语义检索。导航、资源发现和物理估计使用不同用途投影。实际看见过的地点可存历史记录，后续返回必须带 observedAt 和 revalidationRequired。

## 5. Bridge 能力与协议合同

### 5.1 CapabilityDescriptor

```ts
interface CapabilityDescriptor {
  id: string;
  contractVersion: string;
  implementationVersion: string;
  availability: 'available' | 'degraded' | 'unavailable' | 'unverified';
  evidenceSources: string[];
  dependencies: string[];
  limitations: string[];
  testedProfiles: string[];
}
```

声明能力不等于启用全部技能。能力变化通过事件发布，执行协调器重新检查正在运行的依赖。

### 5.2 消息类别

| 消息 | 处理策略 |
|---|---|
| connection/body/lease 变更 | 有序处理；丢失时拒绝继续执行并重新握手 |
| 方块、窗口、背包增量 | 不静默丢弃；缺口使相应视图失效 |
| 位置和朝向样本 | 控制读取可取最新，诊断可采样；覆盖旧样本时保留时间信息 |
| 截图 | 有界最新帧队列，任务要求的帧单独保留 |
| 控制设定 | 按资源序号取最新有效项，不能积压旧按键 |
| 离散交互 | 不合并，逐项 admission、提交、核对 |
| 事件订阅 | 带 cursor；历史已过保留窗口返回 gap，而不是返回空列表假装无事发生 |

### 5.3 输入计划

输入网关接收经过 Runtime 授权的计划：

```ts
interface InputPlan {
  commandId: string;
  executionId: string;
  context: BodyContext;
  leaseRefs: Array<{ resource: string; leaseId: string; generation: string }>;
  sequence: string;
  validForMs: number;             // 本地截止时间还须受发送年龄、观测年龄和租约限制
  snapshotRef: string;
  expectedMode: 'gameplay' | 'chat' | 'inventory' | 'menu';
  controls: {
    heldKeys: string[];
    heldMouseButtons: number[];
    mouseDelta?: { x: number; y: number };
  };
}
```

输入允许集合、最大期限与鼠标幅度由已验证的后端策略裁剪。相对鼠标 delta 不等于 yaw/pitch；需校准灵敏度、反转、鼠标加速与捕获方式，并以可得朝向反馈闭环。

文本输入单独使用 TextEntry 执行，不把密码或聊天展开成可记录的普通 InputPlan。按键绑定是后端配置，不把 W、E、T 等常见默认键永久写入领域技能。

## 6. 执行合同与副作用

### 6.1 三种身份

- `proposalId`：一次模型或系统提案。
- `executionId`：Runtime 接受的技能执行实例。
- `effectId`：可能改变世界或发送消息的副作用记录。

模型供应商 tool call ID 仅用于回复该轮工具消息，不充当跨重试的执行身份。

### 6.2 准入与运行结果

```ts
type Admission =
  | { status: 'accepted'; executionId: string; eventCursor: string }
  | { status: 'already-accepted'; executionId: string }
  | { status: 'rejected'; code: string; missingCapabilities?: string[];
      evidenceIds?: string[]; retryAfterMs?: number };

interface ExecutionRecord {
  executionId: string;
  skillId: string;
  skillVersion: string;
  lifecycle: 'queued' | 'running' | 'stopping' | 'verifying'
    | 'suspended' | 'succeeded' | 'failed' | 'canceled';
  reason?: string;
  outcome: 'not-dispatched' | 'observed-applied' | 'partial'
    | 'observed-not-applied' | 'ambiguous' | 'not-applicable';
  evidenceIds: string[];
  pendingEffectIds: string[];
}
```

取消执行与结果核对独立：允许 lifecycle=canceled 且仍有 ambiguous effect。不能因已经取消就删除未决账本。

### 6.3 键鼠后端的资源冲突

资源顺序固定，复合申请一次性准入：`ui-mode → keyboard → pointer → locomotion → look → hands → interaction`。这是一套初始冲突域，不是所有技能必须同时锁住全部资源。

| 行为 | 典型资源与规则 |
|---|---|
| 地面导航 | gameplay 模式、键盘运动控制；转向时占视角/鼠标 |
| 挖掘 | 视角、手持物、鼠标交互；移动是否兼容由技能明确声明 |
| 聊天 | 独占 UI 模式和文本输入；先停止不兼容移动，再打开聊天栏 |
| 容器操作 | 独占 UI 模式、指针与槽位操作；窗口版本改变后重新核验 |
| 截图 | 被动采集不占身体；若要转头或打开界面，则是主动观察执行 |

内部资源模型可用共享 gameplay 模式租约与独占 UI 切换租约实现，不允许两个拥有不同资源名的技能实际写同一个物理键。

### 6.4 本地去重与世界结果

相同 proposalId + 相同规范参数返回同一 executionId；相同 ID 参数不同则拒绝。模型 API 重试沿用同一个逻辑决策身份，并检查已接受提案。

不同提案表达相同目标不能仅靠字符串相似度自动去重。执行协调器检查当前任务是否已有等价运行实例，必要时要求模型选择继续、替换或新建。

副作用证据分离“目标现在满足”和“这次动作被证实产生效果”。其他玩家放置目标方块时，建造子目标可能完成，但不能据此扣除本次预计材料或宣称动作已确认。

## 7. 模型工具接口第一版

### 7.1 通用返回格式

```json
{
  "ok": true,
  "result": {},
  "snapshot_ref": "snapshot-...",
  "evidence_refs": [],
  "unknowns": [],
  "warnings": [],
  "next_cursor": null
}
```

失败返回稳定 code、事实原因和可用替代，不只返回异常堆栈。未知是有效查询结果，不一定是工具错误。

### 7.2 工具与语义

| 工具 | 模型参数 | 结果及副作用 |
|---|---|---|
| `get_state` | fields、detail | 当前快照；不会自动打开界面或截图 |
| `query_local_world` | 范围、对象类型、用途 | 经过用途过滤的局部证据，不返回原始区块 |
| `get_inventory` | scope | 已有背包证据、完整性与窗口信息；不主动打开背包 |
| `capture_view` | purpose、detail | 真实帧引用与时间信息；采集敏感输入阶段受限 |
| `start_observation` | 已注册观察类型、参数 | 主动打开界面、转头等观察技能，返回 executionId |
| `find_skills` | 目标、限制 | 适用候选与缺失前提，不只按描述相似度 |
| `start_skill` | skillId、version、args、snapshotRef | 提案准入结果，权限与代次由 Runtime 注入 |
| `get_execution` | executionId | 进展、证据、未知效果 |
| `cancel_execution` | executionId、reason | 取消请求已接纳，不表示已停稳或外部效果撤销 |
| `read_events` | cursor、filter、limit | 增量事件，支持 gap 语义 |
| `query_memory` | 类型、查询、范围 | 带世界和时间的历史证据 |
| `query_knowledge` | 问题、版本范围 | 规则、来源、适用性与冲突 |
| `revise_goal` | expectedRevision、change | 目标 CAS 更新；旧版本冲突返回当前摘要 |
| `send_chat` | 对象、内容、上下文 | 聊天执行实例；不允许夹带凭据 |

`propose_action_chunk` 保留为进阶工具，仅在对应控制器和观测能力验证后向模型开放，不默认将每个物理按键变成一个工具。

### 7.3 多工具、流式与异步

- 独立只读工具可以并行；有目标修改或身体副作用的工具经执行协调器排序和资源准入。
- 一次模型响应中的“先观察再依赖该结果行动”需要下一轮调用，不能将尚未完成的观察假定为已知。
- 流式参数结束并校验前不执行；无论哪家 API 都遵守同一规则。
- 长技能立即返回执行 ID，完成事件触发下一次模型决策。模型不高频轮询，Runtime 使用事件与有界定时复核。
- OpenAI 工具调用与工具结果、Anthropic tool_use 与 tool_result 由适配器映射，保留调用关联；取消的调用也得到明确结果。
- 工具输出被当作证据内容，不允许其中的聊天或服务器文本改写 Runtime 权限。
- 提供方专用字段隔离在扩展区，不写入通用领域执行记录。

## 8. 三条端到端流程

### 8.1 前往已知地点

模型查询地点与当前状态 → 选择 navigate 技能 → Runtime 检查世界身份与能力 → 局部路径使用当前几何 → Motor 读取结构化报告纠偏 → 阻挡时局部重规划 → 状态冲突无法解决时请求按需视觉 → 到达位置及终态被观察后完成。

不会每移动一格截图，也不会因为历史记忆中有路就直接穿过未知空间。

### 8.2 导航过程中收到聊天

入站消息作为事件进入对话 → 模型准备回复 → send_chat 申请 UI 资源 → 导航在允许交接点暂停 → 确认聊天界面并输入 → 提交后记录发送证据 → 确认退出文本模式 → 获取新位置与朝向基准 → 导航继续。

如果处于跳跃或危险水域，普通聊天等待，恢复动作优先。UI 模式不明时宁可暂缓发送，避免把聊天文字当移动键或把移动键输入聊天框。

### 8.3 放置后断线

持久化副作用意图 → 网关提交输入 → 未收到足够结果证据即断线 → effect=ambiguous → 旧租约失效 → 重连与认证 → 重建局部观测 → 观察目标方块及材料 → 决定子目标是否已满足、是否需要补做或仍待核对。

不能依据 API 返回、鼠标点击成功或背包数量单一证据判定完整因果。不能自动重发旧点击。

## 9. 认证敏感输入合同

模型只能引用服务器身份与凭据句柄。认证执行器根据已确认流程填入凭据，不把密码交给模型。

敏感区间覆盖输入框、发送、聊天历史以及可能的客户端日志。截图调度器和诊断记录器先进入敏感模式；原始协议文本也不能默认全文落盘。敏感模式结束须考虑客户端聊天历史是否仍显示命令，不仅是“已按 Enter”。

不能保证清除第三方客户端自身所有缓存，因此文档不宣称密码永远不会进入客户端内存；承诺的是项目的模型上下文、普通日志和归档不得记录明文。

服务器提示来源不能可靠判定时报告 AUTH_FLOW_AMBIGUOUS。游戏连接成功、认证成功、可正常活动分别确认。

## 10. 判别实验与验收记录

本轮只规定实验，不声称已运行。不要求在目标服务器安装测试插件；若将来使用自建测试环境的服务端日志，只作独立评测标签，不能接入 Agent 决策。

| 编号 | 实验 | 要记录的结果 / 通过条件 |
|---|---|---|
| B01 | 单客户端经过中继连接 | 同一角色正常进入；登录、配置、压缩阶段正确；无第二玩家 |
| B02 | 每种关键协议字段 | 记录实包语义、版本、初始完整性；缺项如实标 unknown |
| B03 | 副本队列溢出/解码器退出 | 转发与观察故障分开；缺口可见；依赖能力暂停 |
| B04 | 焦点丢失与窗口关闭 | 不向其他窗口继续注入新输入；释放结果可追踪 |
| B05 | 鼠标灵敏度与 UI 缩放变化 | 旧校准失效；不会继续按旧坐标点击 |
| B06 | 普通移动、跳跃和服务器修正 | 本地报告与修正分开；旧轨迹失效并重新建立基准 |
| B07 | 背包与容器操作 | 当前窗口、槽位完整性及 GUI 映射一致；异常无盲重试 |
| B08 | 同一提案重复提交 | 返回相同 executionId；同 ID 不同参数拒绝 |
| B09 | 取消后迟到输出与清理 | 旧代不能写输入，旧 finally 不释放新租约 |
| B10 | API 超时和双提供方切换 | 已提交执行不重复；从规范上下文继续 |
| B11 | 敏感认证流程 | 模型、普通日志和轨迹不含凭据；截图受控 |
| B12 | 长期结构化优先运行 | 统计截图原因/频率、主动 UI 观察、缺失字段和失败；不能靠隐藏的逐帧视觉循环伪装通过 |

每次实验记录客户端/协议/OS/输入后端版本、条件、样本数、证据路径、实际结果和限制。延迟记录分位数，成功率有分母；目标阈值根据具体动作期限制定。

判别结果分为：

- GO：结构化字段、输入和会话关联足以支撑约定技能集，进入实现。
- CONDITIONAL：仅部分技能可用，列明不可用能力，继续独立模块设计。
- BLOCKED：无法满足结构化优先且无 Mod 的核心条件，呈现替代方案，不静默变更用户要求。

## 11. 待确认项与下一步

进入接入原型前需要：目标操作系统、Minecraft 客户端/服务器版本，以及是否愿意把客户端连接地址指向本地观察中继。最后一项是部署选择，目前未视为已确认。

这些信息不阻塞合同设计；不需要再次提供论文，也不需要先提供账号密码或 API Key。接入原型才需要真实环境参数。

下一份设计应细化动作原语、导航能力注册、进展检测、资源交接与恢复状态机，并沿用本文件的证据与执行合同。之后再落实持久化表和代码目录，避免在身体边界尚未验证时围绕某个库固化业务。
