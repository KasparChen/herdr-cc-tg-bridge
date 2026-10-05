// tg-bridge spike: Telegram forum topic <-> Herdr Claude pane.
// Feasibility prototype kept for reference; superseded by src/. Run: TELEGRAM_BOT_TOKEN=... TG_CHAT_ID=... TG_ALLOW=... bun spike/bridge.ts
import { existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = Number(process.env.TG_CHAT_ID);
const ALLOW = new Set((process.env.TG_ALLOW ?? "").split(",").map(Number));
const CWD = process.env.TG_CWD ?? homedir();
const STATE_FILE = join(import.meta.dir, "state.json");
const API = `https://api.telegram.org/bot${TOKEN}`;

type Bind = { pane: string; session?: string };
type State = { offset: number; topics: Record<string, Bind> };
const state: State = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { offset: 0, topics: {} };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- telegram ----------
async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${API}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) log("tg", method, j.description);
  return j;
}
async function send(thread: number | undefined, html: string, extra: Record<string, unknown> = {}) {
  const base = { chat_id: CHAT_ID, message_thread_id: thread, ...extra };
  let j = await tg("sendMessage", { ...base, text: html, parse_mode: "HTML" });
  if (!j.ok) j = await tg("sendMessage", { ...base, text: stripTags(html) });
  log("send", thread, j.ok, j.result?.message_id, JSON.stringify(stripTags(html).slice(0, 160)));
  return j.result?.message_id as number | undefined;
}
async function edit(id: number, html: string) {
  const j = await tg("editMessageText", { chat_id: CHAT_ID, message_id: id, text: html, parse_mode: "HTML" });
  log("edit", id, j.ok || j.description, JSON.stringify(stripTags(html).slice(0, 80)));
  if (!j.ok && !/not modified/.test(j.description)) await tg("editMessageText", { chat_id: CHAT_ID, message_id: id, text: stripTags(html) });
}

