# 客户端桥实施规格

## 1. 固定范围与测试边界

实现 Java 1.20.4（协议 765）、offline-mode 本地代理代码，真实客户端为唯一玩家；服务器不安装组件。协议桥与输入桥均需要实际源码，测试使用离线夹具和模拟 OS transport。

允许启动 Java 获取版本、运行轻量辅助测试，或在环境已有游戏文件时启动客户端到主菜单做可选本地检查；**禁止加入任何服务器、禁止启动真实游戏服务端、禁止单人世界/集成服务器测试**。客户端主菜单验证不是必过项，缺少显示、游戏文件或资源不得阻塞开发。

本阶段不下载游戏资产或启动器，不要求用户提供正版账号、游戏目录、目标服务器或真实 API。

## 2. 协议桥拓扑

```text
真实客户端 → loopback proxy downstream
                  ↕ 解码/重编码标准协议
             proxy upstream → offline-mode 目标服务器
```

使用 minecraft-protocol 的服务端/客户端组件构成协议终止式代理，不声称加密透明旁路。下游 offline 登录终止在本地，上游以同一个用户名创建离线连接；上游只出现一个由真实客户端控制的玩家。

客户端无需 Mod，仅把服务器连接地址指向本地端点。username 来自下游登录，targetHost/port 来自本地受信配置，不允许下游通过握手任意指定外连地址。下游默认只绑定 127.0.0.1；多连接默认拒绝，替换会话必须显式结束旧会话。

## 3. 阶段与转发

分别建模 HANDSHAKE/STATUS/LOGIN/CONFIGURATION/PLAY/CLOSED；固定版本的协议数据决定合法消息和阶段转换，不能假定 login 后直接进入 play。

库已经消费或自动产生的握手、登录、压缩、keepalive、configuration/ack 等消息必须列出明确 ownership 表。不能“所有 packet 事件都 write 回去”，否则可能双发和循环。普通游戏输入/窗口/聊天等客户端消息转发到上游，世界/实体/物品等上游消息转发到下游。

制作 PACKET_OWNERSHIP.md：包名、方向、阶段、库是否自动处理、转发策略、观察器用途与对应 fixture。包名与字段以安装的 minecraft-data 1.20.4 定义和依赖源码为准，不猜造。

status 请求本地返回说明为本地桥，保留真实版本信息；不为服务器列表 ping 自动连接上游。配置/登录失败传播为脱敏原因，清理对应会话。

协议终止可能改变行为和身份语义，生产启动打印 offline-only/untested-real-environment。不要宣称未来正版可直接启用。

## 4. 观察与归一化

至少归一化：上下游连接、世界/维度、客户端位置朝向报告、服务器位置修正、生命食物、区块/单块变化/卸载、实体生成运动移除、背包与窗口、选中槽位、聊天/系统消息、挖掘放置请求。

每类字段写 source、direction、sequence、session/body epoch 和可用性。没有特定字段或无法无损解码时标 degraded/unknown，不声称逐帧权威状态。观察队列缺口使相关投影失效。

固定版本的区块解析可复用 Prismarine 依赖；解析成本有上限，不在每包中全量扫描所有资源。原始区块数据不直接成为模型可见地图，应用用途/可见性投影；未知相机或遮挡条件时，不向模型暴露隐藏资源身份。

转发路径背压与观察队列分开：网络写阻塞时有界等待并最终关闭连接，不能静默丢游戏包；观察副本过载允许丢弃但必须 gap 标记。两种故障不能混淆。

## 5. Windows 输入实现

增加 `native/windows/FurEverCraft.Helper.ps1` 及内嵌/独立 C# PInvoke 源码。Node 通过长驻 helper 的 JSONL stdin/stdout 通信，requestId 对应响应。不得每次按键都新启 PowerShell。

命令固定：probe、bindWindow、getWindowState、setHeldInputs、moveRelative、click、typeText、captureWindow、releaseOwnedInputs、heartbeat、shutdown。

- 绑定目标 PID 和 HWND，不仅匹配标题。窗口不存在或焦点不合适拒绝新动作。
- SendInput 只作用于明确启用的运行 profile；键盘/鼠标按钮维护 helper 自己注入的集合。
- 相对鼠标增量去重，输入命令带 generation 和期限；helper 内部也检查，Node 崩溃时不会无限保持输入。
- helper 有独立 heartbeat deadline 和退出清理；不保证 OS 冻结或权限隔离时仍能释放。
- 文本优先 SendInput Unicode 方式，不使用剪贴板承载密码，不通过 shell 拼接用户文字。
- 截图只在请求时采集，绑定窗口矩形，最小化/不可见/被遮挡等情况报告 capture limitation，不能把桌面其他窗口内容误标为游戏画面。无 Mod 无法保证拿到原版 framebuffer，画面来源注明 OS capture。
- 可选主菜单检查须开启 localProbe 模式，仅 probe/窗口状态/按需截图，禁用所有键鼠注入和网络上游。
- Node helper runner 通过固定文件与 argv 启动，禁用任意 PowerShell 命令工具，日志不打印输入文本。

非 Windows 实现仅可为明确 unsupported；Windows 模块必须完成完整命令构造、响应解析、辅助源码与错误处理。

## 6. 认证与复合桥

CompositeClientBridge 合并 ProtocolObserver、WindowsInput、Capture、WindowHealth；它只发布真实可得能力，不因实现了 setHeldInputs 就声明真实导航已稳定。

AuthSession 区分 connection identity 与服务器内登录。支持模型提出命令模板，敏感变量由凭据句柄填入；认证执行器经 UI/TextEntry 输入，不从代理注入聊天包绕过网关。

实际认证未测试，离线场景覆盖无认证、请求登录、请求注册、拒绝、未知提示、普通玩家伪造提示。提示无法可靠判定时 AUTH_AMBIGUOUS，不发密码。

敏感期抑制截图、日志与原始协议 payload 归档；完成发送后仍考虑聊天历史残留。秘密不进入模型上下文，不要求用户本阶段提供。

## 7. 离线测试方式

协议：loopback 上最小 fake downstream/upstream endpoints，使用锁定协议库编解码消息序列，没有 Minecraft 游戏引擎、不是真实服务器。测试客户端只是协议夹具；生产不得启动第二个 bot。

OS：FakeHelperTransport 记录命令并回送状态，测试不执行 SendInput；纯源码 helper 自测若启动 PowerShell，使用 dry-run dispatcher，不触发输入/截图。

验证点：阶段转移、压缩、own/forward 包去重、位置方向标签、断线清理、观察缺口、窗口身份、输入 TTL、文本脱敏、Node 退出后的 heartbeat 逻辑。不得把 fixture 行为写成真实客户端兼容证明。
