# tg-bridge

在 Telegram 群的话题里使用电脑上的 Claude Code 会话。一个话题对应一个会话，会话由终端会话管理器 Herdr 管理。你在手机上操作的就是电脑上那个会话本身，记忆、配置、hook、skill 都照常生效。回到电脑前，在终端里打开 Herdr 就能接着用。

## 能做什么

- 在话题外发 `/new 名字`，bridge 会新建一个话题，同时在 Herdr 里开一个标签页启动 Claude。
- 在 Telegram 里手动新建话题，bridge 会自动开一个新会话绑上去。
- 在话题里发文字、图片、文件，都会送进对应的会话。图片和文件先存到本地，再把路径附在消息里。
- 每一轮回复先出一条可折叠的进度气泡，实时显示调用了哪些工具；结束后气泡标记为完成，再单独发出最终回答。
- 会话用 Write 工具新建的交付文件（图片、PDF、Office 文档、压缩包、HTML 等）会自动发回话题。脚本生成的文件，会话会用 `tg-send` 命令主动发送。
- 会话弹出选择题时，话题里会出现按钮，点一下就把答案送回会话。
- 会话起好标题后，话题名和 Herdr 标签页名会同步改成这个标题。
- 桥接状态可以在群里的置顶消息、`/status` 命令和 Herdr Space 上的状态标签这三处看到。

## 准备

