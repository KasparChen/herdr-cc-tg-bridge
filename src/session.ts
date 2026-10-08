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
import { REACT, type SendState, type Telegram } from "./telegram";
import { TranscriptTail, transcriptPath, type TEvent } from "./transcript";
import { parseCtx, type Ctx } from "./usage";

type Turn = {
  bubble?: number; lines: string[]; texts: string[]; calls: number; t0: number;
  lastEdit: number; dirty: boolean; sawWorking: boolean; written: string[]; ended?: boolean;
  msgs: number[]; // Telegram messages this turn answers: they get its outcome as a reaction
};
// What the last answer was made of and whether each part is known to have arrived, for /resend.
type Answer = { msgs: number[]; items: { html?: string; file?: string; state: SendState }[] };
const NO_BUBBLE = -1; // the bubble send had no reply: sending another could show it twice

const CTX_WARN = 80;

export function findTranscript(cwd: string, session: string): string {
  const p = transcriptPath(cwd, session);
  if (existsSync(p)) return p;
  for (const hit of new Glob(`*/${session}.jsonl`).scanSync(join(homedir(), ".claude/projects"))) return join(homedir(), ".claude/projects", hit);
  return p;
}

export class Watcher {
  status = "unknown";
  turn?: Turn;
  tail?: TranscriptTail;
  fromTg: { text: string; msg?: number; at: number }[] = []; // sent from Telegram, not yet seen in the transcript
  lastAnswer?: Answer;
  lastAsk?: { id: string; input: any };
  askedIds = new Set<string>();
  missing = 0;
  ctx?: Ctx; // latest context reading from Herdr
  private afterEnd = false; // turn closed by end_turn while Herdr still says working: wait for new transcript activity
  private busy = 0; // start time of the running tick, 0 when idle
  private timer: Timer;

  constructor(public thread: number, public bind: Binding, private cfg: Config, private tg: Telegram, private store: Store) {
    if (bind.session) this.tail = new TranscriptTail(findTranscript(bind.cwd, bind.session), true);
    this.timer = setInterval(async () => {
      if (this.busy) {
        // a tick that never settles would silence this topic for good: drop it and carry on
        if (Date.now() - this.busy > 90_000) { log("watcher stuck", thread, `${Math.round((Date.now() - this.busy) / 1000)}s`, "abandoning tick"); this.busy = 0; }
        return;
      }
      const me = (this.busy = Date.now());
      try { await this.tick(); } catch (e) { log("watcher", thread, e); } finally { if (this.busy === me) this.busy = 0; }
    }, 1000);
  }

  stop() { clearInterval(this.timer); }

  noteFromTg(text: string, msg?: number) {
    this.fromTg.push({ text: text.trim(), msg, at: Date.now() });
    if (this.fromTg.length > 20) this.fromTg.shift();
  }

  // a prompt Herdr refused never shows up in the transcript
  dropFromTg(msg: number) { this.fromTg = this.fromTg.filter(f => f.msg !== msg); }

  private newTurn(): Turn {
    return { lines: [], texts: [], calls: 0, t0: Date.now(), lastEdit: 0, dirty: true, sawWorking: false, written: [], msgs: [] };
  }

  private mark(emoji: string) { for (const m of this.turn?.msgs ?? []) this.tg.react(m, emoji); }

  async tick() {
    // a pane that has been gone for 10s is only re-checked every 15s
    if (this.missing >= 10 && ++this.missing % 15 !== 0) return;
    const st = await H.paneState(this.bind.pane, this.bind.terminal);
    if (st.state === "unknown") return; // Herdr not answering: the status message covers it, the topic stays quiet
    if (st.state !== "live") {
      if (this.missing < 10 && ++this.missing === 10) await this.paneDown(st.state);
      return;
    }
    this.missing = 0;
    const a = st.agent!;
    this.ctx = parseCtx(a.tokens?.context) ?? this.ctx;
    if (this.bind.notified || (!this.bind.terminal && st.terminal)) {
      this.bind.notified = undefined;
      this.bind.terminal ??= st.terminal;
      this.store.save();
    }
    const sid = a.agent_session?.value;
    if (sid && sid !== this.bind.session) {
      // new session in the same pane (/clear, restart): read the new transcript from its start
      this.bind.session = sid;
      this.store.save();
      this.tail = new TranscriptTail(findTranscript(this.bind.cwd, sid), false);
    }
    const prev = this.status;
    this.status = a.agent_status;
    if (this.status === "working" && !this.afterEnd) { this.turn ??= this.newTurn(); this.turn.sawWorking = true; }
    if (prev === "blocked" && this.status === "working") this.mark(REACT.working);
    for (const ev of this.tail?.read() ?? []) await this.onEvent(ev);
    // background agents keep Herdr at "working" after the reply is done; the transcript says when the turn ended
    if (this.turn?.ended) { await this.finish(); this.afterEnd = this.status === "working"; return; }
    if (this.status !== "working") this.afterEnd = false;
    if (this.turn) await this.render(false);
    if (this.status === "blocked" && prev !== "blocked") await this.onBlocked();
    const settled = this.status === "idle" || this.status === "done";
    if (settled && this.turn && (this.turn.sawWorking || Date.now() - this.turn.t0 > 5000)) await this.finish();
  }

