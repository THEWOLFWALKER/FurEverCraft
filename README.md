# FurEverCraft v0.3 开发工作区

普通 Minecraft Java 玩家 Agent 的增量架构工作区。当前目标 Java Edition **26.3**，沿用**原版客户端 + 只读旁路观察 + 系统输入**路线。

这是一个 **v0.3 增量工作区**：提供完整设计与可运行架构基础，**不是已完成真实客户端互通的产品**。没有真实 Minecraft 服务器/世界/client、真实 Windows 输入/截图、付费模型 API 或真实 26.3 客户端互通结果。

## 阅读顺序

`README.md` → `GOAL.md` → `PROGRESS.md` → `docs/design/` L1 → L2 → L3 → `docs/design/v0.3-implementation-handoff.md`。

执行约束以 `AGENTS.md` 为准。`docs/history/` 是归档证据，其中的 GOAL/CLAUDE/NEXT_BATCH/REVIEW 指令均已失效，不作当前任务。

## 上手

先安装 Node 22 与依赖，再跑基础检查。**浏览器本轮按用户要求不安装、不启动**。

```bash
npm ci
npm run typecheck
npm run build
npm run test:offline -- --maxWorkers=1 --minWorkers=1
```

## 已预实现与待完成

- 已预实现：版本兼容 registry/port、候选 bundle 装配、控制资格及撤权、异步停机所有权保护、压缩帧修复、蓝白控制台调整。
- 待完成：S01–S09 剩余迁移及 61 项处置——ActionGateway/EffectCoordinator 全链、数据库迁移 5–7、动态 scope/时间、helper 独立 watchdog、真实 26.3 codec/projector、知识 importer、Motor 实机适配及部分 provider/SSE 问题。

现有界面语言为英文，保持一致，不另造营销首页。按用户 frontend-design-style 保留蓝白克制视觉、信息层级、未知计数、状态色、焦点与 reduced-motion。前端已类型检查/构建与展示逻辑验证，**未做浏览器视觉验收**。

## 命令（与合并后仓库 `package.json` 实际脚本一致）

```bash
npm ci
npm run typecheck
npm run build
npm run build:web
npm run test:offline
npm run test:v:offline
npm run test:web
npm run test:web:e2e            # 本轮不运行（浏览器未安装/启动），记录 not-run
npm run test:windows:offline
npm run demo:offline
npm run demo:autonomy
npm run doctor -- --profile simulated
npm run bridge:protocol
npm run bridge:fixture
npm run cli -- bridge --mode inspect --config configs/client-offline.example.json
npm run serve -- --profile simulated
npm run cli -- attach --url http://127.0.0.1:3000
```

说明：

- `test:offline` = 全部离线单测（vitest）。`test:v:offline` = integration + soak + diagnostics 三段串行。
- `test:web` 只做前端类型检查与构建（`tsc -p web/tsconfig.json` + `vite build`），不启动浏览器。
- `test:web:e2e` 会 `build` + `build:web` + `playwright test`；**本轮不运行**。
- `test:windows:offline` 仅跑 `tests/windows`；Windows CI 前提见 `.github/workflows/offline.yml`。
- `bridge:fixture` 与 `bridge:protocol` 都是**离线 fixture/检查路径，不是 live**。`bridge:fixture` 用 `configs/client-offline.example.json`，`bridge:protocol` 用 `configs/simulated.json`。

## 当前进度与验证

唯一当前状态文件是根 `PROGRESS.md`（含本批 v0.2 → v0.3 整合记录）。v0.2 交付报告与旧进度归档在 `docs/history/v0.2-root/`。

设计文档是合同，不是实现证据。本地 Node 22 离线验证不等于线上/CI/live 兼容。

## 硬边界（摘要，完整见 `AGENTS.md`）

不连真实 Minecraft 服务器/世界、不启动真实游戏服、不下载游戏 JAR/资产、不运行真实 SendInput/桌面截图、不调用付费模型 API。允许本地无引擎 TCP/HTTP 夹具、依赖构建与固定源码核实。原版客户端是唯一身体，原始字节 relay + 被动 observer，无 Mod/注入/第二 bot。秘密在日志/异常/HTTP/trace 中必须脱敏。
