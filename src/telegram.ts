// Minimal Bot API client: every request has a timeout, 429s are honoured, HTML falls back to plain text.
// Requests that post something are never retried after a network failure: the reply may be what got lost,
// and the bot cannot read the chat back to check, so a retry can post the same answer twice.
import { basename } from "path";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { log } from "./log";
import { stripTags } from "./render";

const PHOTO_EXT = new Set(["png", "jpg", "jpeg", "webp"]);
export const MAX_DOWNLOAD = 20 * 1024 * 1024;
export const MAX_UPLOAD = 50 * 1024 * 1024;

const THREAD_GONE = /message thread not found/i;
const POSTS = /^(sendMessage|sendPhoto|sendDocument|createForumTopic)$/;

// unknown = no reply from Telegram, so it may or may not have been posted
export type SendState = "ok" | "failed" | "unknown";
export type Sent = { id?: number; state: SendState };
const stateOf = (j: any): SendState => (j.ok ? "ok" : j.description === "network" ? "unknown" : "failed");

// Reactions on the user's own message tell where it is; the bot can set at most one, from a fixed list.
export const REACT = { got: "👀", working: "✍", ask: "🤔", failed: "💔", unsure: "😱" } as const;

export class Telegram {
  lastPollOk = 0;
  onThreadGone?: (thread: number) => void; // a send failed because the topic no longer exists
  echo = false; // sim mode: log the text of every sent / edited message, since the bot cannot read them back
  private reactions = new Map<number, { last?: string; chain: Promise<unknown> }>();
  constructor(private token: string, public chatId: number) {}

