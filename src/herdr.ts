// Thin wrapper over the herdr CLI (JSON output over its socket API).
import { log } from "./log";

export async function herdr(...args: string[]): Promise<any> {
  const p = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (err.trim() && args[0] !== "pane" && !(args[0] === "agent" && args[1] === "get")) log("herdr", args.slice(0, 2).join(" "), err.trim().slice(0, 200));
  try { return JSON.parse(out); } catch {}
  // errors such as agent_not_found / pane_not_found come as JSON on stderr
  if (!out.trim()) try { return JSON.parse(err); } catch {}
  return out;
}

export type Agent = {
  pane_id: string; tab_id: string; workspace_id: string; agent_status: string;
  agent_session?: { value: string }; cwd: string; terminal_title_stripped?: string;
  terminal_id?: string; tokens?: Record<string, string>; // tokens.context, e.g. "⛁ 43% (430k)", for hooked Claude sessions
};

export const agentGet = async (pane: string): Promise<Agent | undefined> => (await herdr("agent", "get", pane))?.result?.agent;
export const prompt = (pane: string, text: string) => herdr("agent", "prompt", pane, text);
export const sendKeys = (pane: string, keys: string[]) => herdr("pane", "send-keys", pane, ...keys);
export const paneRead = async (pane: string) => { const r = await herdr("pane", "read", pane); return typeof r === "string" ? r : ""; };
export const tabRename = (tab: string, label: string) => herdr("tab", "rename", tab, label);

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
export async function spawnClaude(opts: { workspace?: string; cwd: string; label: string; agent: string; args: string[]; pane?: string }) {
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
  let a: any;
  for (let i = 0; i < 10 && !a; i++) {
    if (i) await Bun.sleep(500);
    const st = await herdr("agent", "start", opts.agent, "--kind", "claude", "--pane", pane, ...(opts.args.length ? ["--", ...opts.args] : []));
    a = st?.result?.agent;
    if (st?.error?.code && st.error.code !== "agent_pane_busy") break; // only "busy" is worth waiting for
  }
  if (!a) {
    if (!opts.pane) await paneClose(pane); // do not leave an empty tab behind
    return;
  }
  return { pane, tab: (tab ?? a.tab_id) as string | undefined, terminal: a.terminal_id as string | undefined, session: a?.agent_session?.value as string | undefined };
}

// Display-only token on the workspace; it disappears by itself once ttl passes without a refresh.
export const workspaceToken = (ws: string, name: string, value: string, ttlMs: number) =>
  herdr("workspace", "report-metadata", ws, "--source", "tg-bridge", "--token", `${name}=${value}`, "--ttl-ms", String(ttlMs));
export const clearWorkspaceToken = (ws: string, name: string) =>
  herdr("workspace", "report-metadata", ws, "--source", "tg-bridge", "--clear-token", name);
