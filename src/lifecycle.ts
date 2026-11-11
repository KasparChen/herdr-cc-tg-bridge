// Topic <-> session lifecycle: open or resume, attach a desktop session, close, delete, list.
// Every topic message the user sees about a session's state comes from here or from the Watcher, once per change.
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import type { Config } from "./config";
import * as H from "./herdr";
import { log } from "./log";
import { cut, esc, mdChunks } from "./render";
import { Watcher } from "./session";
import type { Binding, Store } from "./store";
import type { Telegram } from "./telegram";
import { codexSessionMeta, findTranscript, transcriptParser } from "./transcript";
import { agentKind, codexInstructions, codexSessionName, launchArgs, panesShowing, type AgentKind } from "./providers";
import { parseCtx } from "./usage";
import { tr } from "./i18n";
import { backendName, detectBackend, type Backend } from "./backends";

const SPAWN_PROMPT = (kind: AgentKind, tgSend: string) =>
  `This ${kind === "codex" ? "Codex" : "Claude Code"} session is being driven from a Telegram forum topic through tg-bridge; the user reads your replies on a phone. ` +
  (kind === "claude" ? `Files you create with the Write tool in common deliverable formats are sent to the user automatically at the end of the turn. ` +
  `For anything else the user should receive (files produced by scripts or commands, screenshots, existing files), run: ${tgSend} <path> [<path> ...]. `
  : `To send the user a file (anything you produced, screenshots, existing files), run: ${tgSend} <path> [<path> ...]. ` +
    `It posts to the bridge on 127.0.0.1, so a sandbox without network makes it fail (curl exit code 7); then run it again with escalated permissions. `) +
  `Attachments the user sends arrive as local file paths in the message.`;

export const ago = (t: number | undefined, now = Date.now()) => {
  if (!t) return "";
  const m = Math.floor((now - t) / 60000);
  return m < 1 ? tr("刚刚", "just now") : m < 60 ? tr(`${m} 分钟前`, `${m} min ago`) : m < 1440 ? tr(`${Math.floor(m / 60)} 小时前`, `${Math.floor(m / 60)} h ago`) : tr(`${Math.floor(m / 1440)} 天前`, `${Math.floor(m / 1440)} d ago`);
};

