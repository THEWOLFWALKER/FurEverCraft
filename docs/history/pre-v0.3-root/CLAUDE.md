# FurEverCraft 实施约束（当前批次 P01–P24）

## 当前权威与范围

- 当前开发批次是 `NEXT_BATCH.md` 的 **P01–P24**；设计权威是 `docs/design/*-v0.2.md`，审查合同是 `REVIEW.md`，当前状态与证据见 `PROGRESS.md`、`WORKSTREAM.md` 和 `DELIVERY_REPORT.md`。
- 权威顺序：用户最新明确指令 > 本文件与 `NEXT_BATCH.md` > v0.2 设计合同 > 旧阶段文档。旧 `DECISIONS.md` 中的 1.20.4/protocol 765 terminating-proxy 内容只保留为历史，不是当前实现目标。
- 旧文档中的 F/B/U/M/A/V 编号是可追溯的历史分组，不再是当前批次编号；报告 P01–P24 时必须使用当前编号和实际证据。
- 当前目标游戏版本 Java Edition **26.3**（协议 777、DataVersion 5023 为候选来源数据）。没有可核对的 26.3 schema/native/data 时，对应 decoder/domain 必须保持 `unavailable`/`unsupported`，不得猜字段、不得把 fixture 或最新依赖当作 26.3 支持。
- 不留下架构开放题，不反复请求“是否继续”。缺失外部资料只阻塞直接依赖项；其余可离线完成的工作必须继续。

## 状态词

报告和表格只使用以下四个状态词：

- `done-offline`：实现存在，并已由适用的离线测试/命令验证。
- `done-limited`：实现存在且已验证，但范围或验证边界明确受限（例如 synthetic 投影、模拟 body、注入 transport）；必须同时写出限制。
- `blocked-external`：任务本身依赖本批禁止的真实环境/数据/API；必须写明精确缺件与影响。
- `not-done`：尚未实现或尚未满足验收；进行中的工作也归入此类，不得提前标成 `done-*`。

P24 和五轮 review 在全部完成前不得标为 `done-offline`。测试数量、提交数量或“已跑过一轮”都不是完成依据。

## 固定架构与不变量

- **单一 Runtime owner**：同一 SQLite 存储路径只允许一个 `RuntimeAssembly` owner，使用原子跨进程所有权锁；CLI 与网页通过 HTTP 附加到同一个 `ControlService`，不得各自创建新 Runtime。锁只释放自己写入的记录，不删除未知/外来锁；CLI/Web 退出不等于 shutdown。
- **唯一身体**：原版 Java 客户端是唯一身体。生产链路是**原始 TCP relay + 只读 passive observer sidecar**；不得引入客户端 Mod、Java Agent/注入、内存读取、服务端组件、管理员遥测或第二个 bot/玩家。除显式配置的首次 handshake 地址映射外，转发字节保持不变。
- **唯一执行链**：用户入口 → `ControlService` → 唯一 Runtime → Agent 工具 → Executor → Skill → Navigation/Motor → 输入仲裁 → `BodyAdapter`/injected sink。生产路径不得落回二维 `bridge.walk`；二维只允许作为显式 legacy/simulated profile，并把 `{x,y}` 如实标为 legacy，不伪造 `z=0` 的三维能力。
- 模型只使用 OpenAI Chat Completions / Anthropic Messages，不训练控制模型。所有 Agent 输入经网关；模型、技能和 observer 不得绕过。
- 状态未知不当空气；副作用未知不盲重放；旧租约不复活；ambiguous/partial 不得被 finalizer 升级为 confirmed。
- 结构化证据优先；Fake/fixture/synthetic/simulated 来源必须保留标签，绝不能充当真实客户端或 live compatibility 证据。
- 真实客户端报告不等于服务器逐帧确认；STATUS ping 不等于身体会话。

## 五轮 review 合同

- 主体开发和适用离线验证完成后，按 `REVIEW.md` 连续执行**恰好五轮**全仓 review；每轮覆盖整个工程与装配链，而不是把五个模块各查一次。
- 每轮记录开始/结束 commit、覆盖范围、发现（严重性、触发条件、文件位置、实际影响）、fixed / false-premise / blocked-external、修复与定向回归、仍受影响任务。记录在 `PROGRESS.md` 或 `DELIVERY_REPORT.md`，不另建五套模板。
- 每轮发现的问题在处理完或明确外部阻塞后才进入下一轮，不能等五轮结束再修。
- 五轮完成后不再自动开启第六轮全仓 review；但第五轮发现的问题仍须修复并定向验证，最终标准检查失败时继续修复并重跑相关检查。
- review 不是正确性证明；不得用“已五轮”保留已知 bug，也不得用发现问题数量衡量完成。

