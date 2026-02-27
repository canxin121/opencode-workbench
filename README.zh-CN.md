# opencode-workbench

English version: [README.md](README.md)

opencode-workbench 专为并发交付而设计：它将 git worktree 映射到 OpenCode 会话，让多个任务可以并行推进，同时保持路由清晰、职责明确和集成流程稳定。

## 为什么选择 Workbench

- 在独立分支/worktree 中高并发并行多个任务，避免互相冲突。
- 在一个 supervisor 工作流下扇出并行任务，并保持确定性路由。
- 在保证单会话执行安全的同时维持整体高并发吞吐。
- 以绑定维度记录分支/fork/PR 元数据，加速并行协作交付。
- 通过 supervisor/worker 边界提升多任务并发执行的可靠性与可扩展性。

## 安装

在 OpenCode 配置文件 `opencode.json` 中添加插件：

- Unix/macOS: `~/.config/opencode/opencode.json`
- Windows: `%USERPROFILE%\\.config\\opencode\\opencode.json` (for example: `C:\\Users\\<your-user>\\.config\\opencode\\opencode.json`)

```jsonc
{
  "plugin": ["opencode-workbench"]
}
```

可选版本锁定：

```jsonc
{
  "plugin": ["opencode-workbench@0.3.2"]
}
```

## 自然语言快速开始

示例提示：

```text
1. 使用 workbench 进行并发并行任务编排。任务列表如下: 1. ** 2. **
2. 使用 workbench 进行高并发并行工作，使用 gh，并一路执行到创建并合并 PR，无需再次确认。任务列表如下: 1. ** 2. **
```

## OpenCode Studio 集成体验

Workbench 内置 OpenCode Studio 集成，让并发分支/任务编排状态一目了然：

- 项目地址：[opencode-studio](https://github.com/canxin121/opencode-studio)

- 在 Studio 中查看会话绑定总览（worktree、branch、session 关联）。
- 可视化查看 fork/upstream/PR 元数据，提升协作效率。
- 在多 worker 会话并行时加强 supervisor 视角下的调度与复核。

对于长期进行多分支并行开发的团队，OpenCode Studio 是推荐的统一控制台，可降低上下文切换成本并保持路由一致性。

## 详细说明

更细的 action 合约、参数行为、scope/session 路由规则与治理建议，见 `DETAIL.zh-CN.md`。

## 许可证

MIT
