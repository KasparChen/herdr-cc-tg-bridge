# tg-bridge v4 多后端：Claude、自定义 Claude 命令、Codex

状态 CONFIRMED
版本 v4
前版路径 `docs/PRD-v3.md`（CONFIRMED 2026-10-08，保留不改）；`docs/PRD-v3-codex.md`（外部 PR #1 附带的 Codex 说明，随 PR 合入，保留不改）
依据 2026-11-10 使用者开始用一个包装命令（同一个 `claude`，换了 API 网关和 key）起会话。bridge 只会用 `claude` 起会话，这类会话在 TG 里被接回时会悄悄换成订阅版；同时希望在同一个群里用 Codex。外部 PR #1（Codex 支持）10-18 收到 review 意见后 23 天没有更新
确认依据 2026-11-10 对话：同群按话题区分、`/new <后端> 名字` 指定后端、新增 `/config` 切换默认后端、本机默认后端设为该自定义后端、加 `/switch`、PR #1 不再等作者，直接合入本版本
定稿日期 2026-11-10

## 结论

v4 把「用什么命令起会话」从写死的 `claude` 改成可配置的后端。一个群里同时跑三种会话：

| 后端 | 起会话的方式 | 会话记录 | 怎么来的 |
|---|---|---|---|
| `claude` | `herdr agent start --kind claude` | `~/.claude/projects` | 内置 |
| `codex` | `herdr agent start --kind codex` | `~/.codex/sessions` | 内置，来自 PR #1 |
| `gw` 等自定义 | 在窗格里运行 `.env` 里配的命令 | 与 `claude` 共用 | 本机 `.env` 配置 |

每个话题记住自己的后端，重启、关闭再打开、窗格没了自动接回，一律用原后端。默认后端用 `/config` 随时切换。

## 命令

| 命令 | 行为 |
|---|---|
| `/new 名字` | 用默认后端新建话题和会话。客户端里手动建话题同样用默认后端 |
| `/new gw 名字`、`/new codex 名字`、`/new claude 名字` | 指定后端。第一个词是后端名才算指定，否则整句都是名字 |
| `/config` | 显示当前默认后端和全部可用后端，每个后端一个按钮，点一下设为默认，消息原地刷新 |
| `/config default codex` | 文字形式设默认后端 |
| `/switch gw` | 在本话题里换后端接着聊：结束当前会话，用新后端 `--resume` 同一个 session |
| `/switch` | 不带参数时列出本话题可以换的后端按钮 |

## 默认后端

- 存在 `state.json` 的 `defaultBackend`，`/config` 改完立即生效，重启不丢。
- `state.json` 里没有时，依次读 `.env` 的 `TG_DEFAULT_BACKEND`、PR #1 的 `TG_AGENT_KIND`，都没有就用 `claude`。
- 记下的默认后端后来从 `.env` 里删掉了，启动时退回 `claude` 并写日志，`/config` 里能看到。

## 自定义后端

在 `.env` 里配置，仓库里只放机制和示例：

```
TG_BACKENDS=gw
TG_BACKEND_GW_CMD=claude-gw
TG_BACKEND_GW_BASE_URL=https://gw.example.com
```

| 键 | 含义 |
|---|---|
| `TG_BACKENDS` | 自定义后端名，逗号分隔，只收小写字母、数字、`-`、`_`，不能叫 `claude` 或 `codex` |
| `TG_BACKEND_<名>_CMD` | 起会话的命令，原样交给窗格里的 shell，可以带参数 |
| `TG_BACKEND_<名>_KIND` | 会话类型 `claude`（默认）或 `codex`，决定参数格式和会话记录在哪读 |
| `TG_BACKEND_<名>_BASE_URL` | 可选。电脑会话 `/tg-bind` 时，环境变量 `ANTHROPIC_BASE_URL` 等于这个值就认成该后端 |

启动方式：Herdr 的 `agent start` 只认官方可执行文件，所以自定义后端用 `herdr pane run` 在窗格里运行命令，bridge 自己对参数做 shell 转义（`pane run` 不转义，已实测），等 Herdr 认出会话并上报 session id 后，用 `agent rename` 改名为 `tg-<话题号>`。需要窗格里的 shell 是 bash、zsh 这类 POSIX shell。