1. 准备一台 macOS 或 Linux 电脑，装好下面三个软件。
   - [Bun](https://bun.sh)（在 1.3.14 上测试过）
   - Herdr（在 0.8.0 上测试过）
   - Claude Code
2. 执行 `herdr integration install claude`，安装 Herdr 的 Claude 集成。它会给 Claude Code 加一个启动 hook，把会话 ID 报给 Herdr。bridge 只能接管装好这个 hook 之后启动的会话。
3. 在 Telegram 里找 [@BotFather](https://t.me/BotFather)，发 `/newbot` 新建一个 bot，记下 token。
4. 新建一个群，按下面两步设置。
   - 在群设置里打开「话题」（Topics），群会自动升级成超级群。
   - 把 bot 拉进群，设为管理员，并勾选「管理话题」（Manage Topics）。bot 是管理员时能收到群里的所有消息，不需要关闭隐私模式。
5. 查出群 ID 和你自己的用户 ID。
   - 在群里随便发一条消息，然后打开 `https://api.telegram.org/bot<token>/getUpdates`，结果里的 `chat.id` 就是群 ID，是一个以 `-100` 开头的负数。
   - 同一个结果里的 `from.id` 就是你自己的用户 ID。

## 配置

```sh
cp .env.example .env
```

| 配置项 | 必填 | 说明 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 是 | BotFather 给的 token |
| `TG_CHAT_ID` | 是 | 群 ID |
| `TG_ALLOWED_USERS` | 是 | 允许操作的用户 ID，多个用逗号分隔。其他人发的消息一律忽略 |
| `TG_BRIDGE_WORKDIR` | 是 | 新会话的工作目录。Claude Code 从这里读取 CLAUDE.md 和项目记忆 |
| `HERDR_WORKSPACE` | 否 | 新会话开在哪个 Herdr Space，填 ID 或名字都可以。不填就开在当前 Space |
| `TG_AUTOSEND_EXT` | 否 | 自动回传的文件扩展名。默认不含 `md` 和 `txt`，避免把笔记和草稿发出去 |
| `TG_CLAUDE_ARGS` | 否 | 启动新会话时附加给 `claude` 的参数 |

其余配置项的说明见 `.env.example`。token 也可以不写进 `.env`，改在启动前用环境变量传入，例如用你自己的密钥管理工具注入。环境变量的优先级高于 `.env`。

## 启动

两种方式任选一种。

**登录后自动启动（macOS）**

```sh
bin/install-launchd              # 安装并立即启动
bin/install-launchd uninstall    # 停止并移除
```

脚本会生成一个 LaunchAgent，登录后自动启动 bridge，日志写到 `~/.tg-bridge/bridge.log`。安装前可以用两个环境变量调整。

| 变量 | 作用 |
|---|---|
| `TG_BRIDGE_LABEL` | launchd 任务名，默认 `local.tg-bridge` |
| `TG_BRIDGE_LAUNCH_PREFIX` | 放在启动命令前面的命令，例如用你的密钥管理工具注入 token |

项目如果放在桌面、文稿这类受隐私保护的目录里，要先在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里给 `/bin/bash` 授权，否则后台任务读不到项目文件。

**手动启动**

建议在 Herdr 里单独开一个标签页，运行下面的命令。

```sh
bin/tg-bridge
```

`bin/tg-bridge` 是一个守护脚本，负责下面三件事。

- bridge 进程崩溃时，先把状态标成红色，3 秒后自动重启。
- 断网或电脑刚开机网络还没就绪时，会一直重试，网络恢复后自动连上。
- 按 Ctrl+C 停止。停止时状态同样会标成红色。

用下面的命令查看本机健康状态。

```sh
bin/tg-bridge status
```

Herdr 服务要等你打开 Herdr 才会运行。在那之前 bridge 能收到消息，但没法操作会话，状态里会显示 Herdr 连不上。

## 使用

| 在哪里 | 发什么 | 效果 |
|---|---|---|
| 话题外 | `/new 名字` | 新建话题和会话。不写名字时，等会话起好标题后自动改名 |
| 话题外 | `/status`、`/help` | 看 bridge 状态、看用法 |
| 话题里 | 文字、图片、文件 | 送进这个话题对应的会话 |
| 话题里 | `/clear` 等斜杠命令 | 原样送进会话。`/clear` 之后就是新的上下文 |
| 话题里 | `/stop` | 打断会话当前的回复 |
| 话题里 | `/screen` | 看会话屏幕的最后 30 行 |
| 话题里 | `/keys down enter` | 往会话发按键，用来应对没做按钮的弹窗 |

在会话里用 `tg-send` 把文件或文字发回话题。

```sh
bin/tg-send report.pdf chart.png
bin/tg-send --text "跑完了"
```

`tg-send` 通过 Herdr 自动设置的环境变量 `HERDR_PANE_ID` 找到对应的话题，所以只能在 bridge 绑定过的会话里使用。bridge 新建的会话启动时会收到一段说明，告诉 Claude 这个命令的用法，不需要你另外交代。

## 怎么看 bridge 是否在线

bridge 在线要同时满足两点，一是最近 90 秒内成功收过一次 Telegram 消息，二是 Herdr 能连上。只看进程是否活着不够，断网时进程还在，但已经收不到消息。

| 位置 | 怎么看 | bridge 停掉或崩溃时 |
|---|---|---|
| 群里的置顶消息 | 每 30 秒刷新一次，内容包括状态、会话数和最后更新时间 | 正常退出或崩溃时立刻变成红色 |
| `/status` | 在群里发送，返回同样的内容 | bridge 不在线时没有回复 |
| Herdr Space 状态标签 | 标签名是 `tg`，值是 🟢 加会话数，例如 `🟢 2` | 90 秒没刷新就自动消失 |

电脑睡眠或关机时，bridge 发不出任何消息，置顶消息不会变红，只会停止刷新。所以「最后更新时间」超过 2 分钟没变，就说明 bridge 或电脑已经离线。

## 限制

- 只接管 bridge 新建的会话，以及装了 Herdr 的 Claude hook 之后启动的会话。
- 会话用脚本生成的文件，Claude Code 的会话记录里看不到路径，只能靠会话自己调用 `tg-send` 发送。
- Bot API 限制下载的文件不超过 20MB，上传的文件不超过 50MB。Telegram 会压缩照片，要原图请以文件形式发送。
- 多选题和其他弹窗没有做成按钮，bridge 会把屏幕内容发过来，用 `/keys` 回应。
- 只要用户 ID 在白名单里，就能在会话权限范围内执行任何操作，包括运行命令。请保管好 Telegram 账号。

## 工作方式

bridge 不自己启动 Claude 进程，只通过下表中 Herdr 的命令行接口操作会话。

| 动作 | 怎么做 |
|---|---|
| 送消息 | `herdr agent prompt` |
| 看状态 | `herdr agent get` |
| 发按键 | `herdr pane send-keys` |

回复内容从 Claude Code 的会话记录文件（`~/.claude/projects/` 下的 jsonl）增量读取。设计细节和取舍见 [docs/PRD-v1.md](docs/PRD-v1.md)。

## 开发

```sh
bun test                          # 单元测试
TG_BRIDGE_SIM=1 bin/tg-bridge     # 打开本机模拟入口
curl -X POST 127.0.0.1:18820/sim -d '{"thread":123,"text":"你好"}'
```

bot 收不到自己发的消息，模拟入口用来在本机冒充白名单用户发消息，做端到端测试。它只监听 127.0.0.1，默认关闭。
