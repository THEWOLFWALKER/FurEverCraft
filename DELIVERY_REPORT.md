# FurEverCraft 第二阶段交付报告

状态：已完成可运行的离线第二阶段增量，所有已声称通过的命令均为实际运行结果。真实 Minecraft 服务器、真实客户端输入和付费模型 API 未连接。

## 已实现

- `src/contracts`：上下文、执行、输入、效果、时钟和状态合同。
- `src/state/world.ts`：上下文隔离、不可变快照、gap/unknown 失效。
- `src/persistence/store.ts`：SQLite WAL、迁移、目标/提案/执行、effect、checkpoint、事件、地点、经历、action receipt。
- `src/execution/runtime.ts`：资源租约、TTL、过期拒绝、进度、watchdog、取消和提案幂等基础。
- `src/execution/session.ts`：重启时 pending effect 观察和调和路径。
- `src/skills/registry.ts` 与 `src/skills/skills.ts`：五项技能 manifest 和模拟实现。
- `src/agent/router.ts`：结构化工具参数校验、完整工具入口、只读并行/写串行工具循环。
- `src/providers/openai` 与 `src/providers/anthropic`：请求/响应、SSE、增量工具参数、usage、错误、取消。
- `src/bridge/protocol/session.ts`：1.20.4/protocol 765 阶段状态机、packet fixture、观察队列和 upstream gate。
- `src/bridge/windows/driver.ts` 与 `native/windows/FurEverCraft.Helper.ps1`：JSONL helper、PID/HWND 绑定、TTL、去重、heartbeat、dry-run 和退出清理路径。
- `src/bridge/composite.ts`：协议观察、Windows driver、截图能力的组合和诚实能力声明。
- `src/diagnostics`：事件游标、持久关键事件和日志脱敏。
- 配置：`configs/simulated.json`、`configs/client-offline.example.json`。
- Node 22 CI：`.github/workflows/offline.yml`。
- 测试前提规则：`TESTING_RULE.md`，并已写入阶段 `CLAUDE.md`。

## 实际验证

环境：Linux，Node `v20.19.5`，npm `10.8.2`。目标 CI runtime 为 Node 22。

已通过：

```text
npm run typecheck
npm run build
npm run test:offline
npm run demo:offline
```

当前离线测试：7 个测试文件，27 个测试通过。

测试覆盖：world context/gap、SQLite 重开和 effect/checkpoint、五技能执行、provider/runtime 回归、protocol 阶段和方向、Windows fake transport、Composite bridge、响应错序/输入过期/命令去重。

## 测试前提规则

测试只能基于合同或可观察行为。不能把 fixture 常量当真实客户端事实，不能测试函数自己的硬编码返回值，不能用错误的同步/异步前提断言异步方法。失败时先检查前提，再修实现或修正测试；不能削弱断言、静默跳过或伪造成功。

## 未验证边界

- 未连接真实 Minecraft 服务器或加入任何世界。
- 未启动真实 Minecraft 服务端或客户端。
- 未执行 Windows SendInput 或真实桌面截图。
- 未调用 OpenAI/Anthropic 付费 API。
- 协议、Windows helper 和 provider 的真实环境兼容性仍需目标环境单独验证。
- 模拟二维导航不代表真实 Minecraft 三维导航能力。
