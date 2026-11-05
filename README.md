# claude-session-cards

用置顶小卡片查看所有 Claude Code 会话的状态：思考中、执行中、等你确认、已完成、出错。状态来自 Claude Code hooks，不依赖其他工具。

## 安装

需要 Node.js 22.12 或更高版本、Git，以及较新的 Claude Code（已在 2.1.318 上使用）。目前还没有发布到 npm，请从 GitHub 安装，不需要配置 SSH 密钥：

```sh
npm install -g github:RandomBinaryTree/claude-session-cards
claude-session-cards install   # 把 hook 合并进 ~/.claude/settings.json，原文件会备份
claude-session-cards start     # 首次启动会下载 Electron
```

以后升级重新运行第一条命令即可。

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
- 一轮结束或出错时卡片会闪烁提示，单击卡片确认后恢复；收起时状态条也会提示。
- 双击卡片跳转到对应的终端窗口。Windows Terminal 会同时切到对应标签页；其他平台暂不支持跳转，改为复制恢复命令。
- 卡片显示会话标题，可以右键“修改标题”，留空恢复自动标题。改过的标题只保存在本工具里，同样显示在历史列表中，不改变 Claude Code 自己的记录和终端标签名。
- 右键卡片可以复制恢复命令或会话 ID、移除卡片，以及切换窗口置顶。
- 右键卡片或状态条可以切换外观（跟随系统、深色、浅色）和卡片透明度。手机网页跟随手机的系统主题。
- 点状态条上的“历史”查看历史会话，可以按标题、提示词或路径搜索，按项目筛选。点击后在新的 Windows Terminal 标签页恢复；会话还开着时改为切到它的窗口，其他平台改为复制恢复命令。Claude Code 默认只保留 30 天的记录（`cleanupPeriodDays`）。
- 右键托盘图标可以隐藏、切换置顶、查看历史或退出。
- 手机和网页只读，点卡片是复制恢复命令。

## 平台支持

| 平台 | 置顶卡片 | 网页 |
|---|---|---|
| Windows | 已使用 | 已使用 |
| macOS | 未测试 | 未测试 |
| Linux | 未测试；不支持点击穿透，透明和置顶取决于桌面环境 | 未测试 |

## 隐私

- 本地保存提示词前 120 个字、项目路径、工具描述、会话标题、会话 ID、进程链和 transcript 路径（`~/.claude-session-cards/state.json`），24 小时无活动后清除。进程链和 transcript 路径只用于跳转窗口和读取标题，不会出现在网页接口里。你改过的标题单独保存在 `titles.json`，不会自动清除。
- 不上报命令原文，URL 不含查询串，不向任何外部服务发送数据。
- 历史会话直接读取 Claude Code 的记录文件，不另存副本，只能在本机查看，不随 `--tailscale` 开放。
- 默认只监听 127.0.0.1。`--tailscale` 开启后，tailnet 内的设备无需登录即可查看上述信息，只有自己的 tailnet 才建议开启。

## 已知限制

- 进度条只在会话使用任务清单时显示，Claude Code 不提供真实的完成百分比。
- 按 Esc 中断或进程被强杀时可能没有结束事件，卡片 30 分钟后才显示“可能已中断”。
- 不做定时重新置顶，以免打断全屏游戏和截图；卡片被盖住时，从托盘隐藏再显示即可。
