# herdr-cc-tg-bridge (command: tg-bridge) — notes for agents working on this repo

Bun + TypeScript, no runtime dependencies. Read `README.md` for what it does, `docs/PRD-v1.md` for the design and `docs/PRD-v2.md` for the session lifecycle (Chinese; v1 is frozen, changes go into a new version). `spike/` is the original prototype, kept for reference only; do not edit it.

## Layout

- `src/main.ts` entry and poll loop; `src/router.ts` inbound updates (dispatch only); `src/lifecycle.ts` open / resume / attach (tg-bind) / close / delete / list and topic probing; `src/usage.ts` context and plan-limit display; `src/session.ts` one Watcher per topic (Herdr status + transcript tail → Telegram); `src/render.ts` bubble / Markdown → HTML; `src/status.ts` liveness; `src/control.ts` local HTTP (`/health`, `/send`, `/sim`).
- `bin/tg-bridge` supervisor (also holds a `caffeinate` assertion), `bin/tg-send` in-session sender, `bin/tg-bind` binds the current desktop session, `bin/install-launchd` macOS LaunchAgent.
- Personal values only come from `.env` / the environment. Never hardcode chat ids, user ids, tokens or paths; `.env` is gitignored.

## Verify changes

- `bun test` for render / transcript / outbox / config.
- End to end: set `TG_BRIDGE_SIM=1`, restart, then `curl -X POST -H 'content-type: application/json' 127.0.0.1:18820/sim -d '{"thread":N,"text":"..."}'` (also `{"text":"/new"}`, `{"thread":N,"message":{"photo":[{"file_id":"..."}]}}`, service messages such as `{"thread":N,"message":{"forum_topic_closed":{}}}`, and button presses `{"callback":"lc:resume:N"}`). In sim mode the text of every sent or edited message is echoed to the bridge log (`echo ...`), since the bot cannot read its own messages. Turn sim off afterwards.
- Restart after code changes: kill the `bun src/main.ts` child with `kill -9` and the supervisor restarts it. SIGINT/SIGTERM/SIGHUP mean "stop" and the supervisor exits too.

## Known behaviour (verified)

- A freshly created Herdr pane rejects `herdr agent start` with `agent_pane_busy` for a moment; `spawnAgent` retries every 0.5 s.
- `herdr agent prompt <pane> <text>` takes dash-leading text literally; adding `--` breaks it.
- `herdr agent wait` can match the previous turn's leftover `done`; the Watcher only finishes a turn after seeing `working` (or after 5 s).
- Under launchd, `/bin/sh` cannot read files in macOS privacy-protected folders (`Operation not permitted`); the job runs through `/bin/bash`, which needs Full Disk Access.
- After the supervisor itself is killed, the first restart may hit `EADDRINUSE` or a timed-out poll while the old process winds down; both recover by retry within about a minute.
- `/send` and `/sim` reject anything but `application/json` (415): a web page could otherwise POST text/plain to localhost without a CORS preflight.
- Question buttons are only offered for a single single-select `AskUserQuestion`; with several questions the key presses would land on whichever question is active. Codex `request_user_input` is parsed as `AskUserQuestion` (same fields; verified on Codex CLI 0.162: Herdr shows `blocked`, down × n + enter picks option n, and Codex appends its own "None of the above" after the listed options).
- Claude Code transcript path: `~/.claude/projects/<cwd with every non-alphanumeric char replaced by '-'>/<session>.jsonl`.
- Codex transcript path: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<session>.jsonl` (or `archived_sessions/`). Each message is written twice (`event_msg` and `response_item`); only `response_item` is read, and `task_complete` / `turn_aborted` end the turn. `herdr agent get` reports the kind in `agent` (`claude`, `codex`, ...).
- Codex 0.162's shared app-server (`codex app-server --managed-daemon`) runs all plainly started TUI sessions' commands and hooks with the first pane's environment: `HERDR_PANE_ID` and Herdr's `agent_session` can belong to another pane, `CODEX_THREAD_ID` is right. Codex callers are therefore looked up by session id. Herdr's `cwd` and terminal title are per pane, and Codex's default title is "<session name> | <folder>" (name from `session_index.jsonl`), so a shared session (`session_meta.source` = `vscode`; `cli` = own process) is placed by its name in the title, and a new session id is followed only if its `session_meta.cwd` equals the pane's `cwd` and, when shared, the pane's title shows its name.
- Codex runs a skill's command in its sandbox (no network, so no 127.0.0.1). An execpolicy allow rule (`prefix_rule(..., decision="allow")` in `$CODEX_HOME/rules/default.rules`) runs a command outside it without asking, even with `approval_policy = "never"`; "don't ask again" on an approval writes the same rule. The shared app-server reads rules when it starts, not after edits.
- Codex 0.162 profiles are `$CODEX_HOME/NAME.config.toml` (a `[profiles.NAME]` table in config.toml is refused), and a trusted project's `.codex/config.toml` is layered on top. `codex debug prompt-input` renders the final prompt offline; `developer_instructions` is a block of the first developer message. Bun.spawn uses the environment the process started with unless `env` is passed.
- Herdr CLI errors (`agent_not_found`, `pane_not_found`, ...) are JSON on stderr with exit code 0; `herdr()` parses stderr when stdout is empty.
- Herdr agent names must match `[a-z][a-z0-9_-]{0,31}`; the bridge always uses `tg-<thread>` and puts the topic name on the tab label only.
- After `/exit` the agent disappears but the pane stays as a shell (`paneState` = exited); `claude --resume <id>` in that same pane keeps the session id and the context.
- `herdr pane close` on a tab's last pane closes the tab too.
- Telegram has no topic listing and no update on topic deletion. `reopenForumTopic` on an open topic (or `closeForumTopic` on a closed one) answers `TOPIC_NOT_MODIFIED` if it exists and `TOPIC_ID_INVALID` if not; right after a delete it answered ok once, so two invalid answers are required. `sendChatAction` and `editForumTopic` without fields succeed even for nonexistent topics and cannot be used as probes. Sending into a deleted topic fails with `message thread not found`; sending into a closed topic works for an admin bot.
- If Herdr does not answer while a topic is being closed, the pane cannot be ended but the binding is still marked closed; reopening then resumes the same session in a new tab while the old Claude may still be running. Rare; not handled.
- While background agents run, Herdr keeps the pane at `working` after the reply is finished. The Watcher closes a turn when the transcript has an `end_turn` assistant line that carries text (one reply can be split into a thinking line and a later text line, both marked `end_turn`).
- A Telegram request once never settled after its socket was closed (no error, no response), which froze that topic's Watcher for good. Requests now also race a hard timer, and a Watcher tick running longer than 90 s is abandoned and logged as `watcher stuck`.
