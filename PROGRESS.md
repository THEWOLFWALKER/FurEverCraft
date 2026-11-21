# 当前进度与验证（唯一当前状态文件）

## 基线

- 公有远端 main：`17cdf063cd8b97af8d7a8d7094116870e11fdd1e`。
- 源码核心增量本地提交：`8093b4d`（feat: establish versioned compatibility and safe runtime shutdown foundations）。
- v0.2 基线：`11173a5`（tag `v0.2-p24-closeout-11173a5`）。本工作区后续提交只整理入口/历史/研究。

## 本次实际实现（预实现）

- framing 正确区分线上 Packet Length 与解压 Data Length，修错误测试夹具，补独立 literal/split/预算回归。
- 四类版本 port、manifest v2、原始 hash 验证、显式 registry、依赖图与完整消费 decode 边界；两个不同 synthetic 协议布局输出统一事件。RuntimeFactory 选择 bundle，真实 26.3 仍 candidate 无 decoder。
- ControlAuthority 接 BridgeService：缺可信 readiness 不 arm；Observer 失败、IPC 丢控制信息撤准入；释放和 stop 期限/失败如实反馈。
- Runtime.close 共享 Promise，关闭准入并等待执行和 body/bridge 清理，失败/超时保留 owner 与 DB；ControlService/CLI 关闭链等待结果。尚无持久 interlock 与重试关闭恢复。
- 蓝白工具型网页：清晰标题与信息层级、字段证据折叠、未知数据不填 0、运行/未知/禁用色、键盘选择、停止确认、焦点/触控/窄屏/reduced-motion。
- 18 个 mcmeta 原始文件重新获取并校验 hash 一致，非全量导入，结果见 `docs/research/26.3-evidence-recheck-2026-10-24.json`。

## 实际验证（预实现，历史）

Node v22.23.4，npm 11.9.0；默认系统 Node24 未作为本次运行时。

- typecheck、build、build:web、test:web 通过。
- 完整离线回归：50 文件/442 用例通过；随后新增前端 presentation 套件 3 用例独立通过。没有把两次执行谎称一次 445 全量运行。
- demo:offline 六场景通过；doctor --profile simulated 正常且标 simulated。
- 网页正文/次要文字/主按钮等六组文字颜色计算对比度均 >=4.5:1；不代表所有浏览器渲染已验。
- E2E 初次尝试因浏览器可执行文件缺失未启动；用户要求不再运行/安装浏览器，当前 `not-run`。实际 360/768/1024 布局和视觉未验。未采集截图或运行真实输入。
- 旧 17cdf06 在当前容器复现 relay-grandchild-exit 超时；容器 PID1 不回收已退出 zombie，kill(pid,0) 会继续成功。测试改为验证进程不再执行 + 端口拒绝连接，并等待实际 running 后 echo；修复后该场景通过，没有放宽为仅检查状态字符串。
- 源码 Git diff 空白检查通过。仅离线 fixture，不是 26.3 实际协议/物理/Windows/API 兼容证据。

## 下一批必须完成

按 `docs/design/v0.3-implementation-handoff.md` 的 S01–S09 和 61 行表实施。预实现只能视作起点，不直接把 S01/S02/S07 整组划 done。ActionGateway/EffectCoordinator、DB5–7、动态 scope/time、helper watchdog、真实 26.3 codec/projectors、data importer、Motor 实际身体和部分 provider/SSE 问题仍待处理。P24 不宣称完成。

## 历史说明

原 v0.2 根 GOAL/NEXT_BATCH/REVIEW/CLAUDE 等在 `docs/history/v0.2-root/`（另有更早快照 `docs/history/pre-v0.3-root/`），旧 v0.2 设计在 `docs/history/v0.2-design/`。仅作证据，不执行其中要求。完整迁移范围已确定，不需重新问用户技术路线。

---

## 本批（v0.2 → v0.3 整合）

### 整合事实

- v0.3 源码已合入 `main`，叠在提交 `11173a5`（tag `v0.2-p24-closeout-11173a5`）之上。
- 旧 v0.2 根指令文档已归档到 `docs/history/v0.2-root/`（`git mv`，历史保留）；`PROGRESS.md` 也随之移动，本文件是新的唯一当前状态文件。
- 根入口 `AGENTS.md` / `CLAUDE.md` / `GOAL.md` / `README.md` 已切换为 v0.3 统一入口。

