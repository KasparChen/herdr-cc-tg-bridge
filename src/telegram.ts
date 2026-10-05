// Minimal Bot API client: every request has a timeout, 429s are honoured, HTML falls back to plain text.
import { basename } from "path";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { log } from "./log";
import { stripTags } from "./render";

const PHOTO_EXT = new Set(["png", "jpg", "jpeg", "webp"]);
export const MAX_DOWNLOAD = 20 * 1024 * 1024;
export const MAX_UPLOAD = 50 * 1024 * 1024;

export class Telegram {
  lastPollOk = 0;
  constructor(private token: string, public chatId: number) {}

  async call(method: string, body: Record<string, unknown> | FormData, timeoutMs = 20000): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const isForm = body instanceof FormData;
        const r = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: "POST",
          headers: isForm ? undefined : { "content-type": "application/json" },
          body: isForm ? body : JSON.stringify(body),
          signal: ctrl.signal,
        });
        const j: any = await r.json();
        const wait = j.parameters?.retry_after;
        if (!j.ok && wait && wait <= 10) { await Bun.sleep(wait * 1000); continue; }
        if (!j.ok && !/not modified/.test(j.description ?? "")) log("tg", method, j.description);
        return j;
      } catch (e) {
        if (method === "getUpdates") throw e;
        log("tg", method, "network", String(e).slice(0, 120));
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
    const base = { chat_id: this.chatId, message_thread_id: thread, link_preview_options: { is_disabled: true }, ...extra };
    let j = await this.call("sendMessage", { ...base, text: html, parse_mode: "HTML" });
    if (!j.ok) j = await this.call("sendMessage", { ...base, text: stripTags(html) });
    return j.result?.message_id;
  }

  async edit(id: number, html: string, extra: Record<string, unknown> = {}): Promise<boolean> {
    const base = { chat_id: this.chatId, message_id: id, link_preview_options: { is_disabled: true }, ...extra };
    const j = await this.call("editMessageText", { ...base, text: html, parse_mode: "HTML" });
    if (j.ok || /not modified/.test(j.description ?? "")) return true;
    if (/not found|can't be edited/.test(j.description ?? "")) return false;
    const k = await this.call("editMessageText", { ...base, text: stripTags(html) });
    return !!k.ok;
  }

  async sendFile(thread: number | undefined, path: string, caption?: string): Promise<boolean> {
    const file = Bun.file(path);
    if (!(await file.exists())) return false;
    if (file.size > MAX_UPLOAD) {
      await this.send(thread, `⚠️ 文件超过 50MB，没法发送：<code>${path}</code>`);
      return false;
    }
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const asPhoto = PHOTO_EXT.has(ext) && file.size <= 10 * 1024 * 1024;
    const form = new FormData();
    form.append("chat_id", String(this.chatId));
    if (thread) form.append("message_thread_id", String(thread));
    form.append(asPhoto ? "photo" : "document", file, basename(path));
    if (caption) { form.append("caption", caption.slice(0, 1000)); form.append("parse_mode", "HTML"); }
    let j = await this.call(asPhoto ? "sendPhoto" : "sendDocument", form, 120000);
    if (!j.ok && asPhoto) {
      // photo dimension limits etc. -> retry as a document
      const f2 = new FormData();
      for (const [k, v] of form.entries()) f2.append(k === "photo" ? "document" : k, v as any);
      j = await this.call("sendDocument", f2, 120000);
    }
    return !!j.ok;
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
