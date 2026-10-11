# Trellis 任务并行隔离与全局模板治理

## Goal

把“多个 agent 同时改同一批文件，直到 merge 才发现冲突”的问题前移到任务启动与集成前：任务先声明它要占用的文件/资源，Trellis 自动阻断重叠任务，并通过显式依赖和唯一集成通道让任务树可预测。完成后将同一套行为发布到 Trellis 全局模板，所有新初始化项目直接获得防护。

## Background / confirmed facts

- 当前 `task.json` 只有 `relatedFiles`，没有可机器校验的任务资源声明；`task.py set-meta` 只能写任意字符串，无法用于可靠冲突检测。
- 当前 `task.py start` 只校验上下文 manifest 与 session identity，不检查其他 active/planning 任务的文件重叠、migration 共享、spec 共享或串行组。
- 当前项目的并行事故实际涉及 `memory_rag.py`、`agent_tools.py`、`maintenance.py` 和同一份 `.trellis/spec/**`；多个任务都已进入实现，冲突在合并阶段才暴露。
- Trellis 同时维护 dogfood copy `.trellis/scripts/**` 与发布模板 `packages/cli/src/templates/trellis/scripts/**`；现有回归要求两棵 Python 树逐文件字节一致。
- 全局模板仓库 `agent-context/Trellis` 当前有用户未提交的 `packages/cli/src/templates/pi/extensions/trellis/index.ts.txt`，本任务不得覆盖、暂存或提交该文件。
- FamilyGraph 的同名 planning 任务只保留需求来源记录；真正的实现任务在全局模板仓库 `10-11-task-concurrency-governance` 及其子任务中。

## Requirements

### R1. First-class task resource claims

任务 metadata 增加结构化 `coordination`，至少包含：

- `owned_paths`: 项目根目录相对路径或 glob；表示任务计划修改/生成的文件集合；
- `shared_paths`: 明确允许串行共享的核心路径；不能绕过冲突，只用于诊断和集成展示；
- `serialization_group`: 可选命名资源组；同组任务不能同时进入 `in_progress`；
- `blocked_by`: 任务目录名列表；依赖任务未完成时不能 start；
- `integration_lane`: 默认 `main`；同一项目同一 lane 同时只能有一个集成任务。

新增任务时可通过 `--meta` 或专用 CLI 写入结构化值；兼容旧任务：缺少 coordination 视为空声明，不因历史任务无法补录而阻断读取。

### R2. 启动前冲突阻断

`task.py start` 在状态从 planning 转为 in_progress 前检查：

- `owned_paths` 与其他 `planning`/`in_progress` 任务的 `owned_paths` 是否重叠；
- 是否命中默认串行资源（`backend/migrations/versions/**`、`.trellis/spec/**`、核心 Trellis 脚本/模板）；
- 是否与其他 in-progress 任务使用相同 `serialization_group`；
- `blocked_by` 是否全部已归档/完成。

冲突必须 fail closed，输出当前任务、冲突任务、具体路径/资源和解除方式。只有 `--force` 不能绕过冲突；若未来需要人工 override，必须留下带理由的审计字段并由专门命令执行。

### R3. 路径匹配必须保守

支持精确路径、目录 glob、文件 glob；任意一方是目录/递归 glob 时按可能重叠处理。未知或无法规范化的声明按冲突处理，不允许因解析失败而放行。任务声明使用仓库相对路径，禁止 `..`、绝对路径和 worktree 外路径。

### R4. 依赖与任务树

父子关系只表达归属，不隐含执行顺序。`blocked_by` 是机器可校验的显式依赖；循环依赖在写入/validate 时拒绝。父任务的最终验收可要求所有 children 完成，但 child 可以独立 start，只要自身 blocked_by 满足。

### R5. 唯一集成通道

增加集成前预检（CLI 或 `task.py` 子命令）检查：

- 当前分支干净且 worktree 与 task.json 一致；
- 分支包含任务声明的工作提交；
- 目标 base branch 未产生未处理的冲突资源变更；
- 同一 `integration_lane` 没有另一个集成中的任务；
- 迁移序号、spec 叶文件和核心资源没有交叉变更。

开发任务不能把“合并 main”作为日常冲突解决机制；集成通道一次只处理一个任务，合并、受影响验证、archive、worktree/分支清理按顺序完成。

### R6. 全局模板同步

runtime child 的行为必须同步到：

- `packages/cli/src/templates/trellis/scripts/**`；
- `.trellis/scripts/**` dogfood copy；
- `packages/cli/src/templates/trellis/workflow.md` 的 planning/execute/finish 规则；
- 相关模板回归测试与 script parity 测试；
- 必要的 bundled skill/reference 文档。

发布使用现有 `trellis update`/模板 hash 机制；不得直接修改生成项目或 npm 安装目录。

## Acceptance Criteria

- [ ] 两个声明 `backend/app/services/memory_rag.py` 的 active/in-progress 任务无法同时 start，并输出双方任务与冲突路径。
- [ ] 一个任务声明 `.trellis/spec/**`，另一个任务声明同一 spec 叶文件或同一 spec 目录时，start 被阻断。
- [ ] 两个任务不声明同一路径但声明相同 `serialization_group` 时，只有一个可进入 in_progress。
- [ ] `blocked_by` 未完成、循环依赖、非法绝对/越界路径均在 validate/start 阶段 fail closed。
- [ ] 旧 task.json 缺少 coordination 时可正常 list/current/archive；不会被误判为拥有全部路径。
- [ ] 集成预检能拒绝 dirty worktree、lane 冲突、base branch 资源漂移，并输出可执行修复信息。
- [ ] `.trellis/scripts/**` 与 `packages/cli/src/templates/trellis/scripts/**` 字节一致；模板项目初始化后具有同样的阻断行为。
- [ ] 全局模板仓库现有未提交 `packages/cli/src/templates/pi/extensions/trellis/index.ts.txt` 保持原样，不进入任何提交。
- [ ] Trellis TypeScript/Python lint、类型检查和相关 Vitest 回归全绿。

## Scope boundaries

- 不实现跨项目中央锁服务；锁定范围仅限同一仓库/项目的 Trellis task metadata。
- 不自动推断 agent 的全部未来修改文件；声明是规划契约，集成预检负责发现声明外变更并拒绝集成。
- 不把所有 planning 任务视为占用文件；只有 `in_progress` 任务占用执行资源，planning 任务只在显式 `reservation`/预留模式下参与冲突诊断。
- 不修改 FamilyGraph 业务代码；FamilyGraph 的 planning 任务只作需求来源。
- 不覆盖模板仓库当前未提交的 Pi extension 改动。

## Child task ordering

1. `10-11-task-resource-conflict-guard`: 先实现并测试 task metadata、资源冲突、依赖和集成预检。
2. `10-11-task-governance-template-rollout`: 待 runtime child 合并后，将 runtime 与规则同步到模板、dogfood copy 和发布回归。

## Open questions

无阻塞产品问题。实现选择（专用 CLI 还是 `--meta` 扩展、glob 算法和默认资源组配置）由 design.md 固化并由测试验收。