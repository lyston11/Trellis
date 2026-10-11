# 任务治理范式全局模板同步

## Goal

在 runtime guard child 合入模板仓库 main 后，把任务资源治理、依赖阻断、唯一集成通道和新的 workflow guidance 同步到所有新初始化项目，并用模板更新/字节一致性回归保护发布结果。

## Scope

本 child 只能在 `10-11-task-resource-conflict-guard` 合入 main 后开始。修改模板仓库的 `packages/cli/src/templates/**`、对应 `.trellis/scripts/**` dogfood copy、workflow/reference 文档和模板测试；不覆盖未提交的 Pi extension 文件，不修改 FamilyGraph 业务代码。

## Requirements

- 发布 runtime child 的所有脚本变更到 `packages/cli/src/templates/trellis/scripts/**`。
- 保持 `.trellis/scripts/**` 与模板 Python scripts 路径集及字节内容一致。
- 更新 workflow/skill/reference：planning 先声明资源，start 做冲突阻断，集成只走 preflight + 单 lane，archive 后清理 worktree/分支。
- 保持用户自定义 managed block 与模板 hash 冲突保护。
- 新项目 init、既有项目 update、临时 fixture dry-run 都能取得新治理能力。

## Acceptance Criteria

- [ ] 模板和 dogfood script tree parity 测试全绿。
- [ ] 模板 fixture 初始化后可运行资源声明与冲突检测。
- [ ] `trellis update --dry-run` 能展示新增/更新文件，不覆盖用户修改文件。
- [ ] workflow 与 skill 文档明确 parent/child 不隐含依赖，使用 `blocked_by` 表达顺序。
- [ ] 当前未提交 `packages/cli/src/templates/pi/extensions/trellis/index.ts.txt` 字节和 git 状态保持不变。
- [ ] CLI lint/typecheck/targeted Vitest/full relevant tests/build 全绿。

## Dependencies

必须等待 runtime child `10-11-task-resource-conflict-guard` 合入 main；不可提前 start，也不可与 runtime child 并行修改模板脚本。
