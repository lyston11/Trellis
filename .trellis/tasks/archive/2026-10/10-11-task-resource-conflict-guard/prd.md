# 任务资源声明与并行冲突阻断

## Goal

在 task.py 进入 `in_progress` 前，以结构化任务资源声明阻断同一仓库内的路径、串行组、集成通道和显式依赖冲突；读取旧任务保持兼容。

## Scope

实现范围限定为 `.trellis/scripts/**`、任务运行时测试、task metadata 文档与配置。模板同步属于后续 child，必须等本任务合入 main 后再执行。

## Requirements

- 增加可校验的 `coordination` metadata：`owned_paths`、`shared_paths`、`serialization_group`、`blocked_by`、`integration_lane`、`integration_active`。`shared_paths` 参与冲突检测，只能用于说明共享意图，不能绕过冲突。
- 增加 claim/resource/blocker/preflight CLI，拒绝非法路径、循环依赖和未知 blocker。
- `task.py start` 只让 `in_progress` 任务占用资源；planning 默认不占用。
- 路径 glob overlap 保守判定，无法确定时拒绝 start。
- 同组、同 lane 或 built-in serialized resource 冲突时输出双方任务、资源和解除方式。
- `task.py preflight` 只读，不合并、不提交、不推送、不归档；检查 worktree/base/changed paths/资源冲突/迁移 head。
- 旧 task.json 缺少 coordination 时可 list/current/archive；不得被解释为全仓所有权。

## Acceptance Criteria

- [ ] 两个 in-progress 任务声明同一路径时，第二个 start fail closed，task status 与 session pointer 不变。
- [ ] 目录/递归 glob 与子文件声明、spec/migration 默认串行资源、同 serialization_group 均被检测；integration lane 只有显式 `integration-claim` 后才被占用。
- [ ] planning 任务不会无故阻断 in-progress 任务；显式 reserve 的行为有测试。
- [ ] 非法绝对路径、`..`、不确定 glob、cycle/missing blocker 均拒绝。
- [ ] preflight 能发现声明外 changed path、dirty worktree 和 base branch resource drift。
- [ ] 旧任务兼容性、显式 integration claim/release 与 deterministic diagnostics 有测试。

## Dependencies

无；这是 parent 的第一阶段 child。完成并合入 main 后，template-rollout child 才能 start。