// ---------- formatting ----------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
function md2html(md: string): string {
  const parts = tables2bullets(md).split(/```[a-zA-Z0-9_-]*\n?/);
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return `<pre>${esc(p.replace(/\n$/, ""))}</pre>`;
      return esc(p)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/^#{1,6} (.+)$/gm, "<b>$1</b>");
    })
    .join("");
}
function chunks(html: string, n = 3800): string[] {
  if (html.length <= n) return [html];
  const out: string[] = [];
  let rest = stripTags(html);
  while (rest.length) { out.push(esc(rest.slice(0, n))); rest = rest.slice(n); }
  return out;
}
// tool line = "{emoji} {verb} {preview}", mapped from Hermes tg-fold verbs onto Claude Code tool names
const TOOLS: Record<string, [string, string]> = {
  Bash: ["💻", "Running"], Read: ["📖", "Reading"], Write: ["✍️", "Writing"], Edit: ["🔧", "Editing"], MultiEdit: ["🔧", "Editing"],
  NotebookEdit: ["🔧", "Editing"], Grep: ["🔎", "Searching files for"], Glob: ["🔎", "Finding files"], WebSearch: ["🔍", "Searching the web for"],
  WebFetch: ["📄", "Reading"], Agent: ["🔀", "Delegating"], Task: ["🔀", "Delegating"], TodoWrite: ["📋", "Updating tasks"],
  Skill: ["📚", "Reading skill"], AskUserQuestion: ["❓", "Asking"], ToolSearch: ["🧰", "Loading tools"],
};
function toolLine(name: string, input: any): string {
  const [emoji, verb] = TOOLS[name] ?? ["⚙️", name.replace(/^mcp__[^_]+__/, "")];
  let p = name === "Bash" ? String(input?.command ?? "").split("\n")[0]
    : input?.file_path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.skill ?? input?.description ?? input?.questions?.[0]?.question ?? "";
  p = String(p).replace(/\s+/g, " ").replace(homedir(), "~");
  return cut(p ? `${emoji} ${verb} ${p}` : `${emoji} ${verb}`, 300);
}
const fmtSecs = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`);
// GFM table -> grouped bullets (TG has no tables)
function tables2bullets(md: string): string {
  return md.replace(/((?:^\|.*\|[ \t]*\n?)+)/gm, block => {
    const rows = block.trim().split("\n").map(r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
    if (rows.length < 2 || !rows[1].every(c => /^:?-{2,}:?$/.test(c))) return block;
    const [head, , ...body] = rows;
    return body.map(r => `• ${r[0]}\n` + r.slice(1).map((c, i) => `  ${head[i + 1]}：${c}`).join("\n")).join("\n") + "\n";
  });
}

// ---------- herdr ----------
async function herdr(...args: string[]): Promise<any> {
  const p = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  try { return JSON.parse(out); } catch { return out; }
}
async function agentInfo(pane: string) { return (await herdr("agent", "get", pane))?.result?.agent; }
async function spawnSession(label: string): Promise<Bind | undefined> {
  const tab = await herdr("tab", "create", "--cwd", CWD, "--label", label);
  const pane = tab?.result?.root_pane?.pane_id;
  if (!pane) return;
  const st = await herdr("agent", "start", label, "--kind", "claude", "--pane", pane);
  return { pane, session: st?.result?.agent?.agent_session?.value };
}
const transcriptPath = (session: string) => join(homedir(), ".claude/projects", CWD.replace(/[/.]/g, "-"), `${session}.jsonl`);

// ---------- per-topic watcher ----------
type Turn = { bubble?: number; lines: string[]; texts: string[]; calls: number; t0: number; lastEdit: number; dirty: boolean; asked: Set<string> };
class Watcher {
  pos = 0; session?: string; turn?: Turn; status = "unknown"; timer?: Timer; busy = false; fromTg = new Set<string>();
  constructor(public thread: number, public bind: Bind) {
    this.session = bind.session;
    if (this.session && existsSync(transcriptPath(this.session))) this.pos = statSync(transcriptPath(this.session)).size;
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try { await this.tick(); } catch (e) { log("tick", e); } finally { this.busy = false; }
    }, 1000);
  }
  newTurn(): Turn { return { lines: [], texts: [], calls: 0, t0: Date.now(), lastEdit: 0, dirty: true, asked: new Set() }; }
  async tick() {
    const a = await agentInfo(this.bind.pane);
    if (!a) return;
    const sid = a.agent_session?.value;
    if (sid && sid !== this.session) { // /clear or restart -> new transcript
      this.session = sid; this.bind.session = sid; this.pos = 0; save();
    }
    this.readTranscript();
    const prev = this.status; this.status = a.agent_status;
    if (this.status === "working" && !this.turn) this.turn = this.newTurn();
    if (this.turn) await this.render(false);
    if (this.status === "blocked" && prev !== "blocked") await this.onBlocked();
    if ((this.status === "idle" || this.status === "done") && this.turn && (prev === "working" || prev === "blocked" || Date.now() - this.turn.t0 > 4000)) await this.finish();
  }
  readTranscript() {
    if (!this.session) return;
    const f = transcriptPath(this.session);
    if (!existsSync(f)) return;
    const size = statSync(f).size;
    if (size <= this.pos) return;
    const fd = openSync(f, "r"); const buf = Buffer.alloc(size - this.pos); readSync(fd, buf, 0, buf.length, this.pos); closeSync(fd);
    const text = buf.toString("utf8"); const last = text.lastIndexOf("\n");
    if (last < 0) return;
    this.pos += Buffer.byteLength(text.slice(0, last + 1));
    for (const line of text.slice(0, last + 1).split("\n")) {
      if (!line.trim()) continue;
      let d: any; try { d = JSON.parse(line); } catch { continue; }
      if (d.isSidechain) continue;
      if (d.type === "user" && typeof d.message?.content === "string" && !d.isMeta) {
        this.turn ??= this.newTurn();
        const tgSent = this.fromTg.delete(d.message.content.trim());
        if (!tgSent && !d.message.content.startsWith("<")) this.turn.lines.push(`🗣 ${cut(d.message.content.replace(/\s+/g, " "), 60)}`);
      }
      if (d.type !== "assistant") continue;
      this.turn ??= this.newTurn();
      for (const b of d.message?.content ?? []) {
        if (b.type === "tool_use") {
          if (this.turn.texts.length) { this.turn.lines.push(...this.turn.texts.map(t => `💬 ${cut(t.replace(/[*`#_]/g, "").replace(/\s+/g, " "), 500)}`)); this.turn.texts = []; }
          this.turn.calls++; this.turn.lines.push(toolLine(b.name, b.input)); this.turn.dirty = true;
          if (b.name === "AskUserQuestion") (this as any).lastAsk = b;
        } else if (b.type === "text" && b.text.trim()) { this.turn.texts.push(b.text); this.turn.dirty = true; }
      }
    }
  }
  bubbleHtml(done: boolean): string {
    const t = this.turn!;
    const head = `<b>${done ? "✅ 完成" : "⚙️ 执行中"}</b>\n<i>🔧 ${t.calls} 次调用 · ${fmtSecs(Math.floor((Date.now() - t.t0) / 1000))}</i>`;
    let lines = t.lines.map(l => (/^[💬🗣]/u.test(l) ? `<b>${esc(l)}</b>` : esc(l)));
    while (lines.join("\n").length > 3600) lines = lines.slice(1);
    return `<blockquote expandable>${head}${lines.length ? "\n...\n" + lines.join("\n") : ""}</blockquote>`;
  }
  async render(done: boolean) {
    const t = this.turn!;
    if (!t.lines.length && !done) return;
    if (!done && (!t.dirty || Date.now() - t.lastEdit < 1500)) return;
    t.dirty = false; t.lastEdit = Date.now();
    if (!t.bubble) { if (t.lines.length) t.bubble = await send(this.thread, this.bubbleHtml(done)); }
    else await edit(t.bubble, this.bubbleHtml(done));
  }
  async finish() {
    this.readTranscript();
    const t = this.turn!;
    await this.render(true);
    this.turn = undefined;
    const final = t.texts.join("\n\n").trim();
    if (final) for (const c of chunks(md2html(final))) await send(this.thread, c);
  }
  async onBlocked() {
    this.readTranscript();
    const ask = (this as any).lastAsk;
    if (ask && !this.turn?.asked.has(ask.id)) {
      this.turn?.asked.add(ask.id);
      const q = ask.input.questions?.[0];
      if (q) {
        const kb = q.options.map((o: any, i: number) => [{ text: o.label, callback_data: `aq:${this.thread}:${i}` }]);
        await send(this.thread, `❓ <b>${esc(q.question)}</b>`, { reply_markup: { inline_keyboard: kb } });
        return;
      }
    }
    const screen = String(await herdr("pane", "read", this.bind.pane)).split("\n").filter(l => l.trim()).slice(-15).join("\n");
    await send(this.thread, `⏸ 会话在等待输入（用 /keys down enter 之类回应）\n<pre>${esc(cut(screen, 3000))}</pre>`);
  }
}
const watchers = new Map<number, Watcher>();
function watch(thread: number) {
  const b = state.topics[thread];
  if (b && !watchers.has(thread)) watchers.set(thread, new Watcher(thread, b));
}

// ---------- commands ----------
async function bindNew(thread: number, label: string) {
  const b = await spawnSession(label);
  if (!b) { await send(thread, "❌ 创建会话失败"); return; }
  state.topics[thread] = b; save(); watch(thread);
  await send(thread, `🟢 新会话已就绪\npane <code>${b.pane}</code> · session <code>${b.session?.slice(0, 8) ?? "?"}</code>`);
}
async function onMessage(m: any) {
  if (m.chat?.id !== CHAT_ID || !ALLOW.has(m.from?.id)) return;
  const thread: number | undefined = m.is_topic_message ? m.message_thread_id : undefined;
  if (m.forum_topic_created) {
    if (m.from?.is_bot) return;
    await bindNew(m.message_thread_id, `tg-${m.message_thread_id}`); return;
  }
  const text: string = m.text ?? m.caption ?? "";
  if (!text) return;
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const c = cmd.replace(/@\w+$/, "");
  if (c === "/new") {
    const name = rest.join(" ") || `会话 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
    const j = await tg("createForumTopic", { chat_id: CHAT_ID, name });
    if (!j.ok) { await send(thread, `❌ 建话题失败：${esc(j.description)}`); return; }
    await bindNew(j.result.message_thread_id, `tg-${j.result.message_thread_id}`); return;
  }
  if (!thread || !state.topics[thread]) {
    await send(thread, "在任意话题外发 /new [名字] 新建会话；或者直接新建一个话题，我会自动绑定新会话。"); return;
  }
  const b = state.topics[thread];
  if (c === "/keys") { await herdr("pane", "send-keys", b.pane, ...rest); return; }
  if (c === "/screen") {
    const s = String(await herdr("pane", "read", b.pane)).split("\n").filter(l => l.trim()).slice(-30).join("\n");
    await send(thread, `<pre>${esc(cut(s, 3800))}</pre>`); return;
  }
  // everything else (including /clear and other claude slash commands) goes into the pane
  watchers.get(thread)?.fromTg.add(text.trim());
  await herdr("agent", "prompt", b.pane, text);
}
async function onCallback(q: any) {
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  if (!ALLOW.has(q.from?.id)) return;
  const [kind, thread, idx] = String(q.data).split(":");
  const b = state.topics[thread];
  if (kind !== "aq" || !b) return;
  await herdr("pane", "send-keys", b.pane, ...Array(Number(idx)).fill("down"), "enter");
  await tg("editMessageReplyMarkup", { chat_id: CHAT_ID, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
}

// ---------- local test hook: POST 127.0.0.1:18820/sim {"text":"...","thread":123} acts as an allowed user ----------
Bun.serve({
  hostname: "127.0.0.1", port: 18820,
  async fetch(req) {
    const b: any = await req.json().catch(() => ({}));
    const fake = { chat: { id: CHAT_ID }, from: { id: [...ALLOW][0] }, text: b.text, is_topic_message: !!b.thread, message_thread_id: b.thread };
    onMessage(fake).catch(e => log("sim", e));
    return new Response("ok");
  },
});

// ---------- main loop ----------
for (const t of Object.keys(state.topics)) watch(Number(t));
log("bridge up", { chat: CHAT_ID, topics: Object.keys(state.topics).length });
while (true) {
  try {
    const j = await tg("getUpdates", { offset: state.offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
    for (const u of j.result ?? []) {
      state.offset = u.update_id + 1; save();
      if (u.message) await onMessage(u.message).catch(e => log("msg", e));
      if (u.callback_query) await onCallback(u.callback_query).catch(e => log("cb", e));
    }
  } catch (e) { log("poll", e); await Bun.sleep(3000); }
}
