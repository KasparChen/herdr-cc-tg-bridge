// tg-bridge entry. `bun src/main.ts` runs the bridge; `bun src/main.ts --mark-offline <reason>` only flips the status to red
// (the supervisor calls it after a crash).
import { join } from "path";
import { loadConfig } from "./config";
import { startControl } from "./control";
import { log } from "./log";
import { Lifecycle } from "./lifecycle";
import { COMMANDS, Router } from "./router";
import type { Watcher } from "./session";
import { Status } from "./status";
import { Store } from "./store";
import { Telegram } from "./telegram";

const cfg = loadConfig();
const store = new Store(cfg.stateDir);
const tg = new Telegram(cfg.token, cfg.chatId);
tg.echo = cfg.sim;
const watchers = new Map<number, Watcher>();
const status = new Status(cfg, tg, store, watchers);

if (process.argv[2] === "--mark-offline") {
  const H = await import("./herdr");
  status.workspaceId = await H.resolveWorkspace(cfg.workspace);
  await status.offline(process.argv.slice(3).join(" ") || "进程退出");
  process.exit(0);
}

const life = new Lifecycle(cfg, tg, store, watchers, join(import.meta.dir, "..", "bin", "tg-send"));
const router = new Router(cfg, tg, store, watchers, status, life);
for (const t of Object.keys(store.state.topics)) life.watch(Number(t));
startControl(cfg, tg, store, status, router, life);
status.start();
tg.call("setMyCommands", { commands: COMMANDS, scope: { type: "chat", chat_id: cfg.chatId } }).catch(() => {});
// deleted topics send no update; probe the bindings at start and then hourly
const sweep = () => life.sweep().then(g => g.length && log("sweep removed", g)).catch(e => log("sweep", e));
setInterval(sweep, 3600_000);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log("stopping on", sig);
    await status.offline(sig === "SIGHUP" ? "终端标签页被关闭" : "手动停止").catch(() => {});
    process.exit(0);
  });
}

log("tg-bridge up", { topics: Object.keys(store.state.topics).length, workspace: cfg.workspace ?? "(current)", port: cfg.port, sim: cfg.sim });
let backoff = 1000;
let swept = false;
while (!stopping) {
  try {
    const wasOffline = !status.health().telegram;
    const updates = await tg.getUpdates(store.state.offset);
    backoff = 1000;
    if (wasOffline) status.beat().catch(() => {}); // reflect reconnects immediately
    for (const u of updates) {
      store.state.offset = u.update_id + 1;
      store.save();
      await router.onUpdate(u);
    }
    // first probe only after the updates queued while we were down, so a topic closed meanwhile is known closed
    if (!swept) { swept = true; sweep(); }
  } catch (e) {
    // never give up: offline at boot, DNS failures, sleep/wake all end up here
    log("poll failed, retry in", backoff / 1000, "s:", String(e).slice(0, 120));
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
}
