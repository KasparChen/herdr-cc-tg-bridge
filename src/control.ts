// Local-only HTTP: /health, /send (bin/tg-send), /bind (bin/tg-bind), /sim (tests, opt-in).
import { resolve } from "path";
import type { Config } from "./config";
import { log } from "./log";
import { esc } from "./render";
import type { Lifecycle } from "./lifecycle";
import type { Router } from "./router";
import type { Status } from "./status";
import type { Store } from "./store";
import type { Telegram } from "./telegram";

export function startControl(cfg: Config, tg: Telegram, store: Store, status: Status, router: Router, life: Lifecycle) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json(status.health());
      // JSON only: a web page can send a text/plain POST to localhost without a CORS preflight
      if (req.method === "POST" && !(req.headers.get("content-type") ?? "").startsWith("application/json"))
        return Response.json({ ok: false, error: "content-type must be application/json" }, { status: 415 });
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
      if (url.pathname === "/bind") {
        // bin/tg-bind from inside a desktop session
        if (!body.pane) return Response.json({ ok: false, error: "missing pane" }, { status: 400 });
        if (body.off) {
          const thread = store.topicOfPane(String(body.pane));
          if (!thread) return Response.json({ ok: false, error: "this pane is not bound to a Telegram topic" }, { status: 404 });
          await life.close(thread, false);
          return Response.json({ ok: true, thread, closed: true });
        }
        const r = await life.attach(String(body.pane));
        return Response.json(r, { status: r.ok ? 200 : 409 });
      }
      if (url.pathname === "/sim" && cfg.sim && body.callback) {
        // a button press: {"callback":"lc:close:15","message_id":123}
        const q = { id: "sim", from: { id: [...cfg.allowedUsers][0] }, data: body.callback, message: body.message_id ? { message_id: body.message_id } : undefined };
        router.onCallback(q).catch(e => log("sim", e));
        return Response.json({ ok: true });
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
