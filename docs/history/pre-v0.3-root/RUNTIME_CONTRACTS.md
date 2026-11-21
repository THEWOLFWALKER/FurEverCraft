# 执行、模型、存储与自主循环合同

## 1. 必须补齐的遗留能力

上一阶段的五项技能、效果账本、控制台、事件游标、脱敏及故障测试全部是本阶段必做。每项在 PROGRESS 和报告写对应代码与测试，不能再次统称“后续补强”。

## 2. 执行与控制

Execution 生命周期：queued/running/stopping/verifying/suspended/succeeded/failed/canceled。reason 与 outcome 独立；取消可以结束执行但 pending effect 继续核对。

控制 epoch 包括 connection/body/resource generation；每个资源单独持有 owner，不因聊天改权使无关观察无效。输入最后提交再次校验 lease、命令生成时间、观测年龄、UI 模式与上下文。

正常交接旧 owner 只能完成有界交接动作；紧急接管先撤旧代，新恢复实例获得控制权。旧 finally 不得全局释放新 owner 的输入。

setHeldInputs 是状态设定，mouse delta/click/text 是不可盲重放事件；命令 ID 去重。只有在当前 context 和 input backend 恢复检查后才允许续行。

## 3. 五项技能

- navigate_to：模拟四邻接 A*，路径依赖、进展窗口、动态障碍、冷却、取消与重算预算；生产 profile 不把模拟物理输出当通用三维技能。
- observe_ui：主动观察开/关 UI 的执行，期望状态不等于已观察状态；无能力则明确拒绝。
- send_chat：收件/内容/上下文、UI 独占、text-entry、提交后发送结果与目标收件确认分离；禁止自动重发不确定消息。
- place_one：验证目标/物品/资源，durable intent 后再输入，结果缺失进入 ambiguous，恢复后核对，不重复消耗。
- wait_for_condition：有限等待、订阅事件、可取消，事件缺口有处理，不忙轮询不阻塞其他执行。

技能 manifest 固定版本、参数 schema、能力、资源、前提、进展、终态和取消策略。注册表读写和运行版本冻结可测试。

## 4. 持久恢复

Store transaction 原子写执行状态与事件/必要意图，动作发送不与数据库原子化。崩溃注入点覆盖 prepared、may-have-dispatched、observed-before-checkpoint。

恢复创建新 Runtime 和租约代次，从 SQLite 读取 pending effects/目标/检查点；外部 fake world 状态单独保留，不随 Runtime 回滚。只阻塞依赖未决效果的动作，不阻止独立避险与查询。

提案规范 hash 和 ID 持久化，跨进程同提案返回原实例。同 commandId 不二次点击。去重记录有作用域及保留策略，pending effects 关联记录不提前删除。

## 5. 事件与内存

EventHub 有单调 cursor、有界内存和 durable 关键事件。超出内存历史返回 gap 与可用范围；支持使用持久关键事件补查，不伪装完整逐帧历史。

places 保存世界/维度、坐标、来源、lastVerified、validity。episodes 保存任务、事件引用和事实摘要。查询先世界过滤，再关键词/时间；不引入向量库。

知识只实现版本化规则条目读取，不实现自动知识改写。历史不能写回当前状态。

## 6. 模型与工具

完整工具集：get_state、get_inventory、query_local_world、capture_view、find_skills、start_skill、get_execution、cancel_execution、read_events、revise_goal、send_chat、query_memory、query_knowledge。

工具路由注入身份/租约上下文，不让模型自己填写 ownerGeneration。结构化读取不暗中截图或操作 UI。capture_view 仅在显式请求时执行，模拟图片注明 synthetic。

stream decoder 处理 UTF-8 分片、SSE 边界、工具参数增量、同轮多工具交错、stop/error/cancel。完整参数结束且 schema 成功后才提交；即使流最后报错，也不能自动重新执行已入账工具。

模型队列有优先级、费用/token/call 限额、取消与去重。有限只读并行，写入串行准入。工具错误返回稳定 code 和证据，不把原始聊天内容视为系统指令。

提供方切换从规范消息与执行状态重建上下文，不混用 OpenAI tool message 与 Anthropic tool_result 格式。所有生产请求经注入 transport，有 allowModelNetwork 门禁；无 Key 时 doctor 说明缺少凭据，离线演示仍正常。

自主循环按目标/事件/周期兜底运行，不是固定脚本单次执行。ScriptedProvider 只替代模型输出，不直接修改状态。控制台改向后旧模型输出依据目标 revision 拒绝；已有有效技能按取消合同退出。

## 7. 控制台语义

pause 等待有界交接，不停止世界；resume 先检查当前状态；stop 紧急撤权并进入恢复/控制丢失状态。quit 释放输入、结束模型请求、持久化检查点、关闭数据库和 helper；未决副作用保持未知。

每个命令输出 requestId、作用目标、执行状态或拒绝原因。可通过脚本 stdin 验证，不要求额外 Web UI。
