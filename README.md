# dsh-forget

Delete conversation history (sessions) in **DeepSeek Harness** — right from the sidebar, no commands needed.

删除 DeepSeek Harness 里的历史对话（会话）。侧边栏点「...」即可删除，不用敲命令。

## What it does / 功能

DeepSeek Harness 的会话持久层是只追加的，官方没有提供删除 API（源码文档原文：*"Nothing deletes session files"*）。本插件在 Host 进程内补齐删除能力，并在侧边栏会话行的「...」菜单里加一个 **删除** 动作。

- **Sidebar / 侧边栏**：会话行点「...」→「删除」→（再次点击）「确认删除？」，即可永久删除该会话。
- **Command / 命令**：也提供 `/forget` 斜杠命令：
  - `/forget` 或 `/forget list` — 列出所有会话
  - `/forget <session-id>` — 按 id 删除
  - `/forget <标题关键词>` — 按标题删除
  - `/forget --all` — 删除除当前会话外的所有历史会话

删除一个会话时会：从工作区账目移除该会话、删除磁盘上的会话日志目录（`<DSH_HOME>/sessions/...`）、清理投影缓存。

> 当前正在进行的会话无法删除：请先「新建会话」切过去，再回来删旧的。

## Install / 安装

在 DSH 的插件管理器里把本目录作为 bundle 安装，或在配置里追加：

```yaml
- insert:
    - id: forget
      name: 'dsh-forget'
```

## Structure / 结构

```
dsh-forget/
├── package.json        # 包清单（host 命令 + client 菜单声明）
├── cordis.patch.yml    # bundle patch：挂载一行插件
├── lib/index.js        # Host 半边：/forget 命令 + 删除逻辑
├── client.js           # 浏览器半边：侧边栏「...」菜单的「删除」项
├── LICENSE
└── README.md
```

## License

[MIT](./LICENSE)