  // Told once per outage, remembered in state.json so bridge restarts do not repeat it.
  private async paneDown(state: "exited" | "gone") {
    if (this.bind.notified) return;
    this.bind.notified = true;
    this.store.save();
    const resumable = !!this.bind.session && existsSync(findTranscript(this.bind.cwd, this.bind.session));
    const what = state === "exited" ? "这个会话在电脑上退出了" : "电脑上这个会话的标签页关掉了";
    const next = resumable ? "直接发消息会接着原会话" : "直接发消息会开一个新会话";
    const row = [
      ...(resumable ? [{ text: "接着原会话", callback_data: `lc:resume:${this.thread}` }] : []),
      { text: "开新会话", callback_data: `lc:fresh:${this.thread}` },
      { text: "关闭话题", callback_data: `lc:close:${this.thread}` },
    ];
    await this.tg.notice(this.thread, `⚪ ${what}。${next}`, { reply_markup: { inline_keyboard: [row] } });
  }

  private async onEvent(ev: TEvent) {
    if (ev.kind === "title") return this.onTitle(ev.title);
    this.afterEnd = false;
    if (ev.kind === "end") { if (this.turn) this.turn.ended = true; return; }
    if (ev.kind === "user" || ev.kind === "queued") {
      if (ev.text.startsWith("<")) return; // command / system wrappers
      this.turn ??= this.newTurn();
      const i = this.fromTg.findIndex(f => f.text === ev.text.trim());
      if (i >= 0) {
        const [f] = this.fromTg.splice(i, 1);
        if (f.msg) { this.turn.msgs.push(f.msg); this.tg.react(f.msg, this.status === "blocked" ? REACT.ask : REACT.working); }
      } else { this.turn.lines.push(`🖥 ${cut(ev.text.replace(/\s+/g, " "), 200)}`); this.turn.dirty = true; } // typed on the desktop
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
    const html = bubble(t.lines, t.calls, Math.floor((Date.now() - t.t0) / 1000), done, 3600, done && this.ctx ? `ctx ${this.ctx.text}` : "");
    if (t.bubble === NO_BUBBLE) return;
    if (t.bubble && (await this.tg.edit(t.bubble, html))) return;
    const r = await this.tg.sendState(this.thread, html);
    t.bubble = r.id ?? (r.state === "unknown" ? NO_BUBBLE : undefined);
  }

  private async finish() {
    for (const ev of this.tail?.read() ?? []) await this.onEvent(ev);
    const t = this.turn!;
    await this.render(true);
    this.turn = undefined;
    this.bind.lastActive = Date.now();
    this.store.save();
    const final = t.texts.join("\n\n").trim();
    const chunks = mdChunks(final);
    const files = pickOutbox(t.written, this.cfg);
    // Telegram messages that never matched a transcript entry would stay marked forever: once the session is
    // idle, settle the ones sent before this turn began along with it
    const settled = this.status === "idle" || this.status === "done";
    const stray = settled ? this.fromTg.filter(f => f.msg && f.at < t.t0) : [];
    this.fromTg = this.fromTg.filter(f => !stray.includes(f));
    const answer: Answer = { msgs: [...t.msgs, ...stray.map(f => f.msg!)], items: [...chunks.map(html => ({ html, state: "failed" as SendState })), ...files.map(file => ({ file, state: "failed" as SendState }))] };
    await this.deliver(answer);
    log("turn done", this.thread, { calls: t.calls, chunks: chunks.length, files: files.length, ctx: this.ctx?.text, unsent: answer.items.filter(i => i.state !== "ok").length });
    await this.ctxCheck();
  }

  // Send the parts not yet known to have arrived, then show the outcome on the user's messages:
  // no reaction = all arrived, 💔 = Telegram refused something, 😱 = something may not have arrived (/resend).
  private async deliver(a: Answer, only?: Set<object>) {
    for (const it of a.items) {
      if (only && !only.has(it)) continue;
      if (it.html) it.state = (await this.tg.sendState(this.thread, it.html)).state;
      else {
        it.state = await this.tg.sendFileState(this.thread, it.file!, `📎 <code>${esc(it.file!.replace(homedir(), "~"))}</code>`);
        log("outbox", this.thread, it.state, it.file);
      }
    }
    this.lastAnswer = a;
    const states = a.items.map(i => i.state);
    const emoji = states.includes("failed") ? REACT.failed : states.includes("unknown") ? REACT.unsure : undefined;
    for (const m of a.msgs) this.tg.react(m, emoji);
  }

  // /resend: the parts of the last answer that did not surely arrive
  async resend() {
    const a = this.lastAnswer;
    if (!a) { await this.tg.send(this.thread, "没有可以重发的回答。上一轮回答只存在内存里，bridge 重启后就没有了，可以在 Herdr 标签页里看"); return; }
    const todo = a.items.filter(i => i.state !== "ok");
    if (!todo.length) { await this.tg.send(this.thread, "上一轮回答已经全部发出"); return; }
    await this.deliver(a, new Set(todo));
    log("resend", this.thread, todo.map(i => i.state));
  }

  // once per fill-up: a nearly full context makes replies slower and compaction lossy, so suggest a fresh session
  private async ctxCheck() {
    const pct = this.ctx?.pct;
    if (pct === undefined) return;
    if (pct >= CTX_WARN && !this.bind.ctxWarned) {
      this.bind.ctxWarned = true;
      this.store.save();
      await this.tg.notice(this.thread, `⚠️ 上下文已用 ${esc(this.ctx!.text)}。可以发 <code>/clear</code> 清空，或者用 /new 开一个新会话`);
    } else if (pct < CTX_WARN / 2 && this.bind.ctxWarned) {
      this.bind.ctxWarned = undefined;
      this.store.save();
    }
  }

  private async onBlocked() {
    for (const ev of this.tail?.read() ?? []) await this.onEvent(ev);
    this.mark(REACT.ask);
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
    if (this.bind.tab && !this.bind.attached) await H.tabRename(this.bind.tab, title); // a desktop tab keeps its own name
  }
}
