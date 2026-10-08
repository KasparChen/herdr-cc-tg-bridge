# herdr-cc-tg-bridge

> Use the Claude Code sessions running in [Herdr](https://herdr.dev) from Telegram: one forum topic per session.

herdr-cc-tg-bridge connects a Telegram group (with Topics enabled) to the Claude Code sessions running in Herdr on your computer. What you drive from your phone *is* the session on your desk: same memory, same `CLAUDE.md`, same hooks and skills. Back at the computer, keep typing in the same Herdr tab.

It is a small Bun program with no runtime dependencies. The command it installs is called `tg-bridge`.

*Independent project. Not affiliated with, or endorsed by, Anthropic. It runs the unmodified Claude Code CLI under your own account.*

**中文说明见 [docs/README.zh-CN.md](docs/README.zh-CN.md)。**

## What it looks like

Every turn shows up in the topic as one collapsible progress bubble that updates live, then the final answer:

```text
┃ ✅ 完成                                     ← collapsed view: three lines
┃ 🔧 3 次调用 · 14s · ctx 27% (269k)           (status · tool calls · elapsed · context)
┃ ...
┃ 💬 Checking the OS version and disk space first.
┃ 💻 Running sw_vers
┃ 💻 Running df -h /
┃ 📖 Reading ~/project/.gitignore

macOS 15.7, 43 GiB free on /, .gitignore has 4 rules.   ← final answer
📎 ~/project/report.html                                ← files it created
```

## Features

- **Topic = session.** `/new name`, or creating a topic by hand, opens a new Claude session in a Herdr tab and binds it to the topic.
- **Hand over a desktop session.** Run `/tg-bind` inside a session you started on the computer: a new topic gets a handoff card and the last answer, and from then on both sides are in sync.
- **Full lifecycle from Telegram.** `/close` (or closing the topic in the client) ends the session and closes the topic; reopening it, or writing in it, resumes the same session. `/delete` removes topic and session. `/sessions` lists everything with buttons.
- **Live progress.** Tool calls stream into a folded bubble that is edited in place; the answer arrives as a separate message. Markdown becomes Telegram HTML, tables become bullet groups.
- **Files both ways.** Photos and documents you send are saved locally and handed to the session as paths. Deliverables the session writes are sent back automatically; anything else it can push with `tg-send`.
- **Questions as buttons.** A single-choice `AskUserQuestion` becomes inline buttons. Other prompts arrive as a screen capture you answer with `/keys`.
- **Context and limits.** Context use on every finished bubble, a one-time warning at 80%, and optional 5-hour / 7-day / per-model plan limits in the pinned status.
- **Stays up.** A supervisor restarts the bridge on crash, polling retries forever through network loss, a LaunchAgent starts it at login, and `caffeinate` keeps the Mac from idle-sleeping while it runs.

## Architecture

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

Three rules keep the design small:

1. **Herdr owns the sessions.** The bridge never runs Claude itself. It types into a session with `herdr agent prompt`, reads its state with `herdr agent get`, presses keys with `herdr pane send-keys`, and opens or closes tabs through Herdr. So the session on your desk and the one on your phone are the same process.
2. **Replies come from the transcript.** Claude Code writes every turn to a JSONL file. The bridge tails that file, so tool calls, text and titles arrive as structured events and the terminal's layout never gets in the way. The screen is read only to show a prompt that is waiting for input.
3. **One topic, one binding.** `state.json` maps each topic to a Herdr pane, its terminal id and the Claude session id. Herdr's Claude integration (`herdr integration install claude`) reports the session id, which is how the bridge finds the transcript.

### Components

| File | Role |
|---|---|
| `src/main.ts` | Entry point and the long-polling loop |
| `src/router.ts` | Dispatches updates: commands, topic service messages, attachments, button taps |
| `src/lifecycle.ts` | Opens, resumes, binds (`tg-bind`), closes and deletes sessions; `/sessions`; detects deleted topics |
| `src/session.ts` | The Watcher: one per topic, polls Herdr every second, tails the transcript, renders the turn |
| `src/transcript.ts` | Incremental JSONL reader that turns lines into events (tool, text, title, end of turn) |
| `src/render.ts` | Progress bubble, Markdown to Telegram HTML, chunking under 4096 characters |
| `src/outbox.ts` | Which files written in a turn are sent back |
| `src/status.ts` | Liveness, the pinned status message, the Herdr workspace token |
| `src/usage.ts` | Context reading and plan-limit line |
| `src/telegram.ts` | Bot API client: timeouts, retries, 429 handling, topic probe |
| `src/herdr.ts` | Thin wrapper over the `herdr` CLI |
| `src/control.ts` | Local HTTP on 127.0.0.1: `/health`, `/send`, `/bind`, `/sim` |
| `src/store.ts` | `state.json`: update offset and topic bindings |
| `bin/tg-bridge` | Supervisor: restarts on crash, marks the status red, holds the `caffeinate` assertion |
| `bin/tg-send`, `bin/tg-bind` | Run inside a session: send files back, bind or unbind the session |
| `bin/install-launchd` | Installs the macOS LaunchAgent |

### What happens in one turn

1. You write in topic A. The router looks up the binding; if the pane is gone it resumes the session first (`claude --resume <id>`).
2. Attachments are downloaded to `~/.tg-bridge/inbox/<topic>/` and their paths are appended to the text, which goes in with `herdr agent prompt`.
3. Topic A's Watcher sees Herdr switch to `working` and reads new transcript lines. Tool calls go into the bubble, edited at most every 1.5 s.
4. When the transcript shows the end of the turn (an `end_turn` reply carrying text), the bubble is marked done with the context reading, the answer is sent, and files the turn wrote with the Write tool are sent back if their extension is on the list. Waiting for the transcript, not for Herdr's status, matters because background agents keep the session `working` long after the reply is done.
5. If Claude stops for input instead, a single-choice question becomes buttons; anything else is shown as a screen capture.

Text typed on the computer in a bound session shows up in the bubble with a 🖥 prefix, and its answer is sent to the topic too.

### Session lifecycle

| State | How it is reached | What the topic sees |
|---|---|---|
| live | Claude runs in the pane | normal conversation |
| exited | the pane is left with a shell (e.g. after `/exit`) | one notice with buttons: resume, start fresh, close |
| pane gone | the tab was closed on the computer | the same notice, once |
| closed | `/close`, or the topic closed in the client | one "session ended" line, then silence |
| deleted | `/delete`, or the topic deleted in the client | nothing; the binding is dropped |

Notices are recorded in `state.json`, so restarts never repeat them. Topic service messages (closed, reopened, renamed, pinned) never start a session. Telegram has no way to list topics and sends no update when one is deleted, so the bridge notices deletion when a send fails with `message thread not found`, or by re-applying each topic's open or closed state at start, hourly, and before `/sessions`: an existing topic answers `TOPIC_NOT_MODIFIED`, a deleted one `TOPIC_ID_INVALID`. Two invalid answers in a row are required before anything is ended.

Sessions bound with `/tg-bind` live wherever you started them. Closing or deleting their topic only disconnects Telegram; the session keeps running and its tab keeps its name. Reopening the topic, writing in it, or running `/tg-bind` again reconnects the same topic.

### Where state lives

| What | Where | Owner |
|---|---|---|
| Topic bindings, update offset, notice flags | `~/.tg-bridge/state.json` | the bridge |
| Files you sent | `~/.tg-bridge/inbox/<topic>/` | the bridge |
| Session processes and their status | Herdr | Herdr |
| Conversation content | `~/.claude/projects/*/<session>.jsonl` | Claude Code |

Design notes, trade-offs and the record of decisions: [docs/PRD-v1.md](docs/PRD-v1.md) and [docs/PRD-v2.md](docs/PRD-v2.md) (Chinese).

## Requirements

- macOS (Linux should work but is untested; `bin/install-launchd` and `caffeinate` are macOS only)
- [Bun](https://bun.sh) (tested with 1.3.14)
- [Herdr](https://herdr.dev) ([source](https://github.com/herdrdev/herdr), tested with 0.8.0; 0.9.x untested), with its Claude integration: `herdr integration install claude`
- [Claude Code](https://code.claude.com/docs)
- `python3` and `curl` (used by `bin/tg-send` and `bin/tg-bind`)

Only sessions started after the Herdr integration is installed can be bridged.

## Setup

1. **Create a bot.** Message [@BotFather](https://t.me/BotFather), send `/newbot`, keep the token.
2. **Create a group.** Turn on *Topics* in the group settings (it becomes a supergroup). Add the bot as an admin with **Manage Topics**, **Delete Messages** (for `/delete`) and **Pin Messages** (the status message is pinned). As an admin it receives all messages; no need to change privacy mode.
3. **Find two ids.** Send any message in the group, then open `https://api.telegram.org/bot<token>/getUpdates`. `chat.id` (starts with `-100`) is the group id, `from.id` is your user id.
4. **Configure.**

   ```sh
   git clone https://github.com/KasparChen/herdr-cc-tg-bridge.git
   cd herdr-cc-tg-bridge
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
   | `TG_USAGE_FILE`, `TG_FABLE_USAGE_FILE` | no | JSON files with plan limits to display (format in `.env.example`) |
   | `TG_BRIDGE_CAFFEINATE` | no | `0` lets the Mac idle-sleep while the bridge runs |

   See [.env.example](.env.example) for the rest.

5. **Run.**

   ```sh
   bin/tg-bridge            # foreground, e.g. in a Herdr tab; Ctrl+C to stop
   bin/install-launchd      # or: start at login on macOS (uninstall with `bin/install-launchd uninstall`)
   bin/tg-bridge status     # local health check
   ```

   `install-launchd` accepts `TG_BRIDGE_LABEL` and `TG_BRIDGE_LAUNCH_PREFIX` (a command put before `bin/tg-bridge`, e.g. a secret injector). If the project lives in a privacy-protected folder such as `~/Desktop`, grant `/bin/bash` Full Disk Access first, or the background job cannot read the files.

6. **Optional: `/tg-bind` in Claude Code.** Create a skill (for example `~/.claude/skills/tg-bind/SKILL.md`) that runs `<repo>/bin/tg-bind` for `/tg-bind` and `<repo>/bin/tg-bind off` for `/tg-bind off`, and tells the session that its replies are now read on a phone. Running `bin/tg-bind` yourself in that pane does the same.

## Usage

| Where | Send | Result |
|---|---|---|
| Anywhere | `/new name` | New topic + new session. Without a name, the topic is renamed after the session's title |
| Anywhere | `/sessions` | All sessions with state, context use and last activity, plus plan limits; one row of buttons each (close / resume / reopen, delete) |
| Anywhere | `/status`, `/help` | Bridge status and plan limits, help |
| Desktop session | `/tg-bind`, `/tg-bind off` | Hand this session over to a new topic, or disconnect it |
| In a topic | Text, photos, files | Delivered to that topic's session |
| In a topic | `/clear` and other slash commands | Passed through to Claude. After `/clear` you are in a fresh context |
| In a topic | `/stop` | Interrupt the current reply |
| In a topic | `/screen` | Last 30 lines of the session's screen |
| In a topic | `/keys down enter` | Send key presses for prompts without buttons |
| In a topic | `/close` | End the session and close the topic; history stays. Closing the topic in the client does the same |
| In a topic | `/delete` | After a confirm button: end the session and delete the topic with all its messages |
| Client | Reopen a closed topic, or write in it | Resume the same session (`claude --resume`) |
| Client | Rename the topic | The Herdr tab is renamed too; the session title no longer overrides it |

The bridge commands are registered in the group's `/` menu. From inside a bridged session:

```sh
bin/tg-send report.pdf chart.png
bin/tg-send --text "done"
```

`tg-send` and `tg-bind` find their pane through `HERDR_PANE_ID`, which Herdr sets in every pane. Sessions opened by the bridge are told about `tg-send` in their system prompt.

## Is the bridge up?

"Online" means both: a Telegram poll succeeded in the last 90 seconds, and the Herdr socket answers. A live process alone is not enough, since it stays alive while the network is down.

| Where | Normally | When stopped or crashed |
|---|---|---|
| Pinned message in the group | Refreshed every 30 s with state, session count, plan limits, last update time | Turns 🔴 immediately, with the reason |
| `/status` | Same content | No reply |
| Herdr workspace token `tg` | `🟢 <sessions>` | Disappears after 90 s |

While it runs, the bridge keeps the Mac from idle-sleeping. Closing the lid still puts the Mac to sleep. When the computer sleeps nothing can be sent, so the pinned message simply stops updating. If "last update" is more than two minutes old, the bridge or the computer is offline.

## Status of testing

Verified end to end on macOS: text round trips with the progress bubble, photo upload, automatic file return, `tg-send`, `/clear`, title sync, crash recovery with the red status, and launchd restarting a killed supervisor.

The session lifecycle (close, reopen, resume after `/exit` or a closed tab, delete, deleted-topic detection, `/sessions`, `/tg-bind`, context and limit display) was verified through `/sim` and the Bot API. With real Telegram input: creating and renaming a topic by hand, the close button in `/sessions`, and `/delete` with its confirm button.

Not yet verified with real Telegram input: tapping the question buttons, closing or reopening a topic in the client, the 80% context warning, recovery after a real network outage, and starting at an actual reboot.

## Limits

- Files a session creates through scripts are not visible in the transcript; the session has to send them with `tg-send`.
- Bot API limits: downloads up to 20 MB, uploads up to 50 MB. Telegram compresses photos; send as a file for the original.
- Multi-select questions, several questions at once and other prompts are not turned into buttons; use `/keys`.
- Turns without tool calls have no bubble, so they show no context reading; `/sessions` has it.
- Anyone on the allowlist can do whatever the session's permission mode allows, including running commands. Protect your Telegram account.
- Herdr's server must be running (open Herdr once after boot); the bridge does not start it.
- The bot's own messages (status, notices, errors) are in Chinese. They live in `src/router.ts`, `src/lifecycle.ts`, `src/session.ts`, `src/status.ts` and `src/render.ts` if you want to translate them.

## Development

```sh
bun test                          # unit tests
TG_BRIDGE_SIM=1 bin/tg-bridge     # enable the local simulation endpoint
curl -X POST -H 'content-type: application/json' 127.0.0.1:18820/sim -d '{"thread":123,"text":"hello"}'
curl -X POST -H 'content-type: application/json' 127.0.0.1:18820/sim -d '{"callback":"lc:close:123"}'
```

A bot never receives its own messages, so `/sim` (127.0.0.1 only, JSON only, off by default) injects messages and button taps as the first allowed user, and the text of everything the bot sends is echoed to the log. Turn it off when you are done: anything on this machine that can reach the port can drive your sessions while it is on.

## License

MIT