## 测试纪律（不得削弱测试）

- 测试必须建立在真实实现、公开合同或明确夹具语义上；断言必须证明可观察行为，负例必须真的会失败。
- **不得削弱断言**、静默跳过、捕获异常后返回成功、删除必测场景、调整状态名掩盖未完成，或把恒成功脚本称为测试。测试失败时先审查前提和实现边界，再修实现或纠正错误前提。
- 异步行为必须 await；测试 DB 使用隔离临时路径并清理；进程/端口/浏览器资源必须关闭。
- fixture 行为、模拟常量、synthetic 数据不得证明生产能力；模拟结果不得升级为真实客户端证据。
- 不得用假常量/空实现替代本批指定的代码实现，也不得用 `unavailable` 空壳逃避可独立完成的工作。
- 标准检查至少覆盖 `typecheck`、`build`、`build:web`、全部适用离线测试、headless E2E、demo 和 doctor；命令按仓库真实脚本执行，不新建同义脚本凑数。
- E2E 必须真的启动本地 server 与 headless 浏览器；浏览器/启动/断言失败必须非零退出，不得保留恒成功 fallback。

## 运行时与验证边界

- **Node 22 是本地已验证运行时**：本批实际使用 Node `v22.23.4`、npm `10.9.9`。报告实际版本与命令结果；Node 22 CI 配置存在不等于 CI 已运行通过。
- 不声称 live 验证。没有真实 Minecraft 服务器/世界、真实 Windows 输入、桌面截图、付费模型 API 或真实 26.3 客户端互通结果。
- 禁止：连接真实 Minecraft 服务器/加入世界、启动真实游戏服、下载游戏 JAR/资产、运行真实 SendInput/桌面截图、调用线上付费模型 API、自行开展新的网页/论文/仓库研究。
- 允许：本机 npm 构建与依赖安装；127.0.0.1 无游戏引擎 TCP/HTTP 夹具；注入 transport/sink；headless 本地网页 E2E（不截图/录像/trace）；读取已安装依赖源码与既有固定候选源码。
- 外部能力 gate（`allowMinecraftUpstream`、`allowModelNetwork`、`allowOsInput`、`allowScreenCapture`）独立且默认关闭；loopback 测试授权不得回退成真实目标或 Fake 生产后端。

## 交付规则

- 先记录实际本地 HEAD/工作区状态，保留用户改动与既有修复；不重建工程、不随意 reset 用户工作、不制造重复框架。
- 按可 review 的增量本地提交组织工作；不擅自 push、部署、发布、开 PR 或更改远端权限。
- 完成一个 P 项或阶段后立即更新 `PROGRESS.md`/`WORKSTREAM.md`；最终报告必须把实现状态与验证状态分开，列出 `done-limited` 的限制、`blocked-external` 的精确补件和没有解释的内部 `not-done`。
- 准确报告：测试不能执行就是未执行，数据不存在就是缺失，真实环境被禁止就是未验证；本地通过不等于线上/live 兼容。不得以“未测真实环境”遮蔽内部未接线。
- 秘密（密码、API Key、pairing code、bearer、CSRF、session cookie）在日志、异常、HTTP 响应、trace 和诊断中必须脱敏。
- 只记录可见决策与证据，不收集隐藏思维链。遇到无法解决的技术错误，记录具体错误、已尝试修复和影响范围，不伪造通过。

## 工程约束

- TypeScript strict / ESM / npm / SQLite / Zod；Fastify + SSE；React + Vite；CLI 与网页共享 `ControlService`。不引入消息中间件、向量数据库或第二套状态机框架。
- 核心领域不依赖供应商与 OS 类型；Clock/Transport/Store/OS driver 可注入。
- SQLite 不能改为内存替代；命令去重、execution、effect 与 pending 状态必须跨 Runtime 重启保持。
- 不把 `accepted`/`queued`/handler 返回当作效果确认；prepared 持久化成功后才允许越过 may-have-dispatched 边界。
- 不得留下没有解释的内部未完成项；确实不能完成时说明尝试、精确缺件、影响和可继续部分。
