# 离线验收：第一阶段完成门槛

## 执行命令合同

工程提供以下 npm scripts，具体实现按 IMPLEMENTATION_DECISIONS.md，不得缩水：

```sh
npm ci
npm run typecheck
npm run build
npm run test:offline
npm run demo:offline
npm run cli -- --profile simulated
```

test:offline 默认阻止外部网络与真实输入；必要的本地 loopback HTTP 测试显式允许。网络封锁不能影响 npm ci，也不能靠环境中有 API Key 才通过。测试使用临时目录和虚拟时间，避免长时间 sleep。

## 验收场景

| ID | 场景 | 必须断言 |
|---|---|---|
| A01 | 无 Key、无游戏、无网络启动 demo | 完成模拟目标，结果明确标 simulated |
| A02 | 状态 unknown/historical/predicted/conflict | 不被查询和导航当作当前已知空气 |
| A03 | 跨会话迟到观测/事件缺口 | 旧事件不改新状态，缺口导致依赖视图失效 |
| A04 | 目标版本改变后迟到模型结果 | 原提案不覆盖新目标；当前有效执行按取消合同处理 |
| A05 | OpenAI 工具循环 fixture | 请求 schema、tool ID 关联、多轮结果、usage/stop 原因正确 |
| A06 | Anthropic 工具循环 fixture | content block、tool_use/tool_result 关联和图片块正确 |
| A07 | 流式碎片/交错调用/非法参数/中断 | 不执行不完整参数；取消后不提交；错误可解释 |
| A08 | 重复 proposalId/commandId | 同提案无第二执行，点击与鼠标增量不重复应用 |
| A09 | 旧命令延迟抵达 | 不因接收时重新计算 TTL 而变有效 |
| A10 | owner 抢占与旧 finally | 旧代后续命令全部拒绝，不能释放新代资源 |
| A11 | 导航中聊天 | UI/文本资源冲突正确，导航暂停后能重观察续行 |
| A12 | 动态阻挡与未知路径 | 相关段重规划；预算耗尽有终态，不无限循环 |
| A13 | 放置已生效但响应延迟 | 不盲重试，后续证据解决结果；目标满足与归因分开 |
| A14 | 持久发送意图后故障重启 | 新 Runtime 打开 SQLite 核对 pending effect，不重放输入 |
| A15 | 数据库写入失败 | 不把失败写入称 durable；依赖持久意图的副作用不提交 |
| A16 | 模型超时/提供方切换 | 本地有效技能继续或有界暂停，不重复已接纳工具副作用 |
| A17 | 事件缓存溢出 | cursor 返回 gap，关键持久事件仍可查询 |
| A18 | 日志敏感字段 | Key/凭据/敏感文本不进入日志和 fixture 快照 |
| A19 | 真实后端配置未实现 | 明确 unavailable，不静默 fallback 为模拟成功 |
| A20 | 控制台修改目标与重启 | 版本更新、取消、目标持久化、恢复语义一致 |
| A21 | 长序列虚拟运行 | 队列/轨迹容量受限，无僵尸租约和无限恢复循环 |

对 schema、状态转换、去重和资源冲突用明确断言；对计划器用有障碍、未知和变更的非平凡地图。不要只测试实现函数返回自己的常量。

## demo 必须展示

ScriptedModelProvider 先查询状态，通过工具启动导航；途中模拟路障并恢复；控制台或脚本事件修改目标；执行聊天并正确占用 UI；一次放置发生未知结果后通过观测核对；至少一个重启恢复测试独立完成。

每个演示阶段显示 executionId、phase、关键证据和 simulated 标记。不得每个控制周期调用 capture_view。截图次数与触发原因可查询，默认演示只在明确需求下获取测试帧。

## 不在本阶段证明的事情

真实 Minecraft 物理、服务器兼容、协议代理可行性、操作系统输入稳定性、真实视觉质量、线上模型行为与实时性能。报告必须保留这些未验证项。
