// Inbound Telegram updates: commands, text, attachments, button callbacks.
import { join } from "path";
import type { Config } from "./config";
import * as H from "./herdr";
import { log } from "./log";
import { cut, esc } from "./render";
import type { Lifecycle } from "./lifecycle";
import type { Watcher } from "./session";
import type { Status } from "./status";
import type { Store } from "./store";
import { MAX_DOWNLOAD, type Telegram } from "./telegram";
import { limitsLine } from "./usage";

const HELP = [
  "<b>tg-bridge 用法</b>",
  "• <code>/new 名字</code>：新建话题和会话。也可以在客户端里手动建话题",
  "• 电脑上已经在聊的会话，在那个会话里用 <code>/tg-bind</code> 接到这里",
  "• 在话题里发文字、图片、文件：送进对应会话",
  "• 话题里的 <code>/clear</code> 等斜杠命令原样送进会话",
  "• <code>/close</code> 结束会话并关闭话题，重新打开话题会接着原会话。在客户端里关话题效果一样",
  "• <code>/delete</code> 结束会话并删除话题（要确认）。从电脑接过来的会话，关闭和删除都只断开 Telegram",
  "• <code>/stop</code> 打断当前回复，<code>/screen</code> 看会话屏幕，<code>/keys down enter</code> 发按键",
  "• <code>/sessions</code> 看全部会话，<code>/status</code> 看 bridge 状态和额度",
].join("\n");

// Shown in the client's "/" menu for this group.
export const COMMANDS = [
  ["new", "新建话题和会话"], ["sessions", "列出全部会话"], ["close", "结束本话题的会话并关闭话题"],
  ["delete", "结束会话并删除本话题"], ["stop", "打断当前回复"], ["screen", "看会话屏幕"], ["keys", "往会话发按键"],
  ["status", "看 bridge 状态和额度"], ["help", "用法"],
].map(([command, description]) => ({ command, description }));

const MEDIA = ["photo", "document", "video", "audio", "voice", "animation", "video_note"];
const HINT_EVERY_MS = 10 * 60_000;

export class Router {
  private lastHint = 0;

  constructor(
    private cfg: Config, private tg: Telegram, private store: Store,
    private watchers: Map<number, Watcher>, private status: Status, private life: Lifecycle,
  ) {}

  async onUpdate(u: any) {
    if (u.message) await this.onMessage(u.message).catch(e => log("message", e));
    if (u.callback_query) await this.onCallback(u.callback_query).catch(e => log("callback", e));
  }

  async onMessage(m: any) {
    if (m.chat?.id !== this.cfg.chatId || !this.cfg.allowedUsers.has(m.from?.id)) return;
    const thread: number | undefined = m.is_topic_message ? m.message_thread_id : undefined;
    // service messages about the topic itself never start a session by accident
    const tid: number | undefined = m.message_thread_id;
    if (tid && m.forum_topic_created) {
      await this.life.open(tid, { name: cut(m.forum_topic_created.name ?? `tg-${tid}`, 40), fresh: true });
      return;
    }
    if (tid && m.forum_topic_closed) { await this.life.close(tid, true); return; }
    if (tid && m.forum_topic_reopened) { if (this.store.state.topics[tid]) await this.life.open(tid); return; }
    if (tid && m.forum_topic_edited) { await this.life.renamed(tid, m.forum_topic_edited.name ?? ""); return; }

    const text: string = (m.text ?? m.caption ?? "").trim();
    const hasMedia = MEDIA.some(k => m[k]);
    if (!text && !hasMedia) return; // pins and other service messages
    const [first = "", ...rest] = text.split(/\s+/);
    const cmd = first.startsWith("/") ? first.replace(/@\w+$/, "").toLowerCase() : "";

    if (cmd === "/help" || cmd === "/start") { await this.tg.send(thread, HELP); return; }
    if (cmd === "/status") { await this.tg.send(thread, this.status.text()); return; }
    if (cmd === "/new") {
      const name = rest.join(" ");
      const j = await this.tg.call("createForumTopic", { chat_id: this.cfg.chatId, name: cut(name || `新会话 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`, 120) });
      if (!j.ok) { await this.tg.notice(thread, `❌ 建话题失败：${esc(j.description ?? "")}`); return; }
      await this.life.open(j.result.message_thread_id, { name: cut(name || `tg-${j.result.message_thread_id}`, 40), autoName: !name, fresh: true });
      return;
    }
    if (cmd === "/sessions") {
      const { html, keyboard } = await this.life.listing(limitsLine(this.cfg));
      await this.tg.send(thread, html, { reply_markup: { inline_keyboard: keyboard } });
      return;
    }
    if (!thread) {
      if (cmd === "/close" || cmd === "/delete") { await this.tg.notice(undefined, `在要处理的话题里发 <code>${cmd}</code>，或者用 /sessions 里的按钮`); return; }
      if (Date.now() - this.lastHint > HINT_EVERY_MS) {
        this.lastHint = Date.now();
        await this.tg.notice(undefined, "在话题里发的消息才会送进会话。/new 新建，/sessions 看全部，/help 看用法");
      }
      return;
    }

    if (cmd === "/close") { await this.life.close(thread, false); return; }
    if (cmd === "/delete") {
      const { html, keyboard } = this.life.deletePrompt(thread);
      await this.tg.send(thread, html, { reply_markup: { inline_keyboard: keyboard } });
      return;
    }

    const cur = this.store.state.topics[thread];
    const st = cur && !cur.closedAt ? await H.paneState(cur.pane, cur.terminal) : undefined;
    const live = st?.state === "live";
    if (cmd === "/keys" || cmd === "/stop" || cmd === "/screen") {
      if (!live) { await this.tg.notice(thread, "这个话题现在没有运行中的会话"); return; }
      if (cmd === "/keys") await H.sendKeys(cur!.pane, rest);
      else if (cmd === "/stop") await H.sendKeys(cur!.pane, ["esc"]);
      else {
        const s = (await H.paneRead(cur!.pane)).split("\n").filter(l => l.trim()).slice(-30).join("\n");
        await this.tg.send(thread, `<pre>${esc(cut(s, 3800))}</pre>`);
      }
      return;
    }

    // no live session behind this topic: resume the bound one (or open a first one) before delivering
    if (!live && !(await this.life.open(thread, { name: `tg-${thread}` }))) return;
    const b = this.store.state.topics[thread];
    const files = await this.saveAttachments(m, thread);
    if (!text && !files.length) return;
    const body = [text || (files.length ? "（见附件）" : ""), ...files.map(f => `[附件] ${f}`)].join("\n");
    this.watchers.get(thread)?.noteFromTg(body);
    b.lastActive = Date.now();
    this.store.save();
    const r = await H.prompt(b.pane, body);
    if (!r?.result) await this.tg.notice(thread, `⚠️ 送达失败，Herdr 返回 <code>${esc(cut(JSON.stringify(r?.error ?? r), 300))}</code>`);
  }

