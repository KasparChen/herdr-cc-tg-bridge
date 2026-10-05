// tg-bridge entry. `bun src/main.ts` runs the bridge; `bun src/main.ts --mark-offline <reason>` only flips the status to red
// (the supervisor calls it after a crash).
import { join } from "path";
import { loadConfig } from "./config";
import { startControl } from "./control";
import { log } from "./log";
import { Router } from "./router";
import type { Watcher } from "./session";
import { Status } from "./status";
import { Store } from "./store";
import { Telegram } from "./telegram";

const cfg = loadConfig();
const store = new Store(cfg.stateDir);
const tg = new Telegram(cfg.token, cfg.chatId);
const watchers = new Map<number, Watcher>();
const status = new Status(cfg, tg, store, watchers);

if (process.argv[2] === "--mark-offline") {
  const H = await import("./herdr");
  status.workspaceId = await H.resolveWorkspace(cfg.workspace);
  await status.offline(process.argv.slice(3).join(" ") || "进程退出");
  process.exit(0);
}

const router = new Router(cfg, tg, store, watchers, status, join(import.meta.dir, "..", "bin", "tg-send"));
for (const t of Object.keys(store.state.topics)) router.watch(Number(t));
startControl(cfg, tg, store, status, router);
status.start();

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
  } catch (e) {
    // never give up: offline at boot, DNS failures, sleep/wake all end up here
    log("poll failed, retry in", backoff / 1000, "s:", String(e).slice(0, 120));
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
}
