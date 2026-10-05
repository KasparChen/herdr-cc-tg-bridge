# tg-bridge — notes for agents working on this repo

Bun + TypeScript, no runtime dependencies. Read `README.md` for what it does and `docs/PRD-v1.md` for the design (Chinese). `spike/` is the original prototype, kept for reference only; do not edit it.

## Layout

- `src/main.ts` entry and poll loop; `src/router.ts` inbound updates; `src/session.ts` one Watcher per topic (Herdr status + transcript tail → Telegram); `src/render.ts` bubble / Markdown → HTML; `src/status.ts` liveness; `src/control.ts` local HTTP (`/health`, `/send`, `/sim`).
- `bin/tg-bridge` supervisor, `bin/tg-send` in-session sender, `bin/install-launchd` macOS LaunchAgent.
- Personal values only come from `.env` / the environment. Never hardcode chat ids, user ids, tokens or paths; `.env` is gitignored.

## Verify changes

- `bun test` for render / transcript / outbox / config.
- End to end: set `TG_BRIDGE_SIM=1`, restart, then `curl -X POST -H 'content-type: application/json' 127.0.0.1:18820/sim -d '{"thread":N,"text":"..."}'` (also `{"text":"/new"}`, `{"thread":N,"message":{"photo":[{"file_id":"..."}]}}`). The bot cannot see its own messages; read back with Bot API calls such as `getChat` (pinned message) or the bridge log. Turn sim off afterwards.
- Restart after code changes: kill the `bun src/main.ts` child with `kill -9` and the supervisor restarts it. SIGINT/SIGTERM/SIGHUP mean "stop" and the supervisor exits too.

## Known behaviour (verified)

- A freshly created Herdr pane rejects `herdr agent start` with `agent_pane_busy` for a moment; `spawnClaude` retries every 0.5 s.
- `herdr agent prompt <pane> <text>` takes dash-leading text literally; adding `--` breaks it.
- `herdr agent wait` can match the previous turn's leftover `done`; the Watcher only finishes a turn after seeing `working` (or after 5 s).
- Under launchd, `/bin/sh` cannot read files in macOS privacy-protected folders (`Operation not permitted`); the job runs through `/bin/bash`, which needs Full Disk Access.
- After the supervisor itself is killed, the first restart may hit `EADDRINUSE` or a timed-out poll while the old process winds down; both recover by retry within about a minute.
- `/send` and `/sim` reject anything but `application/json` (415): a web page could otherwise POST text/plain to localhost without a CORS preflight.
- Question buttons are only offered for a single single-select `AskUserQuestion`; with several questions the key presses would land on whichever question is active.
- Claude Code transcript path: `~/.claude/projects/<cwd with every non-alphanumeric char replaced by '-'>/<session>.jsonl`.
