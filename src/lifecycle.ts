// Topic <-> session lifecycle: open or resume, attach a desktop session, close, delete, list.
// Every topic message the user sees about a session's state comes from here or from the Watcher, once per change.
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import type { Config } from "./config";
import * as H from "./herdr";
import { log } from "./log";
import { cut, esc, mdChunks } from "./render";
import { findTranscript, Watcher } from "./session";
import type { Binding, Store } from "./store";
import type { Telegram } from "./telegram";
import { parseLine } from "./transcript";
import { parseCtx } from "./usage";

const SPAWN_PROMPT = (tgSend: string) =>
  `This Claude Code session is being driven from a Telegram forum topic through tg-bridge; the user reads your replies on a phone. ` +
  `Files you create with the Write tool in common deliverable formats are sent to the user automatically at the end of the turn. ` +
  `For anything else the user should receive (files produced by scripts or commands, screenshots, existing files), run: ${tgSend} <path> [<path> ...]. ` +
  `Attachments the user sends arrive as local file paths in the message.`;

export const ago = (t: number | undefined, now = Date.now()) => {
  if (!t) return "";
  const m = Math.floor((now - t) / 60000);
  return m < 1 ? "刚刚" : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.floor(m / 60)} 小时前` : `${Math.floor(m / 1440)} 天前`;
};

// terminal titles carry Claude's spinner / status glyph in front ("◐ ", "✳ ")
export const cleanTitle = (t?: string) => (t ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// Last finished exchange in a transcript: the last real user prompt and the reply that closed its turn.
export function lastExchange(text: string): { ask?: string; answer?: string; title?: string } {
  let ask: string | undefined, answer: string | undefined, title: string | undefined;
  let pendingAsk: string | undefined, texts: string[] = [];
  for (const line of text.split("\n")) {
    for (const ev of parseLine(line)) {
      if (ev.kind === "title") title = ev.title;
      else if (ev.kind === "user" && !ev.text.startsWith("<")) { pendingAsk = ev.text; texts = []; }
      else if (ev.kind === "text") texts.push(ev.text);
      else if (ev.kind === "tool") texts = [];
      else if (ev.kind === "end") { ask = pendingAsk ?? ask; answer = texts.join("\n\n").trim() || answer; texts = []; }
    }
  }
  return { ask, answer, title };
}

const STATE_LABEL: Record<string, string> = {
  working: "🔵 运行中", blocked: "⏸ 等你操作", idle: "🟢 空闲", done: "🟢 空闲",
  exited: "⚪ 已退出", gone: "⚪ 标签页已关", unknown: "❔ Herdr 连不上", closed: "🔒 已关闭",
};

export class Lifecycle {
  private checking = new Set<number>();

  constructor(
    private cfg: Config, private tg: Telegram, private store: Store,
    private watchers: Map<number, Watcher>, private tgSendPath: string,
  ) {
    tg.onThreadGone = t => { this.onThreadGone(t).catch(e => log("thread gone", t, e)); };
  }

  name(thread: number, b?: Binding) { return b?.title ?? b?.name ?? `tg-${thread}`; }

  watch(thread: number) {
    const b = this.store.state.topics[thread];
    if (b && !b.closedAt && !this.watchers.has(thread)) this.watchers.set(thread, new Watcher(thread, b, this.cfg, this.tg, this.store));
  }

  private unwatch(thread: number) {
    this.watchers.get(thread)?.stop();
    this.watchers.delete(thread);
  }

  canResume(b?: Binding) { return !!b?.session && existsSync(findTranscript(b.cwd, b.session)); }

  // "Herdr TELEGRAM / 周报草稿": where the session lives, in words the user recognises
  private async where(workspace?: string, tab?: string) {
    const ws = (await H.workspaces())?.find(w => w.workspace_id === workspace)?.label;
    return `Herdr ${esc([ws, tab].filter(Boolean).join(" / "))}`;
  }

  // Make the topic's session live. Resumes the bound session (claude --resume) unless `fresh`; reuses a pane that
  // is left with a shell; reopens the topic if it was closed. Returns false when no session could be started.
  async open(thread: number, opts: { name?: string; autoName?: boolean; fresh?: boolean } = {}): Promise<boolean> {
    const old = this.store.state.topics[thread];
    // a closed desktop session is normally still running, so look at the pane even when the binding is closed
    const st = old ? await H.paneState(old.pane, old.terminal) : undefined;
    if (st?.state === "unknown") { await this.tg.notice(thread, "⚠️ Herdr 连不上，没法开会话。打开电脑上的 Herdr 后再试"); return false; }
    if (old?.closedAt) await this.tg.call("reopenForumTopic", { chat_id: this.cfg.chatId, message_thread_id: thread });
    if (st?.state === "live" && !opts.fresh) {
      if (old!.closedAt) {
        old!.closedAt = undefined;
        this.store.save();
        await this.tg.notice(thread, `🔗 已重新连上 · ${await this.where(st.agent!.workspace_id, cleanTitle(st.agent!.terminal_title_stripped))}`);
      }
      this.watch(thread);
      return true;
    }
    if (st?.state === "live" && !old!.attached) await H.paneClose(old!.pane);

    const resume = !opts.fresh && this.canResume(old);
    const label = cut(this.name(thread, old ?? { name: opts.name } as Binding), 40);
    const ws = await H.resolveWorkspace(this.cfg.workspace);
    const s = await H.spawnClaude({
      workspace: ws,
      cwd: resume ? old!.cwd : this.cfg.workdir, label, agent: `tg-${thread}`,
      pane: st?.state === "exited" && !old!.attached ? old!.pane : undefined,
      args: [...(resume ? ["--resume", old!.session!] : []), "--append-system-prompt", SPAWN_PROMPT(this.tgSendPath), ...this.cfg.claudeArgs],
    });
    if (!s) { await this.tg.notice(thread, "❌ 开会话失败，Herdr 没有返回窗格"); return false; }
    this.unwatch(thread);
    this.store.state.topics[thread] = {
      ...(old ?? { cwd: this.cfg.workdir, name: opts.name, autoName: opts.autoName ?? false }),
      pane: s.pane, tab: s.tab, terminal: s.terminal,
      session: s.session ?? (resume ? old!.session : undefined),
      cwd: resume ? old!.cwd : this.cfg.workdir,
      closedAt: undefined, notified: undefined, attached: undefined, lastActive: Date.now(),
    };
    this.store.save();
    this.watch(thread);
    log("open", thread, { resume, pane: s.pane, reusedPane: st?.state === "exited" });
    await this.tg.notice(thread, `${resume ? "🔄 已接回原会话" : "🟢 新会话已就绪"} · ${await this.where(ws, label)}`);
    return true;
  }

  // /tg-bind from inside a desktop session: new topic, handoff card, last answer, then live sync.
  async attach(pane: string): Promise<{ ok: boolean; thread?: number; error?: string; already?: boolean }> {
    const bound = this.store.topicOfPane(pane);
    if (bound) return { ok: true, thread: bound, already: true };
    const st = await H.paneState(pane);
    // bound before and then closed in Telegram: reopen that topic rather than open a second one for the same pane
    const closed = Object.entries(this.store.state.topics).find(([, b]) => b.pane === pane && b.closedAt && b.terminal === st.terminal);
    if (closed && st.state === "live") {
      const ok = await this.open(Number(closed[0]));
      return ok ? { ok, thread: Number(closed[0]) } : { ok, error: "could not reopen the earlier topic" };
    }
    if (st.state === "unknown") return { ok: false, error: "Herdr is not answering" };
    if (st.state !== "live") return { ok: false, error: "no Claude session is running in this pane" };
    const a = st.agent!;
    const session = a.agent_session?.value;
    if (!session) return { ok: false, error: "Herdr has no session id for this pane: the session was started before `herdr integration install claude`, so its transcript cannot be found" };
    const path = findTranscript(a.cwd, session);
    const ex = existsSync(path) ? lastExchange(readFileSync(path, "utf8")) : {};
    const title = cut(ex.title || cleanTitle(a.terminal_title_stripped) || "电脑会话", 120);
    const j = await this.tg.call("createForumTopic", { chat_id: this.cfg.chatId, name: title });
    if (!j.ok) return { ok: false, error: `createForumTopic failed: ${j.description}` };
    const thread: number = j.result.message_thread_id;
    this.store.state.topics[thread] = {
      pane, tab: a.tab_id, terminal: a.terminal_id, session, cwd: a.cwd,
      name: title, title, autoName: true, attached: true, lastActive: Date.now(),
    };
    this.store.save();
    const ctx = parseCtx(a.tokens?.context);
    const card = [
      `🔗 <b>已从电脑接过来</b> · ${await this.where(a.workspace_id, cleanTitle(a.terminal_title_stripped))}`,
      `目录 <code>${esc(a.cwd.replace(homedir(), "~"))}</code>${ctx ? ` · ctx ${esc(ctx.text)}` : ""}`,
      ex.ask ? `上一轮你问的是「${esc(cut(ex.ask.replace(/\s+/g, " "), 300))}」，回答在下面` : "",
      "在这里发消息，就是在电脑上那个会话里发。关闭或删除这个话题只断开 Telegram，电脑上的会话继续开着",
    ].filter(Boolean).join("\n");
    await this.tg.notice(thread, card);
    if (ex.answer) for (const c of mdChunks(ex.answer)) await this.tg.send(thread, c);
    this.watch(thread);
    log("attach", thread, { pane, session });
    return { ok: true, thread };
  }

  // End the pane (unless it is a desktop session) and close the topic; the binding is kept so reopening resumes.
  async close(thread: number, byClient: boolean) {
    const b = this.store.state.topics[thread];
    if (!b && byClient) return; // a topic the bridge never used: nothing to say
    this.unwatch(thread);
    if (b && !b.closedAt) {
      if (!b.attached) await this.endPane(b);
      b.closedAt = Date.now();
      b.notified = undefined;
      this.store.save();
      log("close", thread, { byClient, attached: !!b.attached });
    }
    await this.tg.notice(thread, !b ? "🔒 话题已关闭"
      : b.attached ? "🔒 已断开，电脑上的会话继续开着。重新打开话题，或者在这里发消息，会重新连上"
      : "🔒 会话已结束，话题已关闭。重新打开话题，或者在这里发消息，会接着原会话");
    if (!byClient) await this.tg.call("closeForumTopic", { chat_id: this.cfg.chatId, message_thread_id: thread });
  }

  // Drop the binding and end its pane (desktop sessions are left running); with deleteTopic the topic goes too.
  async remove(thread: number, deleteTopic: boolean, why: string) {
    const b = this.store.state.topics[thread];
    this.unwatch(thread);
    if (b && !b.closedAt && !b.attached) await this.endPane(b);
    if (b) this.store.remove(thread);
    if (deleteTopic) await this.tg.call("deleteForumTopic", { chat_id: this.cfg.chatId, message_thread_id: thread });
    log("remove", thread, { why, deleteTopic, attached: !!b?.attached });
  }

  private async endPane(b: Binding) {
    const st = await H.paneState(b.pane, b.terminal);
    if (st.state === "live" || st.state === "exited") await H.paneClose(b.pane);
  }

  async renamed(thread: number, name: string) {
    const b = this.store.state.topics[thread];
    if (!b || !name) return;
    b.title = name;
    b.autoName = false; // a name the user picked is never overwritten by the session title
    this.store.save();
    if (b.tab && !b.closedAt && !b.attached) await H.tabRename(b.tab, name);
  }

  // A send failed with "message thread not found": the topic was probably deleted. Confirm before acting.
  private async onThreadGone(thread: number) {
    const b = this.store.state.topics[thread];
    if (!b || this.checking.has(thread)) return;
    this.checking.add(thread);
    try {
      if ((await this.tg.topicAlive(thread, !!b.closedAt)) === false) await this.remove(thread, false, "topic deleted");
    } finally { this.checking.delete(thread); }
  }

  // Deleted topics never produce an update, so every binding is probed now and then. Returns removed threads.
  async sweep(): Promise<number[]> {
    const gone: number[] = [];
    for (const [t, b] of Object.entries(this.store.state.topics)) {
      const thread = Number(t);
      if ((await this.tg.topicAlive(thread, !!b.closedAt)) === false) {
        await this.remove(thread, false, "topic deleted");
        gone.push(thread);
      }
    }
    return gone;
  }

  private link(thread: number) {
    return `https://t.me/c/${String(this.cfg.chatId).replace(/^-100/, "")}/${thread}`;
  }

  // /sessions: one line per binding plus a button row each.
  async listing(limits: string): Promise<{ html: string; keyboard: any[][] }> {
    const removed = await this.sweep();
    const rows = Object.entries(this.store.state.topics)
      .map(([t, b]) => ({ thread: Number(t), b }))
      .sort((x, y) => (y.b.lastActive ?? y.b.closedAt ?? 0) - (x.b.lastActive ?? x.b.closedAt ?? 0));
    const lines: string[] = [];
    const keyboard: any[][] = [];
    for (const { thread, b } of rows) {
      const st = b.closedAt ? undefined : await H.paneState(b.pane, b.terminal);
      const state = !st ? "closed" : st.state === "live" ? st.agent!.agent_status : st.state;
      const ctx = parseCtx(st?.agent?.tokens?.context);
      const name = this.name(thread, b);
      const when = ago(state === "closed" ? b.closedAt : b.lastActive);
      const bits = [STATE_LABEL[state] ?? state, `<a href="${this.link(thread)}">${esc(cut(name, 40))}</a>`, b.attached ? "电脑会话" : "", ctx ? `ctx ${esc(ctx.text)}` : "", when];
      lines.push(bits.filter(Boolean).join(" · "));
      const short = cut(name, 12);
      const del = { text: `删除 ${short}`, callback_data: `lc:delask:${thread}` };
      if (state === "closed") keyboard.push([{ text: `重开 ${short}`, callback_data: `lc:resume:${thread}:l` }, del]);
      else if (state === "exited" || state === "gone") keyboard.push([{ text: `接回 ${short}`, callback_data: `lc:resume:${thread}:l` }, del]);
      else if (state !== "unknown") keyboard.push([{ text: `关闭 ${short}`, callback_data: `lc:close:${thread}:l` }, del]);
    }
    const out = [`<b>会话 ${rows.length} 个</b>`, ...lines];
    if (!rows.length) out.push("还没有会话。发 /new 名字 新建一个，或者在电脑上的会话里用 /tg-bind");
    if (removed.length) out.push(`<i>话题已被删除，已移除 ${removed.length} 个绑定</i>`);
    if (limits) out.push(`<i>额度 ${esc(limits)}</i>`);
    return { html: out.join("\n"), keyboard };
  }

  // confirmation for deleting, shared by /delete and the list buttons
  deletePrompt(thread: number) {
    const b = this.store.state.topics[thread];
    const what = b?.attached ? "电脑上的会话继续开着，" : "会话会结束，";
    return {
      html: `确定删除「${esc(cut(this.name(thread, b), 40))}」吗？${what}话题和全部聊天记录一起删除，没法恢复`,
      keyboard: [[{ text: "确认删除", callback_data: `lc:delete:${thread}` }, { text: "取消", callback_data: `lc:cancel:${thread}` }]],
    };
  }
}