  private async saveAttachments(m: any, thread: number): Promise<string[]> {
    const items: { id: string; size?: number; name: string }[] = [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    if (m.photo?.length) { const p = m.photo[m.photo.length - 1]; items.push({ id: p.file_id, size: p.file_size, name: "photo.jpg" }); }
    for (const k of ["document", "video", "audio", "voice", "animation", "video_note"]) {
      const f = m[k];
      if (f) items.push({ id: f.file_id, size: f.file_size, name: f.file_name ?? `${k}.${f.mime_type?.split("/")[1] ?? "bin"}` });
    }
    const out: string[] = [];
    for (const it of items) {
      if ((it.size ?? 0) > MAX_DOWNLOAD) { await this.tg.send(thread, `⚠️ ${esc(it.name)} 超过 20MB，Bot API 下载不了`); continue; }
      const dest = join(this.cfg.stateDir, "inbox", String(thread), `${stamp}-${it.name.replace(/[^\w.\-一-鿿]/g, "_")}`);
      const saved = await this.tg.download(it.id, dest);
      if (saved) out.push(saved);
      else await this.tg.send(thread, `⚠️ ${esc(it.name)} 下载失败`);
    }
    return out;
  }

  async onCallback(q: any) {
    if (q.id !== "sim") await this.tg.call("answerCallbackQuery", { callback_query_id: q.id });
    if (!this.cfg.allowedUsers.has(q.from?.id)) return;
    const [kind, a, b, c] = String(q.data).split(":");
    const msg = q.message?.message_id;
    if (kind === "lc") return this.onLifecycle(a, Number(b), c === "l", msg);
    const thread = a, oi = c;
    const bind = this.store.state.topics[thread];
    if (kind !== "aq" || !bind) return;
    await H.sendKeys(bind.pane, [...Array(Number(oi)).fill("down"), "enter"]);
    const label = q.message?.reply_markup?.inline_keyboard?.[Number(oi)]?.[0]?.text ?? "";
    await this.tg.call("editMessageReplyMarkup", { chat_id: this.cfg.chatId, message_id: msg, reply_markup: { inline_keyboard: [] } });
    if (label) await this.tg.send(Number(thread), `☑️ 已选：${esc(label)}`, { reply_to_message_id: msg });
  }

  // Buttons from pane-down notices, /delete and the /sessions list. A pressed notice loses its buttons;
  // a pressed list is redrawn in place so it always shows the current state.
  private async onLifecycle(action: string, thread: number, fromList: boolean, msg?: number) {
    const clear = () => msg && this.tg.call("editMessageReplyMarkup", { chat_id: this.cfg.chatId, message_id: msg, reply_markup: { inline_keyboard: [] } });
    if (!fromList && action !== "delask") await clear();
    if (action === "resume") await this.life.open(thread);
    else if (action === "fresh") await this.life.open(thread, { fresh: true });
    else if (action === "close") await this.life.close(thread, false);
    else if (action === "delete") await this.life.remove(thread, true, "/delete");
    else if (action === "delask") {
      // from the list: ask where the list is, the topic itself may be far away
      const { html, keyboard } = this.life.deletePrompt(thread);
      await this.tg.send(undefined, html, { reply_markup: { inline_keyboard: keyboard } });
    }
    if (fromList && msg) {
      const { html, keyboard } = await this.life.listing(limitsLine(this.cfg));
      await this.tg.edit(msg, html, { reply_markup: { inline_keyboard: keyboard } });
    }
  }
}