  async call(method: string, body: Record<string, unknown> | FormData, timeoutMs = 20000): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const isForm = body instanceof FormData;
        // the abort signal alone has not always ended a request whose socket was closed under it; race a timer too
        const req = fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: "POST",
          headers: isForm ? undefined : { "content-type": "application/json" },
          body: isForm ? body : JSON.stringify(body),
          signal: ctrl.signal,
        }).then(r => r.json());
        let hard: Timer | undefined;
        const j: any = await Promise.race([req, new Promise((_, rej) => { hard = setTimeout(() => rej(new Error(`hard timeout ${method}`)), timeoutMs + 5000); })])
          .finally(() => clearTimeout(hard));
        if (this.echo && !isForm && /^(sendMessage|editMessageText)$/.test(method))
          log("echo", method, (body as any).message_thread_id ?? (body as any).message_id ?? "", j.ok ? "" : "FAILED", stripTags(String((body as any).text)).replace(/\s+/g, " ").slice(0, 400));
        const wait = j.parameters?.retry_after;
        if (!j.ok && wait && wait <= 10) { await Bun.sleep(wait * 1000); continue; }
        if (!j.ok && !/not modified|NOT_MODIFIED/.test(j.description ?? "")) log("tg", method, j.description);
        return j;
      } catch (e) {
        if (method === "getUpdates") throw e;
        log("tg", method, "network", String(e).slice(0, 120));
        if (POSTS.test(method)) break;
        await Bun.sleep(1000 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, description: "network" };
  }

  async getUpdates(offset: number): Promise<any[]> {
    const j = await this.call("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] }, 45000);
    if (!j.ok) throw new Error(j.description);
    this.lastPollOk = Date.now();
    return j.result;
  }

  async send(thread: number | undefined, html: string, extra: Record<string, unknown> = {}): Promise<number | undefined> {
    return (await this.sendState(thread, html, extra)).id;
  }

  async sendState(thread: number | undefined, html: string, extra: Record<string, unknown> = {}): Promise<Sent> {
    const base = { chat_id: this.chatId, message_thread_id: thread, link_preview_options: { is_disabled: true }, ...extra };
    let j = await this.call("sendMessage", { ...base, text: html, parse_mode: "HTML" });
    if (!j.ok && THREAD_GONE.test(j.description ?? "")) { if (thread) this.onThreadGone?.(thread); return { state: "failed" }; }
    // plain-text fallback is for HTML the API rejected; after a network failure it would only repeat the request
    if (!j.ok && j.description !== "network") j = await this.call("sendMessage", { ...base, text: stripTags(html) });
    return { id: j.result?.message_id, state: stateOf(j) };
  }

  // Set (or with no emoji, clear) the bot's reaction on a message. Calls for one message run in order and are not
  // awaited by callers, so a slow network never holds up delivery; setting the same reaction twice is skipped.
  react(id: number, emoji?: string): Promise<unknown> {
    const r = this.reactions.get(id) ?? { chain: Promise.resolve() };
    this.reactions.set(id, r);
    r.chain = r.chain.then(async () => {
      if (r.last === emoji) return;
      const j = await this.call("setMessageReaction", { chat_id: this.chatId, message_id: id, reaction: emoji ? [{ type: "emoji", emoji }] : [] });
      if (j.ok) { r.last = emoji; log("react", id, emoji ?? "clear"); }
      if (!emoji && this.reactions.get(id) === r) this.reactions.delete(id);
    });
    return r.chain;
  }

  // Bridge notices (not turn output) also go to the log, so what the topic was told can be traced.
  notice(thread: number | undefined, html: string, extra: Record<string, unknown> = {}): Promise<number | undefined> {
    log("notice", thread ?? "general", stripTags(html).replace(/\s+/g, " ").slice(0, 160));
    return this.send(thread, html, extra);
  }

  // Telegram has no "get topic" call and no update when a topic is deleted. Re-applying the state we believe the
  // topic is in answers TOPIC_NOT_MODIFIED if it exists and TOPIC_ID_INVALID if it does not; a just-deleted topic
  // can still answer ok once, so "gone" needs two invalid answers. undefined = could not tell (network etc.).
  async topicAlive(thread: number, closed: boolean): Promise<boolean | undefined> {
    const [same, other] = closed ? ["closeForumTopic", "reopenForumTopic"] : ["reopenForumTopic", "closeForumTopic"];
    const ask = (m: string) => this.call(m, { chat_id: this.chatId, message_thread_id: thread });
    for (let i = 0; i < 2; i++) {
      if (i) await Bun.sleep(1000);
      const j = await ask(same);
      const d = j.description ?? "";
      if (/TOPIC_NOT_MODIFIED/.test(d)) return true;
      if (j.ok) {
        // our idea of open/closed was wrong and the call flipped it: flip it back
        const k = await ask(other);
        if (k.ok || /TOPIC_NOT_MODIFIED/.test(k.description ?? "")) return true;
        if (!/TOPIC_ID_INVALID/.test(k.description ?? "")) return;
        continue;
      }
      if (!/TOPIC_ID_INVALID|thread not found/i.test(d)) return;
    }
    return false;
  }

  // false only when the message is gone (deleted or no longer editable), the one case where callers send a new one.
  // A network failure answers true: sending a replacement then is how one stuck edit becomes a pile of messages.
  async edit(id: number, html: string, extra: Record<string, unknown> = {}): Promise<boolean> {
    const base = { chat_id: this.chatId, message_id: id, link_preview_options: { is_disabled: true }, ...extra };
    const gone = (d?: string) => /not found|can't be edited/.test(d ?? "");
    const j = await this.call("editMessageText", { ...base, text: html, parse_mode: "HTML" });
    if (j.ok || /not modified/.test(j.description ?? "")) return true;
    if (gone(j.description)) return false;
    if (j.description === "network") return true;
    const k = await this.call("editMessageText", { ...base, text: stripTags(html) });
    return !gone(k.description);
  }

  async sendFile(thread: number | undefined, path: string, caption?: string): Promise<boolean> {
    return (await this.sendFileState(thread, path, caption)) === "ok";
  }

  async sendFileState(thread: number | undefined, path: string, caption?: string): Promise<SendState> {
    const file = Bun.file(path);
    if (!(await file.exists())) return "failed";
    if (file.size > MAX_UPLOAD) {
      await this.send(thread, `⚠️ 文件超过 50MB，没法发送：<code>${path}</code>`);
      return "failed";
    }
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const asPhoto = PHOTO_EXT.has(ext) && file.size <= 10 * 1024 * 1024;
    const form = new FormData();
    form.append("chat_id", String(this.chatId));
    if (thread) form.append("message_thread_id", String(thread));
    form.append(asPhoto ? "photo" : "document", file, basename(path));
    if (caption) { form.append("caption", caption.slice(0, 1000)); form.append("parse_mode", "HTML"); }
    let j = await this.call(asPhoto ? "sendPhoto" : "sendDocument", form, 120000);
    if (!j.ok && asPhoto && j.description !== "network") {
      // photo dimension limits etc. -> retry as a document
      const f2 = new FormData();
      for (const [k, v] of form.entries()) f2.append(k === "photo" ? "document" : k, v as any);
      j = await this.call("sendDocument", f2, 120000);
    }
    return stateOf(j);
  }

  async download(fileId: string, dest: string): Promise<string | undefined> {
    const j = await this.call("getFile", { file_id: fileId });
    if (!j.ok) return;
    const r = await fetch(`https://api.telegram.org/file/bot${this.token}/${j.result.file_path}`);
    if (!r.ok) return;
    mkdirSync(dirname(dest), { recursive: true });
    await Bun.write(dest, r);
    return dest;
  }
}
