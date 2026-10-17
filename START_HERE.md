# 直接交给原开发 Agent：FurEverCraft v0.2 大批次开发补丁

继续现有项目，不初始化新仓库、不重新做全仓审计。本包只有两份根文档，附三份已定案设计和一份接口证据。读取本文件、NEXT_BATCH.md 和 docs/design 三份文档；协议细节查 docs/research/26.3-proxy-route-research.md。将设计与研究放入仓库对应 docs 路径，保留现有源码、历史和用户改动；更新既有 CLAUDE.md、DECISIONS.md、WORK_PACKAGES.md 的冲突规则，不机械覆盖整个仓库入口。

本批完整授权范围是 NEXT_BATCH 中 F01–F06、B01–B06、U01–U04、M01–M05、A01–A05、V01–V04，共30项。按依赖连续完成，不在每组结束后等待批准，不将核心工作再次整体推给下一阶段。用户会协同 review；准备完整可审阅提交和证据，收到反馈继续修正。外部条件阻塞只影响确实依赖它的部分，继续完成其余代码与离线验证。

已知基线 main@2cd72cec945298bc86d5be5df9b66493ce066c6f，规划方只做过源码初读，未运行测试。记录本地实际 HEAD、工作区与基线关系；如已有后续工作，优先保留与整合。禁止reset用户修改、从旧远端覆盖修复。无需重复证明全部200项旧审计；只跟进改动合同和本批验收。

文档优先级：用户最新指令 > 本包 START_HERE/NEXT_BATCH 的本批范围与边界 > docs/design v0.2 架构合同 > 既有当前任务文件 > 历史任务/研究建议。三份设计中的“本轮仅设计、不开发”描述的是设计编写时的状态，不限制本次已授权开发；研究中的未决选项以当前设计定案为准。此前其他增量包不再作为另一份并行任务清单执行，保留其有效实现和历史即可。

## 本批不可重新提问的选择

- 游戏固定 Minecraft Java **26.3**，报告登记protocol777/DataVersion5023；不是1.20.4，不追26.4快照。数值及字段按锁定数据与证据校准，发现材料冲突则记录来源与实现依据，不凭猜测填字段。
- 真实原版客户端唯一身体，无Mod/注入/服务端依赖/管理员/额外bot。生产网络路线是**原始TCP转发＋只读旁路观察**，不选双端终止代理，不用createServer/createClient自动登录代替玩家。
- 游戏动作来自Windows10/11输入；协议只观察，不主动发移动/keepalive/确认/认证消息。认证命令通过客户端受控文本输入。
- Node22、TS strict、ESM、npm、SQLite/better-sqlite3、Zod3、Vitest；沿用原生fetch与注入transport，两家API仅OpenAI Chat Completions/Anthropic Messages。
- CLI＋网页；Fastify＋SSE、React＋TS＋Vite，共享ControlService和一个Runtime。生产静态网页同源托管，不做第二套Agent后端、不引入微服务。
- 默认原版单会话，Relay独立进程、Observer Worker、Windows helper独立进程；重型规划进入有界worker，Motor不等模型/SQL/解压。
- 复用Node net/stream、NMP低层/ProtoDef、版本数据与chunk/block模型；必要薄层自己实现。候选schema/native固定#1301＋#1538 entityDelta，不混装vecDelta。

## 外部行为边界

可读取项目/依赖源码，npm安装依赖，获取本包明确引用的固定上游提交、完成本地codegen/构建；不自行展开新网页/论文/候选仓库搜索。缺证据按NEXT_BATCH既定规则处理，不要求用户再选择技术路线。

不连接真实Minecraft服务器、不启动Minecraft服务端或集成世界、不加入任何世界、不下载游戏jar/资产、不运行真实SendInput或桌面截图、不调用真实模型API。无Key不索要。仅允许127.0.0.1临时端口的无游戏引擎协议/HTTP夹具；浏览器只访问项目本地网页，headless E2E不截图。Node依赖/指定源码获取不受“禁止游戏上游连接”开关混淆。

可实现生产live路径，但本轮不运行。live网络、模型网络、OS输入、截图独立开关默认false，fixture不能回退真实外部服务。Java仅可版本探测，不要求启动游戏。

## 交付纪律

先修源码已经暴露的ambiguous覆盖、跨epoch恢复、Clock/Executor装配、工具顺序与逐写准入，再向上扩展。不得把配置输出、内存loopback或同codec roundtrip称为真实TCP/原版互通。

本批不是“只把第一条链路跑通即可”。按任务编号完成实现，测试通过后继续下一项，最终统一离线验证。真Windows、官方原版样本、真实游戏/API环境缺失是验证边界；不得用这些理由跳过可实现的CLI/Web、原始转发、执行恢复和模拟闭环。

提交按可review的功能增量组织；不擅自推送/发布/部署/开PR。仅更新现有PROGRESS.md、DELIVERY_REPORT.md、PLANNING_AGENT_HANDOFF.md及必要使用文档，逐项列实现、测试与缺口，不再新增一堆重复交接模板。文档中旧“无Web”“765”“不自研任何codec”等与本包冲突的当前规则必须替换；历史记录注明过期，不删除。
