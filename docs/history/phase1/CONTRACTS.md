# 本阶段合同定稿与设计勘误

## 1. 证据与身份

BodyContext 包含 serverProfileId、worldGenerationId（可未知）、connectionEpoch、bodyEpoch、dimension；模拟与真实 profile 不可混用。Field 区分 available/unknown/conflict；available 还需 source、kind、freshness、evidenceRefs 和 revision。

sourceKind 增加 simulated。模拟值只能在 simulated bodyContext 内用于执行，不经序列化变成 observed-server。

World State 单写者归并观测；预测、模型推断与历史不能覆盖当前观察。未知不是空气。序号与版本可用字符串表示，避免 JSON 大整数精度丢失。

## 2. 时效与去重

InputPlan 除 commandId/executionId/context/lease/sequence，还必须包含 sourceEpoch、generatedAt、clockDomain、maxAge、observationRef 与本地租约截止时间。

模拟测试共享注入 Clock；生产跨进程不能直接比较单调时间，需要 clock-domain 映射或 challenge 协议。未实现跨进程同步时明确限制为同一时钟域，不能假装支持任意机器。

有效时间受生成年龄、观测年龄和租约共同限制，不能接收时重新延长旧命令。按键状态可覆盖；相对鼠标 delta、点击、文本按 commandId 去重，重复命令不再产生效果。

模型提案 ID 在 Runtime 产生，工具 call ID 只用于供应商会话关联。相同逻辑提案重试返回原 executionId；同 ID 不同参数拒绝。不同 ID 不做盲目的文本相似去重。

## 3. 输入仲裁的具体简化

前一版文档把 keyboard、pointer 与 locomotion、look 混在资源顺序中；实现时不要形成两套重复锁。

采用逻辑资源：movement、view、hands、ui、textEntry。由 backend conflict matrix 映射到实际输入通道。gameplay 模式共享，切换 UI 独占。复合申请一次性准入，等待者不持有部分资源。

Fake backend 必须模拟聊天占用 UI 与键盘，不能因为测试方便而让 navigate 与 textEntry 无约束并发。截图读取可并行；主动打开界面需要执行合同。

## 4. 状态与副作用

Execution 生命周期 queued/running/stopping/verifying/suspended/succeeded/failed/canceled；reason 与 outcome 独立。

Effect 状态 prepared/may-have-dispatched/verifying/confirmed/partial/ambiguous。先持久化允许发送的意图，再执行副作用；崩溃窗口按 may-have-dispatched 处理。SQLite 事务不与外部游戏原子化。

检查点恢复不恢复输入或任意脚本堆栈。新启动全部旧租约无效，先重新观察，再调和 pending effects。恢复器本身是有身份、有预算的执行，不能后台绕过网关。

放置目标态满足可以完成目标，但不一定能确认是本次动作造成；结果归因与目标谓词分开。

## 5. 模型适配

仅 POST /v1/chat/completions 与 Anthropic Messages 协议对应适配器。端点与模型 ID 可配置，密钥从环境变量取得；默认演示不用密钥。

通用模型结果为 text/toolCalls/stopReason/usage。维护供应商调用 ID、内容顺序及工具结果对应关系。支持图片块但不假定所有 model ID 支持视觉；能力配置显式声明。

流式 decoder 按事件边界解析，支持网络 chunk 任意分片、多个工具参数交错、UTF-8 分片与不完整 JSON。完整调用结束后才校验和执行。取消后迟到流数据不能复活提案。

提供方失败不触发游戏动作自动重放。工具结果先由 Runtime 记录，再构建后续模型消息。两个提供方切换使用规范状态，不互传私有历史格式。

生产适配器通过注入 transport 可真实使用，但本阶段仅 mock/fixture 验证，不宣称与线上所有模型兼容。复杂未支持的专有响应块显式报告 unsupported，禁止静默当作成功工具调用。

## 6. 日志与容量

配置、错误、请求/响应日志均经过脱敏。不得记录 API Key、认证密码或敏感文本输入。模型可见文本与工具证据可归档，不索要隐藏思维链。

事件 ring buffer 有上限，cursor 超出保留范围返回 gap。关键持久事件不因环形缓存覆盖而丢失。磁盘错误不能伪报 durable。

## 7. 演示是集成代码，不是另一套脚本

demo 使用同一 ToolRouter、Executor、WorldState、Gateway 和 SQLiteStore。ScriptedModelProvider 只替代模型输出，FakeClientBridge 只替代游戏边界；不能为 demo 直接修改任务状态或跳过网关。