## 区分后端

- `/new` 建的话题按后端定图标颜色：`claude` 黄、`gw` 等自定义依次紫、蓝、粉、红，`codex` 绿。颜色只能在建话题时指定，客户端里手动建的话题保持客户端选的颜色。
- 「新会话已就绪」「已接回原会话」「已从电脑接过来」三条提示都写后端名。
- `/sessions` 每行写后端名。

## `/tg-bind` 识别后端

- Codex 窗格按 Herdr 报的类型认成 `codex`。
- Claude 窗格：`bin/tg-bind` 把调用方环境里的 `ANTHROPIC_BASE_URL` 一起发给 bridge，命中某个自定义后端的 `BASE_URL` 就记成该后端，否则记成 `claude`。
- 旧绑定没有后端字段：Codex 类型记 `codex`，其余记 `claude`，行为与 v3 一致。

## `/switch`

| 情况 | 行为 |
|---|---|
| 目标后端与当前相同 | 提示已经是该后端 |
| 会话类型不同（Claude 系与 Codex 互切） | 拒绝。两边会话记录格式不同，提示用 `/new codex` 另开 |
| 会话正在回复或等你选择 | 拒绝，提示等这一轮结束或先 `/stop` |
| 会话空闲 | 解除跟踪，向会话发 `/exit`，最多等 20 秒窗格回到 shell，再在同一窗格用新后端 `--resume` 原 session，恢复跟踪 |
| 窗格已退出、标签页已关、话题已关闭 | 只改记下的后端，按 v2 的接回流程用新后端接回 |
| 还没有 session id 或会话记录 | 只改记下的后端，下一条消息用新后端开新会话 |

从电脑接过来的会话也能切，窗格和标签页不变，仍算电脑会话。

## 随 PR #1 合入的修正

| 问题 | 处理 |
|---|---|
| Claude 窗格继承了 `CODEX_THREAD_ID` 时 `tg-send`、`tg-bind` 失效 | 只有该 id 确有 Codex 会话记录时才按 session 查，否则按窗格查（10-18 已写好的 `1a9c750`） |
| Codex 0.166 的 `debug prompt-input` 输出多条 developer 消息，PR 只读第一条，读不到用户自己的 `developer_instructions`，bridge 开的 Codex 会话因此不加 tg-send 说明 | 在含标记的那条 developer 消息里找 |
| 电脑会话的话题名取 Herdr 标签页名，标签页名是默认序号（`1`、`2`）时话题会叫「1」 | 纯数字标签页名不用，退回会话标题；同步标签页名时同样跳过纯数字 |

合并方式：保留作者的两个提交，后接修正和 v4 提交，推到 main 后 GitHub 自动把 PR #1 标为已合并。推送和在 PR 上留言要使用者同意后再做。

## 不做的

- 拆群或拆 bot：一个话题对应一个会话已经能区分，拆群要多建群、多配管理员、bridge 改多群，收益只是看起来分开。
- Claude 系与 Codex 互切：会话记录格式不同，没有可靠的转换。
- 删话题时关整个标签页、话题探测改每 10 分钟：10-18 已同意，放在 v4 之后单独做，不混进本次。

## 验收

| 项 | 方法 |
|---|---|
| 单元测试全过，含 PR #1 原有测试 | `bun test` |
| 配置解析：自定义后端、非法名字、默认后端的优先顺序、默认后端被删 | 单元测试 |
| `/new gw`、`/new codex`、`/new` 用默认后端，图标颜色和提示里的后端名 | 离线 lifecycle 测试 |
| `/config` 按钮切默认后端并在重启后保留 | 离线测试 |
| `/switch` 六种情况 | 离线测试 |
| `/tg-bind` 按 `ANTHROPIC_BASE_URL` 识别 gw | 离线测试 |
| 自定义后端经 `pane run` 起会话：Herdr 认出、session id 上报、改名 `tg-N`，参数转义正确 | 本机 Herdr 实测 |
| 三种后端各起一个会话、发一条消息、收到回答 | 本机另起一个 sim 实例（另用端口和状态目录、不连 Telegram）实测；线上 bridge 在使用者同意后重启 |
