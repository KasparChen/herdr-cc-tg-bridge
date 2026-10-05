// Local-only HTTP: /health, /send (used by bin/tg-send from inside a session), /sim (tests, opt-in).
import { resolve } from "path";
import type { Config } from "./config";
import { log } from "./log";
import { esc } from "./render";
import type { Router } from "./router";
import type { Status } from "./status";
import type { Store } from "./store";
import type { Telegram } from "./telegram";

export function startControl(cfg: Config, tg: Telegram, store: Store, status: Status, router: Router) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json(status.health());
      const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      if (url.pathname === "/send") {
        const thread = body.thread ?? store.topicOfPane(String(body.pane ?? ""));
        if (!thread) return Response.json({ ok: false, error: "this pane is not bound to a Telegram topic" }, { status: 404 });
        const sent: string[] = [];
        if (body.text) { await tg.send(thread, esc(String(body.text))); sent.push("text"); }
        for (const p of body.paths ?? []) {
          const abs = resolve(body.cwd ?? "/", p);
          if (await tg.sendFile(thread, abs, `📎 <code>${esc(abs)}</code>`)) sent.push(abs);
          log("tg-send", thread, sent.includes(abs) ? "sent" : "FAILED", abs);
        }
        return Response.json({ ok: true, sent });
      }
      if (url.pathname === "/sim" && cfg.sim) {
        const fake = {
          chat: { id: cfg.chatId }, from: { id: [...cfg.allowedUsers][0] }, text: body.text,
          is_topic_message: !!body.thread, message_thread_id: body.thread,
          ...(body.topic_created ? { forum_topic_created: { name: body.topic_created } } : {}),
          ...(body.message ?? {}), // e.g. photo / document objects with real file_ids
        };
        router.onMessage(fake).catch(e => log("sim", e));
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
}
