# 已确定的实施决策

## 工程与依赖

1. 沿用 Node 22 LTS、TypeScript strict、ESM、npm、Vitest、Zod 3、better-sqlite3；现有 schema 库若已满足合同保持兼容，不为形式重写整个领域。
2. 交互 CLI 使用 commander + Node readline；结构化日志 pino。无 Web 前端、无分布式服务。
3. 模型 HTTP 使用原生 fetch 与注入 HttpTransport。保持两个原生协议，不换 Responses、不引入 Agent 框架。
4. 协议桥用 minecraft-protocol 与 minecraft-data，锁定支持 1.20.4 的依赖版本并保存 package-lock。不自研包编解码。
5. 系统输入与截图固定 **Windows 10/11**；Node Runtime 仍跨平台。Windows helper 采用 Windows PowerShell 5.1 + Add-Type C# P/Invoke/User32/System.Drawing，源码随仓库交付，无额外 Python/Java/Mod。
6. 非 Windows 主机真实 OS driver 明确 unsupported；Windows 实现代码完整，通过模拟 helper transport 测试。此范围决定不要求用户现在提供 OS。
7. 单仓库单 npm package；按 bridge/protocol、bridge/windows、execution、state、skills、providers、memory、cli、diagnostics 分模块，不改为微服务。

## 新版运行 profile

- simulated：默认，无网络/OS 权限，ScriptedProvider。
- client-offline：Minecraft 1.20.4、协议 765、离线身份、目标服务器 offline-mode、本地桥、Windows 原生客户端输入；代码实现，真实行为未验证。
- unsupported：正版加密、多版本自动兼容、非 Windows 系统输入，本阶段明确拒绝。

协议版本固定是为了给接入代码一个可实现基线，不宣称用户服务器必须永久使用该版本。

网络配置拆成独立开关：allowModelNetwork、allowMinecraftUpstream、allowOsInput、allowScreenCapture。默认全 false。不能用一个 global enabled 意外打开所有能力。

## 配置与命令

增加 configs/simulated.json、configs/client-offline.example.json；文件只含凭据环境变量名或句柄，不含秘密。

提供命令：

```text
npm run typecheck
npm run build
npm run test:offline
npm run demo:offline
npm run cli -- --profile simulated
npm run doctor -- --profile simulated
npm run bridge:protocol -- --config configs/client-offline.example.json
```

最后一个命令代码可运行；未显式打开网络时清楚拒绝，不在交付验证中连接上游。doctor 仅本地静态/能力诊断，不自动尝试服务器或付费 API。

CLI 子命令/交互命令固定：status、goal set/show、pause、resume、cancel、chat、executions、effects、events、places、provider、save、quit、help。pause 为正常交接后暂停，不声称冻结游戏；紧急 stop 单独实现。

## 数据与预算

迁移保留既有八表，允许增加 action_receipts（持久去重）、skill_versions（不可变版本 manifest）两表。事务覆盖执行状态/关键事件/必要副作用记录；SQLite WAL/foreign_keys。

事件内存环 1024，诊断轨迹 4096，模型队列 32，聊天队列 16；达到容量返回明确策略。持久日志保留按配置清理，pending effect 不自动当垃圾删除。

默认原语本地重试 2 次、技能换路 3 次、同任务恢复升级 3 次，使用共享预算，不能每次新建实例归零。所有期限用 Clock，离线测试用虚拟时间。

模拟导航保持二维四邻接，不投入完整 Minecraft 物理。真实桥本阶段只实现采集、输入执行和有门禁的能力接口，**不宣称二维控制器可直接在真实三维地形导航**。

## 本阶段不做

训练、任意生成代码执行、向量库、自主知识改写、完整三维跳跃/水流物理、高级战斗、完整建筑规划、正版登录、多玩家编队、跨机器部署。
