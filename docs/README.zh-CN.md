# herdr-cc-tg-bridge

在 Telegram 群的话题里使用电脑上的 Claude Code 会话。一个话题对应一个会话，会话由终端会话管理器 [Herdr](https://herdr.dev) 管理。你在手机上操作的就是电脑上那个会话本身，记忆、配置、hook、skill 都照常生效。回到电脑前，在终端里打开 Herdr 就能接着用。

这是一个用 Bun 写的小程序，没有运行时依赖，装好后的命令名叫 `tg-bridge`。本项目是个人独立项目，与 Anthropic 没有关联，也没有得到 Anthropic 的认可。它运行的是官方原版 Claude Code，用的是你自己的账号。

## 快速上手

**需要准备**一台 Mac（macOS 13 或更新），一个包含 Claude Code 的 Claude 套餐（Pro、Max、Team、Enterprise 或 Console 账号都可以），手机上的 Telegram，大约 10 分钟。Linux 理论上可用，还没测过。

### 1. 新建一个 bot（1 分钟）

在 Telegram 里打开 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，按提示取一个名字，再取一个以 `bot` 结尾的用户名。BotFather 会回复一串 token，形如 `123456789:AAH...`。token 不要给别人，最好专门新建一个 bot 给它用。

### 2. 运行安装脚本（约 3 分钟）

打开「终端」App，粘贴下面这行。

```sh
curl -fsSL https://raw.githubusercontent.com/KasparChen/herdr-cc-tg-bridge/main/install.sh | sh -s -- --lang zh
```

脚本会检查 Bun、Herdr、Claude Code，缺哪个就用官方安装脚本装上，装之前会问你一次。然后把项目下载到 `~/.local/share/herdr-cc-tg-bridge`，再让你粘贴 bot token，输入时屏幕上不显示。

### 3. 建群（约 3 分钟，脚本会等你）

1. 在 Telegram 里新建一个群，成员里加上你的 bot。
2. 打开群设置（编辑），打开「话题」（Topics）。
3. 还是在群设置里，进「管理员」，把 bot 添加为管理员，打开「管理话题」「置顶消息」「删除消息」三项。
4. 在群里发送脚本显示的那一行，例如 `/start@your_bot 482913`。后面的数字是这次安装的一次性口令。

脚本随后列出它认出的群和账号，确认是你自己的就输入 `y`。会话目录直接回车，用默认的 `~/tg-sessions`。

### 4. 登录并试用（2 分钟）

安装结束时会打印类似下面的一行。运行它，按提示登录 Claude Code，问到「是否信任此文件夹」时选信任，然后输入 `/exit` 退出。

```sh
cd ~/tg-sessions && ~/.local/bin/claude
```

然后打开群。General 里有一条置顶的 🟢 消息，说明 bridge 已在线。在 General 里发 `/new`，会出现一个新话题，里面是一个全新的 Claude 会话。在这个话题里发消息，就和在终端里打字一样。

你发的每条消息上都会有一个 reaction，表示它走到了哪一步。👀 是收到了，✍ 是 Claude 正在处理，🤔 是在等你选择，回答发完后标记消失。在话题里发 `/help` 可以看全部命令。

### 遇到问题

| 你看到的 | 怎么办 |
|---|---|
| 新开的终端里提示找不到 `claude` 或 `herdr` | 重新开一个终端窗口（脚本已经把 `~/.local/bin` 加进 PATH），或者用完整路径 `~/.local/bin/claude` |
| 脚本一直在等群里的消息 | 检查 bot 是否在群里、话题有没有打开、消息里有没有带口令，然后再发一次 |
| 提示「bot 缺少管理员权限」 | 在群的管理员设置里打开对应的权限，再回车 |
| 置顶状态是 🟡，显示 Herdr 连不上 | 运行一次 `~/.local/bin/herdr`。每次电脑重启后都要这样做一次 |
| 话题里一开始就回复「会话在等你操作」 | Claude 在问是否信任这个文件夹。运行一次第 4 步那一行，或者在话题里发 `/keys enter` |
| 发出的消息上一直没有任何 reaction | bridge 没收到。可能是电脑睡着了、断网了，或者 bridge 停了。用 `~/.local/share/herdr-cc-tg-bridge/bin/tg-bridge status` 查看，日志在 `~/.tg-bridge/bridge.log` |
| 想换 bot 或换群 | 重新运行一次安装脚本 |

卸载用 `sh ~/.local/share/herdr-cc-tg-bridge/install.sh --uninstall`，只停掉后台服务，文件保留。

**需要知道的几点。** 只有你自己的 Telegram 账号能用这个 bridge，而它能通过 Claude Code 在你电脑上执行命令，所以 bot token 一定不要外传。电脑要开着且没有睡眠，合上盖子会睡眠，消息会等到电脑醒来再处理。安装脚本刚做好，如果装不上，请把终端输出贴到 [issue](https://github.com/KasparChen/herdr-cc-tg-bridge/issues) 里。想要英文提示，去掉命令最后的 `-s -- --lang zh` 即可。

## 能做什么

- 在话题外发 `/new 名字`，bridge 会新建一个话题，同时在 Herdr 里开一个标签页启动 Claude。
- 在 Telegram 里手动新建话题，bridge 会自动开一个新会话绑上去。
- 在 Telegram 里管理会话的全过程。`/close` 或在客户端里关闭话题，会结束会话并关闭话题；重新打开话题或直接在话题里发消息，会接着原会话；`/delete` 删除话题和会话；`/sessions` 列出全部会话。电脑上已经在聊的会话，在里面输入 `/tg-bind` 就能接到一个新话题，在手机上接着用。
- 在话题里发文字、图片、文件，都会送进对应的会话。图片和文件先存到本地，再把路径附在消息里。
- 每一轮回复先出一条可折叠的进度气泡，实时显示调用了哪些工具；结束后气泡标记为完成，再单独发出最终回答。
- 会话用 Write 工具新建的交付文件（图片、PDF、Office 文档、压缩包、HTML 等）会自动发回话题。脚本生成的文件，会话会用 `tg-send` 命令主动发送。
- 会话弹出选择题时，话题里会出现按钮，点一下就把答案送回会话。
- 会话起好标题后，话题名和 Herdr 标签页名会同步改成这个标题。
- 桥接状态可以在群里的置顶消息、`/status` 命令和 Herdr Space 上的状态标签这三处看到。

## 手动安装

一键安装脚本会替你做完下面这些步骤。在 Linux 上或者想自己配置时，可以照下面手动操作。

### 准备

1. 准备一台 macOS 电脑（Linux 理论上可用但未测，登录自启脚本只支持 macOS），装好下面这些软件。
   - [Bun](https://bun.sh)（在 1.3.14 上测试过）
   - Herdr（在 0.8.0 上测试过，0.9.x 未测）
   - Claude Code
   - `python3` 和 `curl`（`bin/tg-send` 要用）
2. 执行 `herdr integration install claude`，安装 Herdr 的 Claude 集成。它会给 Claude Code 加一个启动 hook，把会话 ID 报给 Herdr。bridge 只能接管装好这个 hook 之后启动的会话。
3. 在 Telegram 里找 [@BotFather](https://t.me/BotFather)，发 `/newbot` 新建一个 bot，记下 token。
4. 新建一个群，按下面两步设置。
   - 在群设置里打开「话题」（Topics），群会自动升级成超级群。
   - 把 bot 拉进群，设为管理员，并勾选「管理话题」（Manage Topics）和「置顶消息」（Pin Messages），状态消息要置顶。bot 是管理员时能收到群里的所有消息，不需要关闭隐私模式。
5. 查出群 ID 和你自己的用户 ID。
   - 在群里随便发一条消息，然后打开 `https://api.telegram.org/bot<token>/getUpdates`，结果里的 `chat.id` 就是群 ID，是一个以 `-100` 开头的负数。
   - 同一个结果里的 `from.id` 就是你自己的用户 ID。

### 配置

```sh
cp .env.example .env
```

| 配置项 | 必填 | 说明 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 是 | BotFather 给的 token |
| `TG_CHAT_ID` | 是 | 群 ID |
| `TG_ALLOWED_USERS` | 是 | 允许操作的用户 ID，多个用逗号分隔。其他人发的消息一律忽略 |
| `TG_BRIDGE_WORKDIR` | 是 | 新会话的工作目录。Claude Code 从这里读取 CLAUDE.md 和项目记忆。要用家目录下的子目录，不要直接用家目录，因为 Claude Code 每次启动都会重新问是否信任家目录 |
| `HERDR_WORKSPACE` | 否 | 新会话开在哪个 Herdr Space，填 ID 或名字都可以。不填就开在当前 Space |
| `TG_AUTOSEND_EXT` | 否 | 自动回传的文件扩展名。默认不含 `md` 和 `txt`，避免把笔记和草稿发出去 |
| `TG_CLAUDE_ARGS` | 否 | 启动新会话时附加给 `claude` 的参数 |
| `TG_BRIDGE_LANG` | 否 | bot 消息的语言，`en`（默认）或 `zh`。一键安装会按你运行时选的语言写好 |

其余配置项的说明见 `.env.example`。token 也可以不写进 `.env`，改在启动前用环境变量传入，例如用你自己的密钥管理工具注入。环境变量的优先级高于 `.env`。

### 启动

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
| 任意位置 | `/new 名字` | 新建话题和会话。不写名字时，等会话起好标题后自动改名 |
| 任意位置 | `/sessions` | 列出全部会话、状态、上下文占用、最后活动时间和额度，每个会话一排按钮（关闭或接回或重开，以及删除） |
| 电脑上的会话里 | `/tg-bind`，断开用 `/tg-bind off` | 把这个会话接到一个新话题，先发接手卡片和上一轮回答，之后两边同步 |
| 任意位置 | `/status`、`/help` | 看 bridge 状态、看用法 |
| 话题里 | `/resend` | 把上一轮回答里可能没发出去的部分（标 😱 的）再发一次 |
| 话题里 | 文字、图片、文件 | 送进这个话题对应的会话 |
| 话题里 | `/clear` 等斜杠命令 | 原样送进会话。`/clear` 之后就是新的上下文 |
| 话题里 | `/stop` | 打断会话当前的回复 |
| 话题里 | `/screen` | 看会话屏幕的最后 30 行 |
| 话题里 | `/keys down enter` | 往会话发按键，用来应对没做按钮的弹窗 |
| 话题里 | `/close` | 结束会话并关闭话题，聊天记录保留。在客户端里关闭话题效果一样 |
| 话题里 | `/delete` | 点确认后结束会话，删除话题和全部聊天记录 |
| 客户端 | 重新打开已关闭的话题，或者直接在里面发消息 | 接着原会话（`claude --resume`），上下文都在 |
| 客户端 | 给话题改名 | Herdr 标签页同步改名，之后不再按会话标题自动改名 |

电脑上的会话断了（标签页被关掉，或者 Claude 退出了），话题里只提示一次，附「接着原会话」「开新会话」「关闭话题」三个按钮。不点按钮直接发消息，也会接着原会话。话题被删除后，bridge 会在发消息失败时或者每小时的探测中发现，然后结束窗格并删除绑定。在输入框敲 `/` 可以看到 bridge 的全部命令。

用 `/tg-bind` 接过来的是电脑会话。在 Telegram 里关闭或删除它的话题，只断开 Telegram，电脑上的会话继续开着，标签页名也不变。重新打开话题、在话题里发消息，或者再运行一次 `/tg-bind`，都会重新连上原来的话题。只有装了 Herdr 的 Claude hook 之后启动的会话能绑定。

每轮结束时，进度气泡的标题行会显示上下文占用，例如「ctx 43% (430k)」，超过 80% 时提醒一次。在 `.env` 里用 `TG_USAGE_FILE`、`TG_FABLE_USAGE_FILE` 指定额度文件后，置顶消息、`/status` 和 `/sessions` 会显示 5 小时、7 天和 Fable 额度，文件格式见 `.env.example`。

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
| 群里的置顶消息 | 每 30 秒原地刷新一次，内容包括状态、会话数和最后更新时间，下方「🔄 刷新」按钮可手动刷新 | 正常退出或崩溃时立刻变成红色 |
| `/status` | 在群里发送，返回同样的内容 | bridge 不在线时没有回复 |
| Herdr Space 状态标签 | 标签名是 `tg`，值是 🟢 加会话数，例如 `🟢 2` | 90 秒没刷新就自动消失 |

bridge 运行期间会用 `caffeinate` 阻止 Mac 闲置休眠，不需要时把 `TG_BRIDGE_CAFFEINATE` 设为 0。合上盖子仍然会休眠。电脑睡眠或关机时，bridge 发不出任何消息，置顶消息不会变红，只会停止刷新。所以「最后更新时间」超过 2 分钟没变，就说明 bridge 或电脑已经离线。

你在话题里发的每条消息都会带一个 reaction，表示它走到了哪一步。👀 是 bridge 收到了，✍ 会话已经接手（排队时保持 👀），🤔 在等你选择，回答全部发完后标记消失。💔 表示没送进会话，或者回答有一部分被 Telegram 拒绝；😱 表示回答有一部分没收到 Telegram 的回执，可能没发出去，在话题里发 `/resend` 会把这部分再发一次。一条消息完全没有 reaction，说明 bridge 没收到。发消息、图片、文件和建话题这类请求，网络失败后不会自动重试，因为丢的可能只是回执，bot 又读不到群里的消息来核对，重试可能让同一个回答出现两次。

状态始终是同一条消息原地修改，只有这条消息被删掉时才发新的。修改失败不会改发新消息，两次刷新也不会同时进行，所以长时间断网或电脑从睡眠中醒来时不会在 General 里刷屏。bridge 异常时，如果连续 3 次刷新状态都没有变化（次数由 `TG_STATUS_PAUSE_AFTER` 设置），就停止自动刷新并在消息里注明，状态一有变化会自动恢复，随时可以点按钮手动刷新。

## 测试情况

在 macOS 上端到端验证过的有文字往返和进度气泡、图片上行、文件自动回传、`tg-send`、`/clear`、标题同步、崩溃标红和自动重启，以及守护脚本被杀后由 launchd 重新拉起。

会话生命周期（关闭、重新打开、`/exit` 或关标签页之后接回、删除、发现话题被删除、`/sessions`、`/tg-bind`）已通过本机模拟入口和 Bot API 验证。

安装脚本在 macOS 上用模拟的 Telegram 接口跑过配置流程，也在 UTF-8 和 C 两种语言环境、中英文两种提示下跑过 dry-run，直接运行和经 `sh` 管道运行都测了。还没有在一台全新的电脑上完整跑过，Linux 路径也还没测。消息上的 reaction 和 `/resend` 用模拟的 Telegram 接口验证过，英文版 bot 消息是离线渲染检查的。

还没用真实 Telegram 操作验证的有点选择题按钮和会话管理按钮，在客户端里手动新建、关闭、重新打开、改名、删除话题，真实断网后恢复、真实重启后自启。这几项的代码都在，只通过本机模拟入口跑过。

## 限制

- 只接管 bridge 新建的会话，以及装了 Herdr 的 Claude hook 之后启动的会话。
- 会话用脚本生成的文件，Claude Code 的会话记录里看不到路径，只能靠会话自己调用 `tg-send` 发送。
- Bot API 限制下载的文件不超过 20MB，上传的文件不超过 50MB。Telegram 会压缩照片，要原图请以文件形式发送。
- 多选题、一次多道题和其他弹窗没有做成按钮，bridge 会把屏幕内容发过来，用 `/keys` 回应。
- 只要用户 ID 在白名单里，就能在会话权限范围内执行任何操作，包括运行命令。请保管好 Telegram 账号。

## 工作方式

```text
                    ┌─────────────────── Telegram group (Topics) ───────────────────┐
     your phone ──► │ General   /new  /sessions  /status  · pinned status message   │
                    │ Topic A <-> session A   Topic B <-> session B   Topic C <-> C │
                    └───────────────────────────────┬───────────────────────────────┘
                                                    │ Bot API
                                                    │ in:  long polling (messages, files, button taps)
                                                    │ out: send / edit messages, files, topic actions
                    ┌───────────────────────────────▼───────────────────────────────┐
                    │ tg-bridge (one Bun process, kept alive by bin/tg-bridge)      │
                    │   router ──► lifecycle ──► one Watcher per bound topic        │
                    │   ~/.tg-bridge/state.json · inbox/ · local API 127.0.0.1      │
                    └──────────┬─────────────────────────────────────▲──────────────┘
           herdr CLI           │ prompt, status, keys,               │ tail
           (Herdr socket)      │ open / close panes                  │
                    ┌──────────▼─────────────────┐   writes   ┌───────┴────────────────────────┐
                    │ Herdr                      ├──────────► │ Claude Code transcripts        │
                    │   tab: claude  (topic A)   │            │ ~/.claude/projects/<cwd>/      │
                    │   tab: claude  (topic B)   │            │   <session id>.jsonl           │
                    │   your tab: claude (C)     │            └────────────────────────────────┘
                    └──────────┬─────────────────┘
                               └── tg-send / tg-bind, run inside a session ──► local API
```

设计上守三条规矩。

1. **会话归 Herdr 管。** bridge 自己不启动 Claude，只通过 Herdr 的命令行操作会话。它用 `herdr agent prompt` 送消息，用 `herdr agent get` 看状态，用 `herdr pane send-keys` 发按键，开关标签页也交给 Herdr。所以手机上和电脑上用的是同一个进程。
2. **回复从会话记录里读。** Claude Code 会把每一轮都写进一个 jsonl 文件。bridge 增量读这个文件，工具调用、正文、标题都是结构化的数据，不受终端排版影响。只有会话停下来等输入时，才去读屏幕内容。
3. **一个话题对应一个绑定。** `state.json` 记录每个话题对应的 Herdr 窗格、终端 ID 和 Claude 会话 ID。会话 ID 由 Herdr 的 Claude 集成（`herdr integration install claude`）上报，bridge 靠它找到会话记录文件。

**一轮对话的过程**

1. 你在话题 A 里发消息。router 查到这个话题的绑定；如果窗格已经不在，先用 `claude --resume <会话 ID>` 接回原会话。
2. 附件下载到 `~/.tg-bridge/inbox/<话题>/`，路径附在文字后面，一起用 `herdr agent prompt` 送进会话。
3. 话题 A 的 Watcher 每秒查一次 Herdr 状态，并读取会话记录的新内容。工具调用写进进度气泡，最快每 1.5 秒更新一次。
4. 会话记录里出现「本轮结束」（带正文的 `end_turn` 回复）时，气泡标记为完成并附上上下文占用，最终回答单独发出，这一轮用 Write 工具新建的交付文件按扩展名回传。这里按会话记录判断，不按 Herdr 状态判断，因为后台子任务会让会话在回答完之后很久还显示「运行中」。
5. 如果会话停下来等输入，单选题做成按钮，其他情况发屏幕内容。

绑定期间在电脑上输入的内容，会出现在气泡里，前面带 🖥，回答同样发到话题。

**各模块分工**

| 文件 | 负责什么 |
|---|---|
| `src/main.ts` | 入口和长轮询循环 |
| `src/router.ts` | 分发收到的命令、话题系统消息、附件和按钮点击 |
| `src/lifecycle.ts` | 开会话、接回、绑定电脑会话、关闭、删除、`/sessions`、发现被删的话题 |
| `src/session.ts` | Watcher，每个话题一个，查状态、读会话记录、渲染这一轮 |
| `src/transcript.ts` | 增量读取 jsonl，解析成工具、正文、标题、本轮结束等事件 |
| `src/render.ts` | 进度气泡、Markdown 转 Telegram HTML、按 4096 字分块 |
| `src/outbox.ts` | 判断哪些文件要回传 |
| `src/status.ts` | 在线判定、置顶状态消息、Herdr 状态标签 |
| `src/usage.ts` | 上下文占用和额度显示 |
| `src/telegram.ts` | Bot API 客户端，含超时、重试、限流处理、话题探测 |
| `src/herdr.ts` | Herdr 命令行的薄封装 |
| `src/control.ts` | 只监听 127.0.0.1 的本机接口，`/health`、`/send`、`/bind`、`/sim` |
| `src/store.ts` | `state.json`，存更新偏移量和话题绑定 |
| `bin/tg-bridge` | 守护脚本，崩溃重启、标红、持有防休眠断言 |
| `bin/tg-send`、`bin/tg-bind` | 在会话里运行，回传文件、绑定或断开当前会话 |
| `bin/install-launchd` | 安装 macOS 登录自启 |

**状态存在哪里**

| 内容 | 位置 | 归谁管 |
|---|---|---|
| 话题绑定、更新偏移量、是否已提示 | `~/.tg-bridge/state.json` | bridge |
| 你发过来的文件 | `~/.tg-bridge/inbox/<话题>/` | bridge |
| 会话进程和状态 | Herdr | Herdr |
| 对话内容 | `~/.claude/projects/*/<会话 ID>.jsonl` | Claude Code |

设计细节和取舍见 [PRD-v1.md](PRD-v1.md)，会话生命周期见 [PRD-v2.md](PRD-v2.md)。

## 开发

```sh
bun test                          # 单元测试
TG_BRIDGE_SIM=1 bin/tg-bridge     # 打开本机模拟入口
curl -X POST -H 'content-type: application/json' 127.0.0.1:18820/sim -d '{"thread":123,"text":"你好"}'
```

bot 收不到自己发的消息，模拟入口用来在本机冒充白名单用户发消息，做端到端测试。它只监听 127.0.0.1，只接受 JSON 请求，默认关闭。测完要关掉，开着的时候本机任何能访问这个端口的程序都能操作你的会话。
