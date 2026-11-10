// Thin wrapper over the herdr CLI (JSON output over its socket API).
import { log } from "./log";
import type { AgentKind } from "./providers";
import { shq } from "./backends";

export async function herdr(...args: string[]): Promise<any> {
  const p = Bun.spawn(["herdr", ...args], { env: process.env, stdout: "pipe", stderr: "pipe" }); // env: PATH as it is now, not at start
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (err.trim() && args[0] !== "pane" && !(args[0] === "agent" && args[1] === "get")) log("herdr", args.slice(0, 2).join(" "), err.trim().slice(0, 200));
  try { return JSON.parse(out); } catch {}
  // errors such as agent_not_found / pane_not_found come as JSON on stderr
  if (!out.trim()) try { return JSON.parse(err); } catch {}
  return out;
}

export type Agent = {
  agent?: string; // agent kind: "claude", "codex", ...
  pane_id: string; tab_id: string; workspace_id: string; agent_status: string;
  agent_session?: { value: string }; cwd: string; terminal_title_stripped?: string;
  terminal_id?: string; tokens?: Record<string, string>; // tokens.context, e.g. "⛁ 43% (430k)", for hooked Claude sessions
};

export const agentGet = async (pane: string): Promise<Agent | undefined> => (await herdr("agent", "get", pane))?.result?.agent;
export const prompt = (pane: string, text: string) => herdr("agent", "prompt", pane, text);
export const sendKeys = (pane: string, keys: string[]) => herdr("pane", "send-keys", pane, ...keys);
export const paneRead = async (pane: string) => { const r = await herdr("pane", "read", pane); return typeof r === "string" ? r : ""; };
export const tabRename = (tab: string, label: string) => herdr("tab", "rename", tab, label);

