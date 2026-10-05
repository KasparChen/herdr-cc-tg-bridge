// One Watcher per bound topic: polls Herdr status, tails the transcript, renders the turn into Telegram.
import { existsSync } from "fs";
import { Glob } from "bun";
import { homedir } from "os";
import { join } from "path";
import type { Config } from "./config";
import * as H from "./herdr";
import { log } from "./log";
import { pickOutbox } from "./outbox";
import { bubble, commentLine, cut, esc, mdChunks, toolLine } from "./render";
import type { Binding, Store } from "./store";
import type { Telegram } from "./telegram";
import { TranscriptTail, transcriptPath, type TEvent } from "./transcript";

type Turn = {
  bubble?: number; lines: string[]; texts: string[]; calls: number; t0: number;
  lastEdit: number; dirty: boolean; sawWorking: boolean; written: string[];
};

function findTranscript(cwd: string, session: string): string {
  const p = transcriptPath(cwd, session);
  if (existsSync(p)) return p;
  for (const hit of new Glob(`*/${session}.jsonl`).scanSync(join(homedir(), ".claude/projects"))) return join(homedir(), ".claude/projects", hit);
  return p;
}

export class Watcher {
  status = "unknown";
  turn?: Turn;
  tail?: TranscriptTail;
  fromTg: string[] = [];
  lastAsk?: { id: string; input: any };
  askedIds = new Set<string>();
  missing = 0;
  private busy = false;
  private timer: Timer;

  constructor(public thread: number, public bind: Binding, private cfg: Config, private tg: Telegram, private store: Store) {
    if (bind.session) this.tail = new TranscriptTail(findTranscript(bind.cwd, bind.session), true);
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try { await this.tick(); } catch (e) { log("watcher", thread, e); } finally { this.busy = false; }
    }, 1000);
  }

  stop() { clearInterval(this.timer); }

  noteFromTg(text: string) { this.fromTg.push(text.trim()); if (this.fromTg.length > 20) this.fromTg.shift(); }

  private newTurn(): Turn {
    return { lines: [], texts: [], calls: 0, t0: Date.now(), lastEdit: 0, dirty: true, sawWorking: false, written: [] };
  }

  async tick() {
    // a pane that has been gone for 10s is only re-checked every 15s
    if (this.missing >= 10 && ++this.missing % 15 !== 0) return;
    const a = await H.agentGet(this.bind.pane);
    if (!a) {
      if (this.missing < 10 && ++this.missing === 10) await this.tg.send(this.thread, "⚠️ 这个话题对应的 Herdr 窗格不见了。发一条消息会自动开新会话。");
      return;
    }
    this.missing = 0;
    const sid = a.agent_session?.value;
    if (sid && sid !== this.bind.session) {
      // new session in the same pane (/clear, restart): read the new transcript from its start
      this.bind.session = sid;
      this.store.save();
      this.tail = new TranscriptTail(findTranscript(this.bind.cwd, sid), false);
    }
    const prev = this.status;
    this.status = a.agent_status;
    if (this.status === "working") { this.turn ??= this.newTurn(); this.turn.sawWorking = true; }
    for (const ev of this.tail?.read() ?? []) await this.onEvent(ev);
    if (this.turn) await this.render(false);
    if (this.status === "blocked" && prev !== "blocked") await this.onBlocked();
    const settled = this.status === "idle" || this.status === "done";
    if (settled && this.turn && (this.turn.sawWorking || Date.now() - this.turn.t0 > 5000)) await this.finish();
  }

  private async onEvent(ev: TEvent) {
    if (ev.kind === "title") return this.onTitle(ev.title);
    if (ev.kind === "user" || ev.kind === "queued") {
      if (ev.text.startsWith("<")) return; // command / system wrappers
      this.turn ??= this.newTurn();
      const i = this.fromTg.indexOf(ev.text.trim());
      if (i >= 0) this.fromTg.splice(i, 1);
      else { this.turn.lines.push(`🖥 ${cut(ev.text.replace(/\s+/g, " "), 200)}`); this.turn.dirty = true; } // typed on the desktop
      return;
    }
    this.turn ??= this.newTurn();
    const t = this.turn;
    if (ev.kind === "text") { t.texts.push(ev.text); return; }
    if (t.texts.length) { t.lines.push(...t.texts.map(commentLine)); t.texts = []; }
    t.calls++;
    t.lines.push(toolLine(ev.name, ev.input));
    t.dirty = true;
    if (ev.name === "Write" && ev.input?.file_path) t.written.push(ev.input.file_path);
    if (ev.name === "AskUserQuestion") this.lastAsk = { id: ev.id, input: ev.input };
  }

  private async render(done: boolean) {
    const t = this.turn!;
    if (!t.lines.length) return;
    if (!done && (!t.dirty || Date.now() - t.lastEdit < 1500)) return;
    t.dirty = false;
    t.lastEdit = Date.now();
    const html = bubble(t.lines, t.calls, Math.floor((Date.now() - t.t0) / 1000), done);
    if (t.bubble && (await this.tg.edit(t.bubble, html))) return;
    t.bubble = await this.tg.send(this.thread, html);
  }

  private async finish() {
    for (const ev of this.tail?.read() ?? []) await this.onEvent(ev);
    const t = this.turn!;
    await this.render(true);
    this.turn = undefined;
    const final = t.texts.join("\n\n").trim();
    const chunks = mdChunks(final);
    for (const c of chunks) await this.tg.send(this.thread, c);
    const files = pickOutbox(t.written, this.cfg);
    for (const f of files) {
      const ok = await this.tg.sendFile(this.thread, f, `📎 <code>${esc(f.replace(homedir(), "~"))}</code>`);
      log("outbox", this.thread, ok ? "sent" : "FAILED", f);
    }
    log("turn done", this.thread, { calls: t.calls, chunks: chunks.length, files: files.length });
  }

  private async onBlocked() {
    for (const ev of this.tail?.read() ?? []) await this.onEvent(ev);
    const ask = this.lastAsk;
    if (ask && !this.askedIds.has(ask.id)) {
      this.askedIds.add(ask.id);
      const qs: any[] = ask.input?.questions ?? [];
      // buttons only for a single single-select question: key presses land on whichever question is active,
      // so with several questions a button could select an option in the wrong one
      if (qs.length === 1 && !qs[0].multiSelect) {
        const q = qs[0];
        const kb = q.options.map((o: any, oi: number) => [{ text: cut(o.label, 60), callback_data: `aq:${this.thread}:0:${oi}` }]);
        const desc = q.options.map((o: any) => (o.description ? `• <b>${esc(o.label)}</b>：${esc(o.description)}` : "")).filter(Boolean).join("\n");
        await this.tg.send(this.thread, `❓ <b>${esc(q.question)}</b>${desc ? "\n" + desc : ""}`, { reply_markup: { inline_keyboard: kb } });
        return;
      }
    }
    const screen = (await H.paneRead(this.bind.pane)).split("\n").filter(l => l.trim()).slice(-18).join("\n");
    await this.tg.send(this.thread, `⏸ 会话在等你操作。可以用 /keys 回应，例如 <code>/keys down enter</code>、<code>/keys esc</code>\n<pre>${esc(cut(screen, 3200))}</pre>`);
  }

  private async onTitle(title: string) {
    if (!this.bind.autoName || this.bind.title === title) return;
    this.bind.title = title;
    this.store.save();
    await this.tg.call("editForumTopic", { chat_id: this.tg.chatId, message_thread_id: this.thread, name: cut(title, 120) });
    if (this.bind.tab) await H.tabRename(this.bind.tab, title);
  }
}
