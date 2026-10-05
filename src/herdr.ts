// Thin wrapper over the herdr CLI (JSON output over its socket API).
import { log } from "./log";

export async function herdr(...args: string[]): Promise<any> {
  const p = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (err.trim() && args[0] !== "pane" && !(args[0] === "agent" && args[1] === "get")) log("herdr", args.slice(0, 2).join(" "), err.trim().slice(0, 200));
  try { return JSON.parse(out); } catch { return out; }
}

export type Agent = {
  pane_id: string; tab_id: string; workspace_id: string; agent_status: string;
  agent_session?: { value: string }; cwd: string; terminal_title_stripped?: string;
};

export const agentGet = async (pane: string): Promise<Agent | undefined> => (await herdr("agent", "get", pane))?.result?.agent;
export const prompt = (pane: string, text: string) => herdr("agent", "prompt", pane, text);
export const sendKeys = (pane: string, keys: string[]) => herdr("pane", "send-keys", pane, ...keys);
export const paneRead = async (pane: string) => String(await herdr("pane", "read", pane));
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

export async function spawnClaude(opts: { workspace?: string; cwd: string; label: string; args: string[] }) {
  const tabArgs = ["tab", "create", "--cwd", opts.cwd, "--label", opts.label];
  if (opts.workspace) tabArgs.push("--workspace", opts.workspace);
  const tab = await herdr(...tabArgs);
  const pane: string | undefined = tab?.result?.root_pane?.pane_id;
  if (!pane) return;
  // a freshly created pane needs a moment before its shell accepts the agent
  let a: any;
  for (let i = 0; i < 10 && !a; i++) {
    if (i) await Bun.sleep(500);
    const st = await herdr("agent", "start", opts.label, "--kind", "claude", "--pane", pane, ...(opts.args.length ? ["--", ...opts.args] : []));
    a = st?.result?.agent;
  }
  if (!a) return;
  return { pane, tab: tab.result.tab.tab_id as string, session: a?.agent_session?.value as string | undefined };
}

// Display-only token on the workspace; it disappears by itself once ttl passes without a refresh.
export const workspaceToken = (ws: string, name: string, value: string, ttlMs: number) =>
  herdr("workspace", "report-metadata", ws, "--source", "tg-bridge", "--token", `${name}=${value}`, "--ttl-ms", String(ttlMs));
export const clearWorkspaceToken = (ws: string, name: string) =>
  herdr("workspace", "report-metadata", ws, "--source", "tg-bridge", "--clear-token", name);
