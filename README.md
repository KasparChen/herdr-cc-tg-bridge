# tg-bridge

> Use the Claude Code sessions on your computer from Telegram, one forum topic per session.

tg-bridge connects a Telegram group (with Topics enabled) to the Claude Code sessions running in [Herdr](https://herdr.dev). Each topic is bound to one session. What you drive from your phone *is* the session on your desk: same memory, same `CLAUDE.md`, same hooks and skills. Back at the computer, open Herdr and keep going in the same session.

---

**tg-bridge** 让你在 Telegram 群的话题里使用电脑上的 Claude Code 会话，一个话题对应一个会话，会话由 Herdr 管理。手机上操作的就是电脑上那个会话本身，记忆和配置全部照常生效。中文说明见 [docs/README.zh-CN.md](docs/README.zh-CN.md)。

## What it looks like

Every turn shows up in the topic as one collapsible progress bubble that updates live, then the final answer:

```text
┃ ✅ 完成                                 ← collapsed view: three lines
┃ 🔧 3 次调用 · 14s                        (status · tool calls · elapsed)
┃ ...
┃ 💬 Checking the OS version and disk space first.
┃ 💻 Running sw_vers
┃ 💻 Running df -h /
┃ 📖 Reading ~/project/.gitignore

macOS 15.7, 43 GiB free on /, .gitignore has 4 rules.   ← final answer
📎 ~/project/report.html                                ← files it created
```

## Features

- **Topic = session.** `/new name` (or creating a topic by hand) opens a new Claude session in a Herdr tab and binds it to the topic.
- **Live progress.** Tool calls stream into a folded bubble that is edited in place; the answer arrives as a separate message. Markdown is converted to Telegram HTML, tables become bullet groups.
- **Files both ways.** Photos and documents you send are saved locally and passed to the session as file paths. Deliverables the session writes (images, PDF, Office, archives, HTML, …) are sent back automatically; anything else it can push with `tg-send`.
- **Questions as buttons.** When Claude asks a multiple-choice question (`AskUserQuestion`), the options appear as inline buttons. Other prompts are shown as a screen capture you can answer with `/keys`.
- **Titles stay in sync.** Once the session names itself, the topic and the Herdr tab are renamed to match.
- **Visible liveness.** A pinned status message, a `/status` command and a self-expiring token on the Herdr workspace all show whether the bridge is up.
- **Self-healing.** A supervisor restarts the bridge on crash, polling retries forever through network loss, and an optional macOS LaunchAgent starts it at login.

## How it works

```text
Telegram group (Topics)
      │  long polling, send / edit messages, files
      ▼
  tg-bridge (Bun) ──── herdr CLI ────► Claude Code sessions in Herdr tabs
      ▲                                      │ write
      └──── tails ~/.claude/projects/*/<session>.jsonl ◄┘
```

The bridge never starts Claude processes itself. It sends input with `herdr agent prompt`, watches state with `herdr agent get`, presses keys with `herdr pane send-keys`, and reads replies from the session transcript. Herdr's Claude integration reports each session's id, which is how the bridge finds the right transcript. Design notes and trade-offs: [docs/PRD-v1.md](docs/PRD-v1.md) (Chinese).

## Requirements

- macOS (Linux should work but is untested; `bin/install-launchd` is macOS only)
- [Bun](https://bun.sh) (tested with 1.3.14)
- [Herdr](https://herdr.dev) ([source](https://github.com/herdrdev/herdr), tested with 0.8.0; 0.9.x untested), with its Claude integration: `herdr integration install claude`
- [Claude Code](https://code.claude.com/docs)
- `python3` and `curl` (used by `bin/tg-send`)

Only sessions started after the Herdr integration is installed can be bridged.

## Setup

1. **Create a bot.** Message [@BotFather](https://t.me/BotFather), send `/newbot`, keep the token.
2. **Create a group.** Turn on *Topics* in the group settings (it becomes a supergroup). Add the bot as an admin with **Manage Topics** and **Pin Messages** (the status message is pinned). As an admin it receives all messages; no need to change privacy mode.
3. **Find two ids.** Send any message in the group, then open `https://api.telegram.org/bot<token>/getUpdates`. `chat.id` (starts with `-100`) is the group id, `from.id` is your user id.
4. **Configure.**

   ```sh
   git clone https://github.com/KasparChen/tg-bridge.git
   cd tg-bridge
   cp .env.example .env   # fill in the four required values
   ```

   | Variable | Required | Meaning |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | yes | Bot token. Can also come from the environment instead of `.env` |
   | `TG_CHAT_ID` | yes | Group id |
   | `TG_ALLOWED_USERS` | yes | Comma-separated user ids allowed to drive sessions; everyone else is ignored |
   | `TG_BRIDGE_WORKDIR` | yes | Working directory for new sessions (where `CLAUDE.md` is picked up) |
   | `HERDR_WORKSPACE` | no | Herdr workspace (id or label) for new sessions |
   | `TG_AUTOSEND_EXT` | no | Extensions sent back automatically; `md` and `txt` are off by default |
   | `TG_CLAUDE_ARGS` | no | Extra arguments for `claude` in new sessions |

   See [.env.example](.env.example) for the rest.

5. **Run.**

   ```sh
   bin/tg-bridge            # foreground, e.g. in a Herdr tab; Ctrl+C to stop
   bin/install-launchd      # or: start at login on macOS (uninstall with `bin/install-launchd uninstall`)
   bin/tg-bridge status     # local health check
   ```

   `install-launchd` accepts `TG_BRIDGE_LABEL` and `TG_BRIDGE_LAUNCH_PREFIX` (a command put before `bin/tg-bridge`, e.g. a secret injector). If the project lives in a privacy-protected folder such as `~/Desktop`, grant `/bin/bash` Full Disk Access first, or the background job cannot read the files.

## Usage

| Where | Send | Result |
|---|---|---|
| Outside topics | `/new name` | New topic + new session. Without a name, the topic is renamed after the session's title |
| Outside topics | `/status`, `/help` | Bridge status, help |
| In a topic | Text, photos, files | Delivered to that topic's session |
| In a topic | `/clear` and other slash commands | Passed through to Claude. After `/clear` you are in a fresh context |
| In a topic | `/stop` | Interrupt the current reply |
| In a topic | `/screen` | Last 30 lines of the session's screen |
| In a topic | `/keys down enter` | Send key presses for prompts without buttons |

From inside a bridged session:

```sh
bin/tg-send report.pdf chart.png
bin/tg-send --text "done"
```

`tg-send` finds the topic through `HERDR_PANE_ID`, which Herdr sets in every pane. Sessions opened by the bridge are told about it in their system prompt.

## Is the bridge up?

"Online" means both: a Telegram poll succeeded in the last 90 seconds, and the Herdr socket answers. A live process alone is not enough, since it stays alive while the network is down.

| Where | Normally | When stopped or crashed |
|---|---|---|
| Pinned message in the group | Refreshed every 30 s with state, session count, last update time | Turns 🔴 immediately, with the reason |
| `/status` | Same content | No reply |
| Herdr workspace token `tg` | `🟢 <sessions>` | Disappears after 90 s |

When the computer sleeps nothing can be sent, so the pinned message simply stops updating. If "last update" is more than two minutes old, the bridge or the computer is offline.

## Status of testing

Verified end to end on macOS: text round trips with the progress bubble, photo upload, automatic file return, `tg-send`, `/clear`, title sync, crash recovery with the red status, and launchd restarting a killed supervisor.

Not yet verified with real Telegram input: tapping the question buttons, creating a topic by hand, recovery after a real network outage, and starting at an actual reboot. The code paths exist and were exercised through the local `/sim` endpoint only.

## Limits

- Files a session creates through scripts are not visible in the transcript; the session has to send them with `tg-send`.
- Bot API limits: downloads up to 20 MB, uploads up to 50 MB. Telegram compresses photos; send as a file for the original.
- Multi-select questions, several questions at once and other prompts are not turned into buttons; use `/keys`.
- Anyone on the allowlist can do whatever the session's permission mode allows, including running commands. Protect your Telegram account.
- Herdr's server must be running (open Herdr once after boot); the bridge does not start it.
- The bot's own messages (status, prompts, errors) are in Chinese. They live in `src/router.ts`, `src/status.ts` and `src/render.ts` if you want to translate them.

## Development

```sh
bun test                          # unit tests
TG_BRIDGE_SIM=1 bin/tg-bridge     # enable the local simulation endpoint
curl -X POST -H 'content-type: application/json' 127.0.0.1:18820/sim -d '{"thread":123,"text":"hello"}'
```

A bot never receives its own messages, so `/sim` (127.0.0.1 only, JSON only, off by default) injects messages as the first allowed user for end-to-end tests. Turn it off when you are done: anything on this machine that can reach the port can drive your sessions while it is on.

## License

MIT
