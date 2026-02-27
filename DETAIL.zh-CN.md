# Workbench 详细说明

English version: [DETAIL.md](DETAIL.md)

本文档提供 `opencode-workbench` 的低层协议与行为细节。
若只关心插件价值、安装与快速上手，请查看 `README.zh-CN.md`。

## 工具定位

`workbench` 用于将 git worktree 目录绑定到 OpenCode 会话，并将任务路由到正确的 worker 上下文。

核心设计约束：

- 不负责沙箱创建或文件同步。
- 只处理元数据与路由。
- `workbench` 编排由 supervisor 会话统一负责。
- 已绑定的 child worker 会话不能直接调用 `workbench`。

## Action 面

插件只暴露一个工具：`workbench`。

主要 action：

- `help`：查看完整帮助。
- `bind`：创建/更新绑定元数据。
- `open`：为绑定创建或复用固定 child 会话。
- `task`：将提示词路由到绑定的 worker 会话。
- `list`：按作用域列出绑定。
- `info`：查看单个绑定。
- `remove`：删除绑定。
- `doctor`：执行非破坏性的环境与仓库检查。

## 校验与仓库要求

- `bind`、`open`、`task` 都要求目标目录是 git repo/worktree。
- 非 git 目录会被拒绝并返回引导信息。
- `upstream` 与 `fork` 必须符合 `OWNER/REPO`。
- `prUrl` 必须符合 `https://<host>/<owner>/<repo>/pull/<number>`。
- 元数据清理通过显式参数完成：`clear: "prUrl"` 或 `clear: "github"`。

## 作用域与查找规则

- 默认作用域：`session`。
- `session` 包含当前会话及其直接 child 会话绑定。
- `repo` 列出当前仓库（或 `dir` 指定仓库）的绑定。
- `all` 列出跨仓库绑定。

仅名称操作（`open/info/remove` 只给 `name` 不给 `dir`）按以下顺序解析：

1. 先查 session 作用域。
2. 若名称唯一，再回退 repo/global 作用域。

## 会话定向参数

可选参数：

- `parentSessionId`：覆盖 supervisor 会话 id。
- `sessionId`：显式指定目标 child 会话 id。
- `task_id`：分发时显式指定目标任务会话。
- `strict`：用于 `info`，遇到歧义时报错而不是自动选最新。

## 任务路由与隔离语义

- `workbench { action: "task" }` 按绑定/会话目标进行路由。
- 指向同一 child 会话的并发调用会串行化，避免输出串话。
- 若要真正并行，请使用不同 `dir`/`task_id` 目标。
- 返回包含队列与执行耗时指标：`task_queue_ms`、`task_run_ms`、`task_queued`。
- 在转发任务运行期间，child 的权限/提问请求会被自动拒绝。

## 治理模式（Supervisor + Workers）

推荐模式：

- 在主工作副本的 supervisor 会话执行编排。
- worker 仅在其绑定 worktree 内执行实现。
- supervisor 负责路由、验收闸门与最终集成。
- worker 负责任务内实现与本地校验（`check`、`fmt`、`test` 及项目要求校验）。
- 不要只依赖 GitHub CI 作为 child 完成信号，需提供明确就绪证据。
- 必要校验证据缺失或失败时不得集成。

集成策略：

- 纯 git 流程：检查通过后进行确定性本地集成。
- GitHub 流程：执行 PR/检查/合并前需先安装并认证 `gh`。

## 状态存储

绑定条目存储路径：

- `$XDG_STATE_HOME/opencode/workbench/entries/`
- 回退：`~/.local/state/opencode/workbench/entries/`

## Studio 集成说明

- Manifest：`dist/studio.manifest.json`
- Bridge：`dist/studio-bridge.js`
- Web 挂载：`dist/studio-web/workbench-bar.js`

Studio 面板可展示绑定/会话元数据，便于 supervisor 快速掌握路由状态。

## 高级示例

```text
workbench { action: "open", dir: ".workbench/feature-x", name: "feature-x" }
workbench { action: "task", dir: ".workbench/feature-x", prompt: "Implement feature" }
workbench { action: "bind", name: "my-thing", upstream: "org/repo", fork: "me/repo", prUrl: "https://github.com/org/repo/pull/123" }
workbench { action: "bind", name: "my-thing", clear: "github" }
workbench { action: "doctor" }
```
