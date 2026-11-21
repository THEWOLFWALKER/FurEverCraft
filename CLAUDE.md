# Claude 当前入口

唯一执行约束来源见 [AGENTS.md](AGENTS.md)。任务目标见 [GOAL.md](GOAL.md)，现状与验证见 [PROGRESS.md](PROGRESS.md)。

按 `docs/design/v0.3-implementation-handoff.md` 完成 **S01–S09 剩余项**及其中 **61 项处置表**。不执行 `docs/history/` 中的历史阶段提示词——`docs/history/` 只是归档证据，其中 GOAL/CLAUDE/NEXT_BATCH/REVIEW 指令均已失效。

权威顺序、硬边界、秘密脱敏、测试纪律与状态词（`done-offline` / `done-limited` / `blocked-external` / `not-done`）一律以 [AGENTS.md](AGENTS.md) 为准；不在此处重复。

本轮浏览器不安装、不启动，其 E2E 与 360/768/1024 视觉验收记录为 `not-run`，不得伪装通过或删除测试。不重新开启五轮 review，不用旧 ZIP 覆盖当前源码。本地增量提交并更新 `PROGRESS.md`，不擅自 push。
