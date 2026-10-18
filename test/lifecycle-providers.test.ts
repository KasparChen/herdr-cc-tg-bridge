import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Store } from "../src/store";
import { loadConfig } from "../src/config";

let state: any, started: any[], closed: string[], label: string | undefined;
let renamedTabs: string[] = [], keyboards: any[] = [], agents: any[] = [], failSpawn = false;
mock.module("../src/herdr", () => ({
  paneState: async () => state,
  spawnAgent: async (opts: any) => { started.push(opts); return failSpawn ? undefined : { pane: "new-pane", tab: "new-tab", terminal: "new-terminal", session: "test-session" }; },
  resolveWorkspace: async () => "workspace",
  workspaces: async () => [{ workspace_id: "workspace", label: "Telegram" }],
  paneClose: async (pane: string) => { closed.push(pane); },
  tabRename: async (_: string, name: string) => { renamedTabs.push(name); return {}; },
  tabLabel: async () => label,
  paneRead: async () => "Question 1/2",
  agentList: async () => agents,
}));
const { Lifecycle } = await import("../src/lifecycle");
const { Watcher } = await import("../src/session");
const { startControl } = await import("../src/control");
const { lastExchange } = await import("../src/lifecycle");
let dir: string, path: string, cfg: ReturnType<typeof loadConfig>, store: Store, life: InstanceType<typeof Lifecycle>;
let watchers: Map<number, any>, notices: string[], sends: string[], calls: any[], tg: any;
let oldHome: string | undefined, oldPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tgb-life-")); oldHome = process.env.CODEX_HOME; process.env.CODEX_HOME = join(dir, "codex");
  // a stand-in for `codex debug prompt-input`: no developer_instructions configured
  mkdirSync(join(dir, "bin")); writeFileSync(join(dir, "bin/codex"), `#!/bin/sh
case "$*" in *tg-bridge-marker*) echo '[{"type":"message","role":"developer","content":[{"text":"tg-bridge-marker-5c1e"},{"text":"<permissions>"}]}]' ;;
*) echo '[{"type":"message","role":"developer","content":[{"text":"<permissions>"}]}]' ;; esac
`, { mode: 0o755 }); oldPath = process.env.PATH; process.env.PATH = `${join(dir, "bin")}:${oldPath}`;
  mkdirSync(join(process.env.CODEX_HOME, "sessions/2026/10/16"), { recursive: true });
  path = join(process.env.CODEX_HOME, "sessions/2026/10/16/rollout-now-test-session.jsonl"); writeFileSync(path, "");
  cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "fake", TG_CHAT_ID: "-1", TG_ALLOWED_USERS: "1", TG_BRIDGE_WORKDIR: dir, TG_BRIDGE_STATE_DIR: join(dir, "state") });
  store = new Store(cfg.stateDir); watchers = new Map(); notices = []; sends = []; calls = []; started = []; closed = [];
  state = { state: "gone" };
  label = undefined; renamedTabs = []; keyboards = []; agents = []; failSpawn = false;
  tg = {
    chatId: -1,
    call: async (name: string, body: any) => { calls.push({ name, body }); return { ok: true, result: { message_thread_id: 41 } }; },
    notice: async (_: any, text: string) => { notices.push(text); },
    send: async (_: any, text: string, extra?: any) => { sends.push(text); if (extra?.reply_markup) keyboards.push(extra.reply_markup.inline_keyboard); return 1; },
    sendState: async (_: any, text: string) => { sends.push(text); return { state: "ok", id: 1 }; },
    edit: async () => true, react: async () => {}, topicAlive: async () => true,
  };
  life = new Lifecycle(cfg, tg, store, watchers, "/bridge/tg-send");
});
afterEach(() => {
  for (const w of watchers.values()) w.stop();
  if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  process.env.PATH = oldPath;
  rmSync(dir, { recursive: true });
});
// a rollout as Codex writes it; source "vscode" = the shared app-server, "cli" = its own process
const rollout = (id: string, cwd: string, source = "cli", name?: string) => {
  writeFileSync(join(process.env.CODEX_HOME!, `sessions/2026/10/16/rollout-now-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd, source } }) + "\n");
  if (name) appendFileSync(join(process.env.CODEX_HOME!, "session_index.jsonl"), JSON.stringify({ id, thread_name: name }) + "\n");
};
const pane = (pane_id: string, title: string) => ({ pane_id, agent: "codex", cwd: dir, terminal_title_stripped: title });
// the tab-name sync runs beside the tick; wait for it too
const tickNamed = async (w: any) => { await w.tick(); await w.naming; };
const live = () => ({ state: "live", terminal: "terminal", agent: { agent: "codex", agent_status: "working", agent_session: { value: "test-session" }, cwd: dir, workspace_id: "workspace", tab_id: "tab", terminal_id: "terminal" } });

describe("mixed provider lifecycle (offline)", () => {
  test("new Codex topic persists provider, restart retains it, missing pane resumes Codex", async () => {
    expect(await life.open(41, { fresh: true, kind: "codex", name: "测试" })).toBe(true);
    expect(started[0].kind).toBe("codex"); expect(started[0].args[0]).toBe("-c");
    expect(started[0].args[1]).toContain("tg-send"); expect(started[0].args[1]).not.toContain("Write tool");
    const reloaded = new Store(cfg.stateDir); expect(reloaded.state.topics[41].kind).toBe("codex");
    await life.open(41);
    expect(started[1].kind).toBe("codex"); expect(started[1].args.slice(0, 3)).toEqual(["resume", "test-session", "-c"]);
  });
  test("/new codex that fails to start removes its empty topic, so no retry there can start the default agent", async () => {
    const { Router } = await import("../src/router");
    const router = new Router(cfg, tg, store, watchers, {} as any, life);
    failSpawn = true;
    await router.onMessage({ chat: { id: -1 }, from: { id: 1 }, text: "/new codex 例子" });
    expect(started.map(s => s.kind)).toEqual(["codex"]);
    expect(calls.map(c => c.name)).toEqual(["createForumTopic", "deleteForumTopic"]);
    expect(store.state.topics[41]).toBeUndefined(); expect(notices.at(-1)).toContain("/new");
    failSpawn = false;
    await router.onMessage({ chat: { id: -1 }, from: { id: 1 }, text: "/new codex 例子" });
    expect(store.state.topics[41].kind).toBe("codex"); expect(calls.filter(c => c.name === "deleteForumTopic")).toHaveLength(1);
  });
  test("old bindings without kind still reopen as Claude even when default changes", async () => {
    cfg.agentKind = "codex";
    store.state.topics[41] = { pane: "old", cwd: dir };
    await life.open(41);
    expect(started[0].kind).toBe("claude");
    expect(started[0].args).toContain("--append-system-prompt");
  });
  test("attaches Codex with a handoff, and closing leaves the desktop pane running", async () => {
    state = live();
    writeFileSync(path, [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "问题" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "完整回答" }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "完整回答" } }),
    ].join("\n") + "\n");
    expect(await life.attach("pane", "test-session")).toEqual({ ok: true, thread: 41 });
    expect(store.state.topics[41].kind).toBe("codex"); expect(sends).toEqual(["完整回答"]);
    await life.close(41, false);
    expect(closed).toEqual([]); expect(store.state.topics[41].closedAt).toBeGreaterThan(0);
    expect(await life.attach("pane", "test-session")).toEqual({ ok: true, thread: 41 });
    expect(calls.filter(c => c.name === "createForumTopic")).toHaveLength(1);
  });
  test("wrong session or unsupported agent fails before any Telegram mutation", async () => {
    state = live();
    expect((await life.attach("pane", "someone-else")).ok).toBe(false);
    state.agent.agent = "gemini";
    expect((await life.attach("pane")).ok).toBe(false);
    expect(calls).toEqual([]); expect(Object.keys(store.state.topics)).toHaveLength(0);
  });
  test("a session without a transcript yet binds as before, and its first turn is relayed once written", async () => {
    state = live(); state.agent.agent_status = "idle"; rmSync(path);
    expect(await life.attach("pane", "test-session")).toEqual({ ok: true, thread: 41 });
    expect(sends).toEqual([]);
    writeFileSync(path, [
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "第一轮回答" }] } },
      { type: "event_msg", payload: { type: "task_complete", last_agent_message: "第一轮回答" } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    state.agent.agent_status = "working"; await watchers.get(41).tick();
    expect(sends).toEqual(["第一轮回答"]);
  });
  test("tg-bind twice at once opens one topic; a binding counts only for its own terminal and session", async () => {
    state = live();
    const [a, b] = await Promise.all([life.attach("pane", "test-session"), life.attach("pane", "test-session")]);
    expect(a).toEqual({ ok: true, thread: 41 }); expect(b).toEqual({ ok: true, thread: 41, already: true });
    expect(calls.filter(c => c.name === "createForumTopic")).toHaveLength(1);
    // Herdr gave the pane id to a new terminal: the old binding is not this session's
    store.state.topics[41].terminal = "old-terminal"; state.agent.agent = "claude"; delete state.agent.agent_session;
    expect((await life.attach("pane")).already).toBeUndefined();
    // a closed binding of another session in this pane is not reopened for this caller
    store.state.topics = { 41: { pane: "pane", terminal: "terminal", kind: "codex", session: "old-session", cwd: dir, closedAt: 1, attached: true } };
    state = live(); calls = [];
    await life.attach("pane", "test-session"); // the fake Telegram hands out 41 again for the new topic
    expect(calls.map(c => c.name)).toEqual(["createForumTopic"]); // not reopenForumTopic
    // the caller is that session, but Herdr reports another one running in the pane: not reopened either
    store.state.topics = { 41: { pane: "pane", terminal: "terminal", kind: "codex", session: "old-session", cwd: dir, closedAt: 1, attached: true } };
    calls = [];
    expect((await life.attach("pane", "old-session")).ok).toBe(false);
    expect(calls).toEqual([]); expect(store.state.topics[41].closedAt).toBe(1);
  });
  test("a slow tab-name lookup does not hold back an answer, and a stopped watcher does not rename", async () => {
    state = live(); state.agent.agent_status = "idle";
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session", attached: true, title: "原名" };
    store.state.topics[41] = bind;
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    let release!: (v: string) => void; label = new Promise<string>(r => { release = r; }) as any;
    appendFileSync(path, [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "问" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "现成的回答" }] } },
      { type: "event_msg", payload: { type: "task_complete", last_agent_message: "现成的回答" } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    await w.tick();
    expect(sends).toContain("现成的回答");
    w.stop(); release("迟到的标签名"); await (w as any).naming;
    expect(bind.title).toBe("原名"); expect(calls.filter(c => c.name === "editForumTopic")).toHaveLength(0);
  });
  test("a Codex session names itself: tg-bind checks it even when the pane is bound, tg-send never falls back to the pane", async () => {
    state = live();
    store.state.topics[41] = { pane: "pane", cwd: dir, kind: "codex", session: "test-session" };
    expect(await life.attach("pane", "test-session")).toEqual({ ok: true, thread: 41, already: true });
    expect((await life.attach("pane", "other-session")).ok).toBe(false); // Herdr credited a neighbour's session to this pane
    rollout("other-session", dir);
    const srv = startControl({ ...cfg, port: 0 }, { ...tg, send: async (thread: number) => { sends.push(String(thread)); return 1; } }, store, {} as any, {} as any, life);
    const post = (body: any) => fetch(`http://127.0.0.1:${srv.port}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await post({ pane: "pane", session: "other-session", text: "x" })).status).toBe(404);
      expect((await post({ pane: "elsewhere", session: "test-session", text: "x" })).status).toBe(200);
      expect((await post({ pane: "pane", text: "x" })).status).toBe(200); // Claude: by pane, as before
      // a CODEX_THREAD_ID inherited by a Claude pane names no Codex session: by pane, as before
      expect((await post({ pane: "pane", session: "inherited-not-codex", text: "x" })).status).toBe(200);
      expect(sends).toEqual(["41", "41", "41"]);
    } finally { srv.stop(true); }
  });
  test("a new session id from Herdr is followed only if it started in this pane's folder and no other topic has it", async () => {
    state = live();
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session" };
    store.state.topics[41] = bind; store.state.topics[42] = { pane: "p2", cwd: dir, kind: "codex", session: "taken" };
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    rollout("neighbour", "/somewhere/else"); rollout("taken", dir);
    for (const id of ["neighbour", "taken", "not-written-yet"]) { state.agent.agent_session.value = id; await w.tick(); expect(bind.session).toBe("test-session"); }
    rollout("not-written-yet", dir); await w.tick(); expect(bind.session).toBe("test-session"); // looked at again a few seconds later
    (w as any).recheckAt = 0; await w.tick();
    expect(bind.session).toBe("not-written-yet");
  });
  test("under the shared app-server a session in the same folder is followed only when this pane's title shows its name", async () => {
    // as seen live: a new Codex tab in the same folder, credited by Herdr to the bound pane
    state = live(); state.agent.terminal_title_stripped = "总结三类Agent | tag query";
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session" };
    store.state.topics[41] = bind;
    const w: any = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    // skip the few seconds before it looks again; Herdr lists this pane with its current title
    const again = async () => { w.recheckAt = 0; agents[0] = pane("pane", state.agent.terminal_title_stripped); await w.tick(); };
    rollout("unnamed", dir, "vscode");
    state.agent.agent_session.value = "unnamed"; await w.tick(); expect(bind.session).toBe("test-session");
    rollout("neighbour", dir, "vscode", "处理111"); agents = [pane("pane", "总结三类Agent | tag query"), pane("pR", "处理111 | tag query")];
    state.agent.agent_session.value = "neighbour"; await again(); expect(bind.session).toBe("test-session");
    // a name in two panes cannot be told apart, until one of them is renamed
    rollout("twin", dir, "vscode", "同名"); state.agent.terminal_title_stripped = "同名 | tag query"; agents.push(pane("pT", "同名 | tag query"));
    state.agent.agent_session.value = "twin"; await again(); expect(bind.session).toBe("test-session");
    agents[2].terminal_title_stripped = "改了名 | tag query"; await again();
    expect(bind.session).toBe("twin");
    rollout("cleared", dir, "vscode", "新的会话"); state.agent.terminal_title_stripped = "⠋ 新的会话 | tag query"; // /clear in this pane, busy
    state.agent.agent_session.value = "cleared"; await again();
    expect(bind.session).toBe("cleared");
  });
  test("an interrupted Codex turn says so in its bubble and relays no answer", async () => {
    state = live();
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session" };
    store.state.topics[41] = bind;
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    appendFileSync(path, [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "问" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "在查" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "半截" }] } },
      { type: "event_msg", payload: { type: "turn_aborted" } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    await w.tick();
    expect(sends.at(-1)).toContain("⏹"); expect(sends.join("")).not.toContain("✅"); expect(sends).not.toContain("半截");
    // the final answer was let through by later work in the same turn, then the turn was interrupted
    sends = [];
    const turn = [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "再问" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "又一个半截" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "接着做" }] } },
      { type: "event_msg", payload: { type: "turn_aborted" } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n";
    appendFileSync(path, turn); await w.tick();
    expect(sends.at(-1)).toContain("⏹"); expect(sends).not.toContain("又一个半截");
    const before = [{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "上一问" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "上一答" }] } },
      { type: "event_msg", payload: { type: "task_complete", last_agent_message: "上一答" } }].map(x => JSON.stringify(x)).join("\n") + "\n";
    expect(lastExchange(before + turn, "codex")).toMatchObject({ ask: "上一问", answer: "上一答" });
  });
  test("tg-bind from a shared Codex session binds the pane that shows its name, not the one HERDR_PANE_ID names", async () => {
    state = live(); state.agent.agent_session.value = "someone-else"; // Herdr's view is as wrong as the environment
    rollout("shared", dir, "vscode");
    expect((await life.attach("p9", "shared")).error).toContain("not named");
    appendFileSync(join(process.env.CODEX_HOME!, "session_index.jsonl"), JSON.stringify({ id: "shared", thread_name: "处理111" }) + "\n");
    agents = [pane("p9", "总结三类Agent | tag query"), pane("pR", "处理111 | tag query"), pane("pX", "处理111 | tag query")];
    expect((await life.attach("p9", "shared")).error).toContain("/rename");
    agents.pop();
    expect(await life.attach("p9", "shared")).toEqual({ ok: true, thread: 41 });
    expect(store.state.topics[41]).toMatchObject({ pane: "pR", session: "shared", kind: "codex" });
  });
  test("watcher sends final once, commentary only in progress, with no reasoning", async () => {
    state = live();
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session" };
    store.state.topics[41] = bind;
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    appendFileSync(path, [
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "正在检查" }] } },
      { type: "response_item", payload: { type: "reasoning", summary: [{ text: "hidden" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "最终答复" }] } },
      { type: "event_msg", payload: { type: "task_complete", last_agent_message: "最终答复" } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    await w.tick(); await w.tick();
    expect(sends.filter(s => s === "最终答复")).toHaveLength(1);
    expect(sends.filter(s => s.includes("正在检查"))).toHaveLength(1);
    expect(sends.join("")).not.toContain("hidden"); expect(w.turn).toBeUndefined();
  });
  test("binding uses the Herdr tab label rather than the generated session title", async () => {
    state = live(); label = "客户用法与产品分析";
    expect((await life.attach("pane")).ok).toBe(true);
    expect(calls.find(c => c.name === "createForumTopic").body.name).toBe(label);
    expect(store.state.topics[41].title).toBe(label);
  });
  test("attached topics follow desktop renames, throttled, without redundant Telegram edits", async () => {
    state = live(); state.agent.agent_status = "idle"; label = "Herdr 标签";
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session", attached: true, title: "旧话题名" };
    store.state.topics[41] = bind;
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    await tickNamed(w);
    expect(calls.filter(c => c.name === "editForumTopic").map(c => c.body.name)).toEqual(["Herdr 标签"]);
    expect(bind.title).toBe("Herdr 标签");
    label = "修改后的标签";
    await tickNamed(w); expect(bind.title).toBe("Herdr 标签");
    (w as any).nextNameCheck = 0; await tickNamed(w);
    expect(bind.title).toBe("修改后的标签");
    (w as any).nextNameCheck = 0; await tickNamed(w);
    expect(calls.filter(c => c.name === "editForumTopic")).toHaveLength(2);
    await (w as any).onTitle("自动生成的会话标题");
    expect(bind.title).toBe("修改后的标签");
  });
  test("failed name updates retry and missing labels do not overwrite a topic", async () => {
    state = live(); state.agent.agent_status = "idle";
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session", attached: true, title: "原名" };
    store.state.topics[41] = bind;
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    await tickNamed(w); expect(bind.title).toBe("原名"); expect(calls).toHaveLength(0);
    label = "新名"; const call = tg.call;
    tg.call = async () => ({ ok: false, description: "temporary failure" });
    (w as any).nextNameCheck = 0; await tickNamed(w); expect(bind.title).toBe("原名");
    tg.call = call;
    (w as any).nextNameCheck = 0; await tickNamed(w); expect(bind.title).toBe("新名");
  });
  test("a Telegram rename of a desktop topic renames its Herdr tab, so the next sync keeps it", async () => {
    state = live(); state.agent.agent_status = "idle"; label = "Herdr 标签";
    const bind: any = { pane: "pane", tab: "tab", cwd: dir, kind: "codex", session: "test-session", attached: true, title: "Herdr 标签", autoName: true };
    store.state.topics[41] = bind;
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    await life.renamed(41, "手机上改的名");
    expect(renamedTabs).toEqual(["手机上改的名"]);
    label = renamedTabs[0]; (w as any).nextNameCheck = 0; await tickNamed(w);
    expect(bind.title).toBe("手机上改的名"); expect(calls.filter(c => c.name === "editForumTopic")).toHaveLength(0);
  });
  test("aborted and completed turns are separated from a following active turn in one poll", async () => {
    state = live();
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session" };
    store.state.topics[41] = bind;
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    const user = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    const answer = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text }] } });
    const end = (text: string) => ({ type: "event_msg", payload: { type: "task_complete", last_agent_message: text } });
    appendFileSync(path, [user("q1"), answer("a1"), end("a1"), user("q2"), answer("a2"), end("a2"),
      user("aborted"), { type: "event_msg", payload: { type: "turn_aborted" } },
      user("still working"), { type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "checking new task" }] } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    await w.tick();
    expect(sends.filter(s => s === "a1")).toHaveLength(1); expect(sends.filter(s => s === "a2")).toHaveLength(1);
    expect(w.turn).toBeDefined(); expect(w.turn!.lines.join("\n")).toContain("checking new task");
    expect(w.lastAnswer?.items).toEqual([]);
  });
  test("a single Codex question gets the same option buttons as AskUserQuestion; several fall back to the screen", async () => {
    // arguments as recorded from Codex CLI 0.162 (request_user_input, Herdr status blocked)
    const ask = (questions: any[]) => JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "request_user_input", call_id: `c${questions.length}`,
      arguments: JSON.stringify({ questions }) } }) + "\n";
    const q = (question: string) => ({ header: "h", id: "i", question, options: [{ label: "Python", description: "用 Python" }, { label: "Bash", description: "用 Bash" }] });
    state = live();
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session" };
    store.state.topics[41] = bind;
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    appendFileSync(path, ask([q("用哪种语言？")]));
    state.agent.agent_status = "blocked"; await w.tick();
    expect(keyboards.at(-1)).toEqual([[{ text: "Python", callback_data: "aq:41:0:0" }], [{ text: "Bash", callback_data: "aq:41:0:1" }]]);
    expect(sends.some(s => s.includes("用哪种语言？"))).toBe(true);
    state.agent.agent_status = "working"; await w.tick();
    appendFileSync(path, ask([q("语言？"), q("输出？")]));
    state.agent.agent_status = "blocked"; await w.tick();
    expect(keyboards).toHaveLength(1); expect(sends.at(-1)).toContain("/keys");
  });
});
