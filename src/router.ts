// Inbound Telegram updates: commands, text, attachments, button callbacks.
import { join } from "path";
import type { Config } from "./config";
import * as H from "./herdr";
import { log } from "./log";
import { cut, esc } from "./render";
import { Watcher } from "./session";
import type { Status } from "./status";
import type { Store } from "./store";
import { MAX_DOWNLOAD, type Telegram } from "./telegram";

const HELP = [
  "<b>tg-bridge 用法</b>",
  "• 话题外发 <code>/new 名字</code>：新建话题和会话",
  "• 手动新建一个话题：自动绑定一个新会话",
  "• 在话题里发文字、图片、文件：送进对应会话",
  "• 话题里的 <code>/clear</code> 等斜杠命令原样送进会话",
  "• <code>/stop</code> 打断当前回复，<code>/screen</code> 看会话屏幕",
  "• <code>/keys down enter</code> 往会话发按键",
  "• <code>/status</code> 看 bridge 状态",
].join("\n");

const SPAWN_PROMPT = (tgSend: string) =>
  `This Claude Code session is being driven from a Telegram forum topic through tg-bridge; the user reads your replies on a phone. ` +
  `Files you create with the Write tool in common deliverable formats are sent to the user automatically at the end of the turn. ` +
  `For anything else the user should receive (files produced by scripts or commands, screenshots, existing files), run: ${tgSend} <path> [<path> ...]. ` +
  `Attachments the user sends arrive as local file paths in the message.`;

export class Router {
  constructor(
    private cfg: Config, private tg: Telegram, private store: Store,
    private watchers: Map<number, Watcher>, private status: Status, private tgSendPath: string,
  ) {}

  watch(thread: number) {
    const b = this.store.state.topics[thread];
    if (b && !this.watchers.has(thread)) this.watchers.set(thread, new Watcher(thread, b, this.cfg, this.tg, this.store));
  }

  async bindNew(thread: number, label: string, autoName: boolean): Promise<boolean> {
    const ws = await H.resolveWorkspace(this.cfg.workspace);
    const s = await H.spawnClaude({
      workspace: ws, cwd: this.cfg.workdir, label,
      args: ["--append-system-prompt", SPAWN_PROMPT(this.tgSendPath), ...this.cfg.claudeArgs],
    });
    if (!s) { await this.tg.send(thread, "❌ 创建会话失败，Herdr 没有返回窗格"); return false; }
    this.watchers.get(thread)?.stop();
    this.watchers.delete(thread);
    this.store.state.topics[thread] = { pane: s.pane, tab: s.tab, session: s.session, cwd: this.cfg.workdir, autoName };
    this.store.save();
    this.watch(thread);
    await this.tg.send(thread, `🟢 新会话已就绪 · Herdr <code>${s.pane}</code>`);
    return true;
  }

  async onUpdate(u: any) {
    if (u.message) await this.onMessage(u.message).catch(e => log("message", e));
    if (u.callback_query) await this.onCallback(u.callback_query).catch(e => log("callback", e));
  }

  async onMessage(m: any) {
    if (m.chat?.id !== this.cfg.chatId || !this.cfg.allowedUsers.has(m.from?.id)) return;
    const thread: number | undefined = m.is_topic_message ? m.message_thread_id : undefined;
    if (m.forum_topic_created) {
      await this.bindNew(m.message_thread_id, cut(m.forum_topic_created.name ?? `tg-${m.message_thread_id}`, 40), false);
      return;
    }
    const text: string = (m.text ?? m.caption ?? "").trim();
    const [first = "", ...rest] = text.split(/\s+/);
    const cmd = first.startsWith("/") ? first.replace(/@\w+$/, "").toLowerCase() : "";

    if (cmd === "/help" || cmd === "/start") { await this.tg.send(thread, HELP); return; }
    if (cmd === "/status") { await this.tg.send(thread, this.status.text()); return; }
    if (cmd === "/new") {
      const name = rest.join(" ");
      const j = await this.tg.call("createForumTopic", { chat_id: this.cfg.chatId, name: cut(name || `新会话 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`, 120) });
      if (!j.ok) { await this.tg.send(thread, `❌ 建话题失败：${esc(j.description ?? "")}`); return; }
      await this.bindNew(j.result.message_thread_id, cut(name || `tg-${j.result.message_thread_id}`, 40), !name);
      return;
    }
    if (!thread) { if (text || m.photo || m.document) await this.tg.send(undefined, HELP); return; }

    // a message in a topic that has no live session yet: open one first
    const old = this.store.state.topics[thread];
    if (!old || !(await H.agentGet(old.pane))) {
      if (!(await this.bindNew(thread, old?.title ?? `tg-${thread}`, old?.autoName ?? false))) return;
    }
    const b = this.store.state.topics[thread];
    if (cmd === "/keys") { await H.sendKeys(b.pane, rest); return; }
    if (cmd === "/stop") { await H.sendKeys(b.pane, ["esc"]); return; }
    if (cmd === "/screen") {
      const s = (await H.paneRead(b.pane)).split("\n").filter(l => l.trim()).slice(-30).join("\n");
      await this.tg.send(thread, `<pre>${esc(cut(s, 3800))}</pre>`);
      return;
    }

    const files = await this.saveAttachments(m, thread);
    if (!text && !files.length) return;
    const body = [text || (files.length ? "（见附件）" : ""), ...files.map(f => `[附件] ${f}`)].join("\n");
    this.watchers.get(thread)?.noteFromTg(body);
    const r = await H.prompt(b.pane, body);
    if (!r?.result) await this.tg.send(thread, `⚠️ 送达失败，Herdr 返回 <code>${esc(cut(JSON.stringify(r?.error ?? r), 300))}</code>`);
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
    await this.tg.call("answerCallbackQuery", { callback_query_id: q.id });
    if (!this.cfg.allowedUsers.has(q.from?.id)) return;
    const [kind, thread, , oi] = String(q.data).split(":");
    const b = this.store.state.topics[thread];
    if (kind !== "aq" || !b) return;
    await H.sendKeys(b.pane, [...Array(Number(oi)).fill("down"), "enter"]);
    const label = q.message?.reply_markup?.inline_keyboard?.[Number(oi)]?.[0]?.text ?? "";
    await this.tg.call("editMessageReplyMarkup", { chat_id: this.cfg.chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
    if (label) await this.tg.send(Number(thread), `☑️ 已选：${esc(label)}`, { reply_to_message_id: q.message.message_id });
  }
}
