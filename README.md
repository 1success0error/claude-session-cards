# claude-session-cards

用置顶小卡片查看所有 Claude Code 会话的状态：思考中、执行中、等你确认、已完成、出错。状态来自 Claude Code hooks，不依赖其他工具。

## 安装

需要 Node.js 22.12 或更高版本，以及较新的 Claude Code（已在 2.1.318 上使用）。

```sh
npm install -g claude-session-cards
claude-session-cards install   # 把 hook 合并进 ~/.claude/settings.json，原文件会备份
claude-session-cards start     # 首次启动会下载 Electron
```

已经打开的 Claude Code 会话需要重启，或打开一次 `/hooks` 才会加载 hook。

## 命令

| 命令 | 作用 |
|---|---|
| `start` | 启动置顶卡片窗口，同时提供网页 `http://127.0.0.1:47831/` |
| `start --web` | 不开窗口，只提供网页 |
| `start --tailscale` | 同时监听 Tailscale 地址，手机可以只读查看 |
| `stop` / `status` | 退出 / 查看状态 |
| `install --dsh-pet` | 额外联动 DeepSeek Harness 的 dsh-pet 桌宠 |
| `uninstall [--purge]` | 移除 hook；`--purge` 同时删除本地数据 |

Electron 下载慢或失败时，可以设置 `ELECTRON_MIRROR` 后重试，或者用 `start --web`。

## 卡片操作

- 拖动顶部状态条移动位置，点箭头收起。
- 左键点卡片跳转到对应的终端窗口。Windows Terminal 会同时切到对应标签页；其他平台暂不支持跳转，改为复制恢复命令。
- 右键卡片可以复制恢复命令或会话 ID、移除卡片，以及切换窗口置顶。
- 右键托盘图标可以隐藏、切换置顶或退出。
- 手机和网页只读，点卡片是复制恢复命令。

## 平台支持

| 平台 | 置顶卡片 | 网页 |
|---|---|---|
| Windows | 已使用 | 已使用 |
| macOS | 未测试 | 未测试 |
| Linux | 未测试；不支持点击穿透，透明和置顶取决于桌面环境 | 未测试 |

## 隐私

- 本地保存提示词前 120 个字、项目路径、工具描述、会话 ID、进程链和 transcript 路径（`~/.claude-session-cards/state.json`），24 小时无活动后清除。进程链和 transcript 路径只用于跳转窗口，不会出现在网页接口里。
- 不上报命令原文，URL 不含查询串，不向任何外部服务发送数据。
- 默认只监听 127.0.0.1。`--tailscale` 开启后，tailnet 内的设备无需登录即可查看上述信息，只有自己的 tailnet 才建议开启。

## 已知限制

- 进度条只在会话使用任务清单时显示，Claude Code 不提供真实的完成百分比。
- 按 Esc 中断或进程被强杀时可能没有结束事件，卡片 30 分钟后才显示“可能已中断”。
- 不做定时重新置顶，以免打断全屏游戏和截图；卡片被盖住时，从托盘隐藏再显示即可。