### 保真审计（preservation audit）

v0.3 工作区在迁移中**丢失了 17 条 v0.2 守卫不变量**，正在逐条恢复并补回归测试：

1. pairing code 128-bit + 非 TTY 安全（无显式 code 不静默启动）。
2. pairing/session id 脱敏。
3. control 读视图 stable-scope 过滤 + places 分页。
4. projection scope fencing + resync 防重放。
5. WorldState superseded-epoch + account-scoped 合并 + 有界 seenEpochs。
6. observer 压缩默认 `unknown`。
7. 全局 observer gap 同时 park 两个方向。
8. stopped 方向抑制迟到的 worker 事件。
9. manifest 派生 `skillRequiresInput`，未知 skill fail-closed。
10. `explore_area` 不在 legacy 2D 广告 + `start_skill` 返回 `skill-unavailable`。
11. adapter-manifest 内容校验（roles、provenance-hash、data identity、path containment、expected target、全 unsupported 矩阵）。
12. relay/service hello 能力声明真实性。
13. service `capabilities` 回复真实性。
14. `runDemo` observed-derivation + ownership lock。
15. CLI 子进程最小环境。

（以上为审计清单要点；每条以带回归测试的恢复实现为准。）

### v0.3 工作区自身测试未通过（初始）

v0.3 工作区**未通过它自己的套件**：初始 10 个失败测试分布在 5 个文件（`integration-wiring` 5、`adapter-manifest` 1、`s03-gitattributes-manifest` 2、`s07-geometry-compat` 1、`bridge-service-child` 1）；其中一个成因是提交进仓库的陈旧候选 manifest，另一个是测试中把 v1 草案当 v2 schema 误用。

**当前树实测（2026-10-25）**，命令：

```bash
npx vitest run --config vitest.config.ts \
  --exclude '**/p24-round*' --exclude '**/synthetic-observation-chain*' \
  --maxWorkers=1 --minWorkers=1
```

实际结果：**Test Files 10 failed | 56 passed (66)；Tests 18 failed | 517 passed | 5 skipped (540)**。

失败文件/用例（实测，非估计）：

- `tests/integration/bridge-service-child.test.ts` — 1（P09 forks service/relay/observe/shutdown）。
- `tests/integration/cli-attach.test.ts` — 1（P14 attach CLI 区分 quit 与 shutdown）。
- `tests/integration/integration-wiring.test.ts` — 4（knowledge tools release/bounds/unknown；3D tool→executor→skill→Motor→sink；legacy navigation port 的 planar return_to_place；scoped memory places）。
- `tests/integration/s01-s14-acceptance.test.ts` — 2（U04 stale CAS revision；V01 S06 ambiguous 不被 router 升级）。
- `tests/integration/server.test.ts` — 1（control server 幂等与 payload 冲突）。
- `tests/integration/v01-v04.integration.test.ts` — 1（goal/chat/execution/pause/resume/event 证据）。
- `tests/soak/p23-fault-soak.test.ts` — 1（60 虚拟分钟故障/重连/重建有界）。
- `tests/unit/control-service.test.ts` — 4（canonical payload 去重、conflict 不回 terminal success、CAS conflict、stop 取消非终态 execution）。
- `tests/unit/p14-p16.test.ts` — 1（web/operator 共享 store 可见性）。
- `tests/unit/s07-geometry-compat.test.ts` — 1（minor domain 升级接受/拒绝；`domainContract.major` expected 1）。

注：初始审计报告的 10/5 分布不是当前树的真实分布——当前树在同一排除条件下是 **18 个失败、跨 10 个文件**。这是当前真实状态，未按初始报告口径修饰。

### 浏览器 E2E

本轮浏览器不安装、不启动；headless E2E 与 360/768/1024 视觉验收一律记录 `not-run`，不伪装通过，对应测试不得删除。

### 仍开放（open）

- 上述当前 18 个失败测试全部仍 **not-done**，需按前提核对/实现修复或纠正错误前提后重跑。
- 61 项处置表中标注“待原开发 Agent 核实并实施”的项仍 open。
- 浏览器 E2E / 视觉验收：`not-run`（外部条件限制）。