// The user-visible tab label is different from the agent's terminal/session title.
export async function tabLabel(workspace: string, tab: string): Promise<string | undefined> {
  const r = await herdr("tab", "list", "--workspace", workspace);
  const value = r?.result?.tabs?.find((t: any) => t.tab_id === tab)?.label;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Herdr names new tabs 1, 2, 3 …; such a label says nothing about the session, so the session title is used instead
export const usefulLabel = (label?: string) => (label && !/^\d+$/.test(label.trim()) ? label : undefined);

export async function workspaces(): Promise<any[] | undefined> {
  const r = await herdr("workspace", "list");
  return r?.result?.workspaces;
}

// accepts a workspace id ("wB") or its label ("Telegram")
export async function resolveWorkspace(idOrLabel?: string): Promise<string | undefined> {
  if (!idOrLabel) return;
  const ws = (await workspaces()) ?? [];
  return ws.find(w => w.workspace_id === idOrLabel || w.label === idOrLabel)?.workspace_id;
}

export const paneGet = async (pane: string) => (await herdr("pane", "get", pane))?.result?.pane;
export const paneClose = (pane: string) => herdr("pane", "close", pane);

export async function agentList(): Promise<Agent[]> {
  return (await herdr("agent", "list"))?.result?.agents ?? [];
}

// live: Claude runs in the pane. exited: the pane is left with a shell (e.g. after /exit). gone: the pane was closed.
// unknown: Herdr did not answer, so nothing should be concluded. A pane whose terminal differs from the one we
// recorded is a reused id and counts as gone.
export type PaneState = { state: "live" | "exited" | "gone" | "unknown"; agent?: Agent; terminal?: string };

export async function paneState(pane: string, terminal?: string): Promise<PaneState> {
  const r = await herdr("agent", "get", pane);
  const a: any = r?.result?.agent;
  const mine = (t?: string) => !terminal || !t || t === terminal;
  if (a) return mine(a.terminal_id) ? { state: "live", agent: a, terminal: a.terminal_id } : { state: "gone" };
  if (r?.error?.code !== "agent_not_found") return { state: "unknown" };
  const p = await herdr("pane", "get", pane);
  if (p?.result?.pane) return mine(p.result.pane.terminal_id) ? { state: "exited", terminal: p.result.pane.terminal_id } : { state: "gone" };
  return p?.error?.code === "pane_not_found" ? { state: "gone" } : { state: "unknown" };
}

// Starts Claude in `pane` (an existing shell pane, e.g. one left behind by /exit) or in a new tab.
// `label` is the tab label (any text); `agent` is the Herdr agent name, which must match [a-z][a-z0-9_-]{0,31}.
export async function spawnAgent(opts: { kind: AgentKind; cmd?: string; workspace?: string; cwd: string; label: string; agent: string; args: string[]; pane?: string }) {
  let pane = opts.pane;
  let tab: string | undefined;
  if (pane) tab = (await paneGet(pane))?.tab_id;
  else {
    const tabArgs = ["tab", "create", "--cwd", opts.cwd, "--label", opts.label];
    if (opts.workspace) tabArgs.push("--workspace", opts.workspace);
    const t = await herdr(...tabArgs);
    pane = t?.result?.root_pane?.pane_id;
    tab = t?.result?.tab?.tab_id;
  }
  if (!pane) return;
  // a freshly created pane needs a moment before its shell accepts the agent
  let a: any = opts.cmd ? await runCommand(pane, opts.kind, opts.agent, opts.cmd, opts.args) : undefined;
  for (let i = 0; i < 10 && !a && !opts.cmd; i++) {
    if (i) await Bun.sleep(500);
    const st = await herdr("agent", "start", opts.agent, "--kind", opts.kind, "--pane", pane, ...(opts.args.length ? ["--", ...opts.args] : []));
    a = st?.result?.agent;
    // Herdr 0.9 reports an agent held at a startup screen (update notice, hook trust) as not ready; it is running,
    // and the Watcher shows that screen in the topic so it can be answered with /keys
    if (st?.error?.code === "agent_not_ready") { a = await agentGet(pane); break; }
    if (st?.error?.code && st.error.code !== "agent_pane_busy") break; // only "busy" is worth waiting for
  }
  if (!a) {
    if (opts.cmd) log("spawn failed", opts.cmd, (await paneRead(pane)).split("\n").filter(l => l.trim()).slice(-5).join(" | ").slice(0, 400));
    if (!opts.pane) await paneClose(pane); // do not leave an empty tab behind
    return;
  }
  return { pane, tab: (tab ?? a.tab_id) as string | undefined, terminal: a.terminal_id as string | undefined, session: a?.agent_session?.value as string | undefined };
}

// A custom backend: `agent start` only runs Herdr's own executables, so the command is typed into the pane's shell
// (`pane run` does no quoting of its own) and the agent is named once Herdr has recognised it and its session id.
async function runCommand(pane: string, kind: AgentKind, name: string, cmd: string, args: string[], timeoutMs = 45_000) {
  for (let i = 0; i < 10; i++) {
    if (i) await Bun.sleep(500);
    const r = await herdr("pane", "run", pane, [cmd, ...args.map(shq)].join(" "));
    if (!r?.error) break;
    if (r.error.code !== "pane_busy" && r.error.code !== "agent_pane_busy") return;
  }
  const t0 = Date.now();
  let seen = 0;
  while (Date.now() - t0 < timeoutMs) {
    await Bun.sleep(1000);
    const a = await agentGet(pane);
    if (a?.agent !== kind) continue;
    seen ||= Date.now();
    // the session id comes from the agent's start hook; a session without the hook is still usable
    if (a.agent_session?.value || Date.now() - seen > 10_000) {
      const r = await herdr("agent", "rename", pane, name);
      return r?.result?.agent ?? a;
    }
  }
}

// Display-only token on the workspace; it disappears by itself once ttl passes without a refresh.
export const workspaceToken = (ws: string, name: string, value: string, ttlMs: number) =>
  herdr("workspace", "report-metadata", ws, "--source", "tg-bridge", "--token", `${name}=${value}`, "--ttl-ms", String(ttlMs));
export const clearWorkspaceToken = (ws: string, name: string) =>
  herdr("workspace", "report-metadata", ws, "--source", "tg-bridge", "--clear-token", name);