// terminal titles carry Claude's spinner / status glyph in front ("◐ ", "✳ ")
export const cleanTitle = (t?: string) => (t ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// Last finished exchange in a transcript: the last real user prompt and the reply that closed its turn.
export function lastExchange(text: string, kind: AgentKind = "claude"): { ask?: string; answer?: string; title?: string } {
  let ask: string | undefined, answer: string | undefined, title: string | undefined;
  let pendingAsk: string | undefined, texts: string[] = [];
  const parse = transcriptParser(kind);
  for (const line of text.split("\n")) {
    for (const ev of parse(line)) {
      if (ev.kind === "title") title = ev.title;
      else if (ev.kind === "user" && !ev.text.startsWith("<")) { pendingAsk = ev.text; texts = []; }
      else if (ev.kind === "text") texts.push(ev.text);
      else if (ev.kind === "tool") texts = [];
      else if (ev.kind === "end") {
        // an interrupted turn has no answer: keep the exchange before it rather than pair its ask with an old answer
        const final = ev.aborted ? "" : texts.join("\n\n").trim();
        if (final) { ask = pendingAsk ?? ask; answer = final; }
        texts = [];
      }
    }
  }
  return { ask, answer, title };
}

const STATE_LABEL = (): Record<string, string> => ({
  working: tr("🔵 运行中", "🔵 running"), blocked: tr("⏸ 等你操作", "⏸ waiting for you"), idle: tr("🟢 空闲", "🟢 idle"), done: tr("🟢 空闲", "🟢 idle"),
  exited: tr("⚪ 已退出", "⚪ exited"), gone: tr("⚪ 标签页已关", "⚪ tab closed"), unknown: tr("❔ Herdr 连不上", "❔ Herdr unreachable"), closed: tr("🔒 已关闭", "🔒 closed"),
});

export class Lifecycle {
  private checking = new Set<number>();

  constructor(
    private cfg: Config, private tg: Telegram, private store: Store,
    private watchers: Map<number, Watcher>, private tgSendPath: string,
  ) {
    tg.onThreadGone = t => { this.onThreadGone(t).catch(e => log("thread gone", t, e)); };
  }

  name(thread: number, b?: Binding) { return b?.title ?? b?.name ?? `tg-${thread}`; }

  backend(name?: string): Backend | undefined { return this.cfg.backends.find(b => b.name === name); }

  // what /new and topics made in the client start: set with /config (state.json), else from .env
  defaultBackend(): string {
    const saved = this.store.state.defaultBackend;
    if (saved && this.backend(saved)) return saved;
    if (saved) log("default backend", saved, "is no longer configured; using", this.cfg.defaultBackend);
    return this.cfg.defaultBackend;
  }

  setDefaultBackend(name: string): boolean {
    if (!this.backend(name)) return false;
    this.store.state.defaultBackend = name;
    this.store.save();
    return true;
  }

  // the backend a binding resumes with; one removed from .env since falls back to the built-in of its kind
  private backendOf(b?: Binding): Backend {
    const name = b ? backendName(b) : this.defaultBackend();
    return this.backend(name) ?? this.backend(b?.kind === "codex" ? "codex" : "claude")!;
  }

  watch(thread: number) {
    const b = this.store.state.topics[thread];
    if (b && !b.closedAt && !this.watchers.has(thread)) this.watchers.set(thread, new Watcher(thread, b, this.cfg, this.tg, this.store));
  }

  private unwatch(thread: number) {
    this.watchers.get(thread)?.stop();
    this.watchers.delete(thread);
  }

  canResume(b?: Binding) { return !!b?.session && existsSync(findTranscript(b.cwd, b.session, b.kind)); }

  // "Herdr TELEGRAM / 周报草稿": where the session lives, in words the user recognises
  private async where(workspace?: string, tab?: string) {
    const ws = (await H.workspaces())?.find(w => w.workspace_id === workspace)?.label;
    return `Herdr ${esc([ws, tab].filter(Boolean).join(" / "))}`;
  }

  // Make the topic's session live. Resumes the bound session (claude --resume) unless `fresh`; reuses a pane that
  // is left with a shell; reopens the topic if it was closed. Returns false when no session could be started.
  async open(thread: number, opts: { name?: string; autoName?: boolean; fresh?: boolean; backend?: string } = {}): Promise<boolean> {
    const old = this.store.state.topics[thread];
    // a closed desktop session is normally still running, so look at the pane even when the binding is closed
    const st = old ? await H.paneState(old.pane, old.terminal) : undefined;
    if (st?.state === "unknown") { await this.tg.notice(thread, tr("⚠️ Herdr 连不上，没法开会话。打开电脑上的 Herdr 后再试", "⚠️ Cannot reach Herdr, so no session can be opened. Open Herdr on the computer and try again")); return false; }
    if (old?.closedAt) await this.tg.call("reopenForumTopic", { chat_id: this.cfg.chatId, message_thread_id: thread });
    if (st?.state === "live" && !opts.fresh) {
      if (old!.closedAt) {
        old!.closedAt = undefined;
        this.store.save();
        await this.tg.notice(thread, `${tr("🔗 已重新连上", "🔗 Reconnected")} · ${await this.where(st.agent!.workspace_id, cleanTitle(st.agent!.terminal_title_stripped))}`);
      }
      this.watch(thread);
      return true;
    }
    if (st?.state === "live" && !old!.attached) await H.paneClose(old!.pane);

    const be = opts.backend ? this.backend(opts.backend) ?? this.backendOf(old) : this.backendOf(old);
    // a session id is only resumable by a backend of the same kind
    const resume = !opts.fresh && this.canResume(old) && be.kind === (old!.kind ?? "claude");
    const label = cut(this.name(thread, old ?? { name: opts.name } as Binding), 40);
    const reuse = st?.state === "exited" && !old!.attached ? old!.pane : undefined;
    const made = reuse ? { id: await H.resolveWorkspace(this.cfg.workspace) } : await H.ensureWorkspace(this.cfg.workspace, resume ? old!.cwd : this.cfg.workdir);
    const ws = made.id;
    // a workspace made just now comes with one shell tab: the session goes there and the tab takes its name
    if (made.tab) await H.tabRename(made.tab, label);
    const s = await this.spawn(be, { workspace: ws, cwd: resume ? old!.cwd : this.cfg.workdir, label, thread,
      pane: reuse ?? made.pane, session: resume ? old!.session : undefined });
    if (!s && made.pane) await H.paneClose(made.pane); // its only pane: the empty workspace goes with it
    if (!s) { await this.tg.notice(thread, tr(`❌ 开会话失败：${esc(be.name)} 没有在 Herdr 里起来`, `❌ Could not open a session: ${esc(be.name)} did not start in Herdr`)); return false; }
    const kind = be.kind;
    this.unwatch(thread);
    this.store.state.topics[thread] = {
      ...(old ?? { cwd: this.cfg.workdir, name: opts.name, autoName: opts.autoName ?? false }),
      kind, backend: be.name,
      pane: s.pane, tab: s.tab, terminal: s.terminal,
      session: s.session ?? (resume ? old!.session : undefined),
      cwd: resume ? old!.cwd : this.cfg.workdir,
      closedAt: undefined, notified: undefined, attached: undefined, lastActive: Date.now(),
    };
    this.store.save();
    this.watch(thread);
    log("open", thread, { resume, pane: s.pane, reusedPane: st?.state === "exited" });
    await this.tg.notice(thread, `${resume ? tr("🔄 已接回原会话", "🔄 Resumed the session") : tr("🟢 新会话已就绪", "🟢 New session ready")} · ${esc(be.name)} · ${await this.where(ws, label)}`);
    return true;
  }

  private async spawn(be: Backend, o: { workspace?: string; cwd: string; label: string; thread: number; pane?: string; session?: string }) {
    const extra = be.kind === "codex" ? this.cfg.codexArgs : this.cfg.claudeArgs;
    return H.spawnAgent({
      kind: be.kind, cmd: be.cmd, workspace: o.workspace, cwd: o.cwd, label: o.label, agent: `tg-${o.thread}`, pane: o.pane,
      args: launchArgs(be.kind, o.session, extra, SPAWN_PROMPT(be.kind, this.tgSendPath),
        be.kind === "codex" ? await codexInstructions(extra, o.cwd) : undefined),
    });
  }

  // /switch: carry on with the same session on another backend of the same kind (claude <-> gw). A running session
  // is ended with /exit and started again in the same pane, so the tab stays where it is, desktop sessions included.
  async switchTo(thread: number, name: string): Promise<void> {
    const b = this.store.state.topics[thread];
    const to = this.backend(name);
    if (!b) { await this.tg.notice(thread, tr("这个话题还没有会话。发条消息就会用默认后端开一个", "This topic has no session yet; write here to start one on the default backend")); return; }
    if (!to) { await this.tg.notice(thread, tr(`没有叫 ${esc(name)} 的后端。可用：${this.names()}`, `No backend named ${esc(name)}. Available: ${this.names()}`)); return; }
    const from = this.backendOf(b);
    if (from.name === to.name) { await this.tg.notice(thread, tr(`已经是 ${esc(to.name)}`, `Already on ${esc(to.name)}`)); return; }
    if (from.kind !== to.kind) {
      await this.tg.notice(thread, tr(`${esc(from.name)} 和 ${esc(to.name)} 的会话记录格式不同，没法接着同一个会话。要用 ${esc(to.name)} 就发 <code>/new ${esc(to.name)} 名字</code> 另开`,
        `${esc(from.name)} and ${esc(to.name)} keep sessions in different formats, so one cannot continue the other's. Send <code>/new ${esc(to.name)} name</code> for a new one`));
      return;
    }
    const st = b.closedAt ? undefined : await H.paneState(b.pane, b.terminal);
    if (st?.state === "unknown") { await this.tg.notice(thread, tr("⚠️ Herdr 连不上，没法切换", "⚠️ Cannot reach Herdr, so nothing was switched")); return; }
    if (st?.state === "live" && st.agent!.agent_status !== "idle" && st.agent!.agent_status !== "done") {
      await this.tg.notice(thread, tr("会话正在回复或在等你选择，等这一轮结束或先发 /stop 再切", "The session is busy or waiting for you; switch once this turn ends, or send /stop first"));
      return;
    }
    const resumable = this.canResume(b);
    if (st?.state !== "live") {
      // nothing running here: resume on the new backend now, or start with it on the next message
      b.backend = to.name;
      this.store.save();
      log("switch", thread, { from: from.name, to: to.name, running: false });
      if (resumable) { await this.open(thread); return; }
      await this.tg.notice(thread, tr(`🔀 已改为 ${esc(to.name)}，下一条消息会用它开新会话`, `🔀 Now on ${esc(to.name)}; the next message starts a session with it`));
      return;
    }
    this.unwatch(thread);
    await H.prompt(b.pane, "/exit");
    let left = false;
    for (let i = 0; i < 40 && !left; i++) { await Bun.sleep(500); left = (await H.paneState(b.pane, b.terminal)).state === "exited"; }
    if (!left) {
      this.watch(thread);
      await this.tg.notice(thread, tr(`❌ 会话没有退出，还在用 ${esc(from.name)}。用 /screen 看看屏幕`, `❌ The session did not exit and stays on ${esc(from.name)}. /screen shows its screen`));
      return;
    }
    const s = await this.spawn(to, { cwd: b.cwd, label: this.name(thread, b), thread, pane: b.pane, session: resumable ? b.session : undefined });
    if (!s) {
      // the pane is left with a shell; the binding keeps the old backend, so the next message brings it back
      this.watch(thread);
      await this.tg.notice(thread, tr(`❌ ${esc(to.name)} 没有起来，原会话已退出。再发消息会用 ${esc(from.name)} 接回`, `❌ ${esc(to.name)} did not start and the session has exited. The next message resumes it on ${esc(from.name)}`));
      return;
    }
    Object.assign(b, { backend: to.name, pane: s.pane, tab: s.tab ?? b.tab, terminal: s.terminal, session: s.session ?? b.session, notified: undefined, lastActive: Date.now() });
    this.store.save();
    this.watch(thread);
    log("switch", thread, { from: from.name, to: to.name, pane: s.pane });
    await this.tg.notice(thread, resumable ? tr(`🔀 已切到 ${esc(to.name)}，接着原会话`, `🔀 Switched to ${esc(to.name)}, same session`)
      : tr(`🔀 已切到 ${esc(to.name)}。原会话还没有记录可接，开的是新会话`, `🔀 Switched to ${esc(to.name)}. The old session had no transcript yet, so this is a new one`));
  }

  names() { return this.cfg.backends.map(b => b.name).join(", "); }

  // /switch with no argument: the backends this topic can move to
  switchView(thread: number): { html: string; keyboard: any[][] } {
    const b = this.store.state.topics[thread];
    const from = this.backendOf(b);
    const to = this.cfg.backends.filter(x => x.kind === from.kind && x.name !== from.name);
    return {
      html: to.length ? tr(`本话题用的是 <b>${esc(from.name)}</b>，换成：`, `This topic runs on <b>${esc(from.name)}</b>. Switch to:`)
        : tr(`本话题用的是 <b>${esc(from.name)}</b>，没有同类后端可以换`, `This topic runs on <b>${esc(from.name)}</b>; no other backend of its kind is configured`),
      keyboard: to.length ? [to.map(x => ({ text: x.name, callback_data: `sw:${x.name}:${thread}` }))] : [],
    };
  }

  // /tg-bind from inside a desktop session: new topic, handoff card, last answer, then live sync.
  // `session` is the caller's own session id when it knows it (Codex), so a wrong HERDR_PANE_ID cannot bind a neighbour.
  // One at a time: two calls for the same session (a retry, a double press) must not open two topics.
  attach(pane: string, session?: string, baseUrl?: string): Promise<{ ok: boolean; thread?: number; error?: string; already?: boolean }> {
    const run = this.attaching.then(() => this.attachOne(pane, session, baseUrl));
    this.attaching = run.catch(() => {});
    return run;
  }
  private attaching: Promise<unknown> = Promise.resolve();

  private async attachOne(pane: string, session?: string, baseUrl?: string): Promise<{ ok: boolean; thread?: number; error?: string; already?: boolean }> {
    if (session) {
      const bound = this.store.topicOfSession(session);
      if (bound) return { ok: true, thread: bound, already: true };
    }
    const shared = session ? await this.paneOfShared(session) : undefined;
    if (shared && "error" in shared) return { ok: false, error: shared.error };
    if (shared) pane = shared.pane;
    const st = await H.paneState(pane);
    // a binding counts only for the terminal it was made in: Herdr reuses pane ids
    const mine = (b: Binding) => b.pane === pane && b.terminal === st.terminal;
    const open = Object.entries(this.store.state.topics).find(([, b]) => mine(b) && !b.closedAt);
    if (open && session) return { ok: false, error: "this pane is bound to another session; not bound" };
    if (open && st.state === "live") return { ok: true, thread: Number(open[0]), already: true };
    // bound before and then closed in Telegram: reopen that topic rather than open a second one for the same session.
    // For a Codex caller the pane must be running that session: by its title when shared, else as Herdr reports it.
    const running = !session || shared || st.agent?.agent_session?.value === session;
    const closed = Object.entries(this.store.state.topics).find(([, b]) => mine(b) && b.closedAt && (!session || (b.session === session && running)));
    if (closed && st.state === "live") {
      const ok = await this.open(Number(closed[0]));
      return ok ? { ok, thread: Number(closed[0]) } : { ok, error: "could not reopen the earlier topic" };
    }
    if (st.state === "unknown") return { ok: false, error: "Herdr is not answering" };
    if (st.state !== "live") return { ok: false, error: "no Claude or Codex session is running in this pane" };
    const a = st.agent!;
    const kind = a.agent === undefined ? "claude" : agentKind(a.agent); // a Herdr that does not report the kind ran Claude only
    if (!kind) return { ok: false, error: `${a.agent} sessions are not supported; only Claude and Codex` };
    const sid = shared ? session : a.agent_session?.value; // Herdr credits a shared session to another pane
    if (!sid) return { ok: false, error: `Herdr has no session id for this pane: the session was started before \`herdr integration install ${kind}\`, so its transcript cannot be found` };
    if (session && session !== sid) return { ok: false, error: "this pane runs another session; not bound" };
    const path = findTranscript(a.cwd, sid, kind);
    const ex = existsSync(path) ? lastExchange(readFileSync(path, "utf8"), kind) : {};
    const tabTitle = H.usefulLabel(await H.tabLabel(a.workspace_id, a.tab_id));
    const backend = detectBackend(this.cfg.backends, kind, baseUrl);
    const title = cut(tabTitle || ex.title || cleanTitle(a.terminal_title_stripped) || tr("电脑会话", "Desktop session"), 120);
    const j = await this.tg.call("createForumTopic", { chat_id: this.cfg.chatId, name: title, icon_color: this.backend(backend)!.color });
    if (!j.ok) return { ok: false, error: `createForumTopic failed: ${j.description}` };
    const thread: number = j.result.message_thread_id;
    this.store.state.topics[thread] = {
      pane, kind, backend, tab: a.tab_id, terminal: a.terminal_id, session: sid, cwd: a.cwd,
      name: title, title, autoName: true, attached: true, lastActive: Date.now(),
    };
    this.store.save();
    const ctx = parseCtx(a.tokens?.context);
    const card = [
      `🔗 <b>${tr("已从电脑接过来", "Taken over from the computer")}</b> · ${esc(backend)} · ${await this.where(a.workspace_id, tabTitle || cleanTitle(a.terminal_title_stripped))}`,
      `${tr("目录", "Folder")} <code>${esc(a.cwd.replace(homedir(), "~"))}</code>${ctx ? ` · ctx ${esc(ctx.text)}` : ""}`,
      ex.ask ? tr(`上一轮你问的是「${esc(cut(ex.ask.replace(/\s+/g, " "), 300))}」，回答在下面`, `Last time you asked "${esc(cut(ex.ask.replace(/\s+/g, " "), 300))}"; the answer is below`) : "",
      tr("在这里发消息，就是在电脑上那个会话里发。关闭或删除这个话题只断开 Telegram，电脑上的会话继续开着", "Messages here go to that session on the computer. Closing or deleting this topic only disconnects Telegram; the session keeps running"),
    ].filter(Boolean).join("\n");
    await this.tg.notice(thread, card);
    if (ex.answer) for (const c of mdChunks(ex.answer)) await this.tg.send(thread, c);
    this.watch(thread);
    log("attach", thread, { pane, kind, backend, session: sid });
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
    await this.tg.notice(thread, !b ? tr("🔒 话题已关闭", "🔒 Topic closed")
      : b.attached ? tr("🔒 已断开，电脑上的会话继续开着。重新打开话题，或者在这里发消息，会重新连上", "🔒 Disconnected; the session keeps running on the computer. Reopen the topic or write here to reconnect")
      : tr("🔒 会话已结束，话题已关闭。重新打开话题，或者在这里发消息，会接着原会话", "🔒 Session ended and topic closed. Reopen the topic or write here to resume it"));
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
    if (b.tab && !b.closedAt) await H.tabRename(b.tab, name); // desktop topics follow their tab label, so it changes with them
  }

  // Codex's shared app-server gives its sessions the first pane's HERDR_PANE_ID, and Herdr credits them to that pane,
  // so such a session is placed by its name, which Codex shows in its own pane's title. Undefined: not shared.
  private async paneOfShared(session: string): Promise<{ pane: string } | { error: string } | undefined> {
    const path = findTranscript("", session, "codex");
    const meta = path ? codexSessionMeta(path) : undefined;
    if (!meta?.shared) return;
    const name = codexSessionName(session);
    if (!name) return { error: "Codex has not named this session yet; send it a message, then bind again" };
    const hits = panesShowing(await H.agentList(), meta.cwd!, name);
    if (hits.length === 1) return { pane: hits[0] };
    return { error: hits.length ? `several Herdr panes show "${name}"; give this session a unique name with /rename, then bind again` : `no Herdr pane shows "${name}" in its title` };
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
      const bits = [STATE_LABEL()[state] ?? state, `<a href="${this.link(thread)}">${esc(cut(name, 40))}</a>`, esc(backendName(b)), b.attached ? tr("电脑会话", "desktop") : "", ctx ? `ctx ${esc(ctx.text)}` : "", when];
      lines.push(bits.filter(Boolean).join(" · "));
      const short = cut(name, 12);
      const del = { text: tr(`删除 ${short}`, `Delete ${short}`), callback_data: `lc:delask:${thread}` };
      if (state === "closed") keyboard.push([{ text: tr(`重开 ${short}`, `Reopen ${short}`), callback_data: `lc:resume:${thread}:l` }, del]);
      else if (state === "exited" || state === "gone") keyboard.push([{ text: tr(`接回 ${short}`, `Resume ${short}`), callback_data: `lc:resume:${thread}:l` }, del]);
      else if (state !== "unknown") keyboard.push([{ text: tr(`关闭 ${short}`, `Close ${short}`), callback_data: `lc:close:${thread}:l` }, del]);
    }
    const out = [tr(`<b>会话 ${rows.length} 个</b>`, `<b>${rows.length} session${rows.length === 1 ? "" : "s"}</b>`), ...lines];
    if (!rows.length) out.push(tr("还没有会话。发 /new 名字 新建一个，或者在电脑上的会话里用 /tg-bind", "No sessions yet. Send /new name to start one, or use /tg-bind in a session on the computer"));
    if (removed.length) out.push(tr(`<i>话题已被删除，已移除 ${removed.length} 个绑定</i>`, `<i>Topics were deleted; removed ${removed.length} binding${removed.length === 1 ? "" : "s"}</i>`));
    if (limits) out.push(`<i>${tr("额度", "Limits")} ${esc(limits)}</i>`);
    return { html: out.join("\n"), keyboard };
  }

  // confirmation for deleting, shared by /delete and the list buttons
  deletePrompt(thread: number) {
    const b = this.store.state.topics[thread];
    const what = b?.attached ? tr("电脑上的会话继续开着，", "The session keeps running on the computer; ") : tr("会话会结束，", "The session ends; ");
    return {
      html: tr(`确定删除「${esc(cut(this.name(thread, b), 40))}」吗？${what}话题和全部聊天记录一起删除，没法恢复`, `Delete "${esc(cut(this.name(thread, b), 40))}"? ${what}the topic and all its messages are deleted for good`),
      keyboard: [[{ text: tr("确认删除", "Delete"), callback_data: `lc:delete:${thread}` }, { text: tr("取消", "Cancel"), callback_data: `lc:cancel:${thread}` }]],
    };
  }
}
