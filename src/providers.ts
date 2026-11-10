// Provider-specific launch options. Missing kind on an old binding means Claude.
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Agent } from "./herdr";

export type AgentKind = "claude" | "codex";

export function agentKind(value: unknown): AgentKind | undefined {
  return value === "claude" || value === "codex" ? value : undefined;
}

export function launchArgs(kind: AgentKind, resume: string | undefined, extra: string[], prompt: string, codex?: { own?: string }): string[] {
  if (kind === "claude") return [...(resume ? ["--resume", resume] : []), "--append-system-prompt", prompt, ...extra];
  // Codex has no --append-system-prompt. `-c developer_instructions=` adds a developer message next to Codex's own,
  // but replaces the user's value, so that value (see codexInstructions) is kept in front of ours. Nothing is added
  // when TG_CODEX_ARGS sets it, or when Codex could not say what the user's value is.
  if (!codex || extra.some(a => a.includes("developer_instructions"))) return [...(resume ? ["resume", resume] : []), ...extra];
  const text = codex.own ? `${codex.own}\n\n${prompt}` : prompt;
  return [...(resume ? ["resume", resume] : []), "-c", `developer_instructions=${JSON.stringify(text)}`, ...extra];
}

// The developer_instructions Codex itself would use for this launch, whatever layer sets it (config.toml, a
// NAME.config.toml profile, a trusted project's .codex/config.toml, -c in TG_CODEX_ARGS). `codex debug prompt-input`
// renders the prompt offline, without a model call; rendering it again with a marker value shows where the value sits.
// { own: undefined } = none configured; undefined = Codex could not tell.
export async function codexInstructions(extra: string[], cwd: string, bin = "codex"): Promise<{ own?: string } | undefined> {
  const marker = "tg-bridge-marker-5c1e";
  // every developer message's text parts; Codex 0.166 sends several, and the configured value is not in the first
  const developer = async (args: string[]): Promise<string[][] | undefined> => {
    try {
      const p = Bun.spawn([bin, ...args, "debug", "prompt-input", "x"], { cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => p.kill(), 10_000);
      const out = await new Response(p.stdout).text();
      clearTimeout(timer);
      if ((await p.exited) !== 0) return;
      const ms = JSON.parse(out).filter((i: any) => i?.type === "message" && i.role === "developer" && Array.isArray(i.content));
      return ms.length ? ms.map((m: any) => m.content.map((c: any) => typeof c?.text === "string" ? c.text : "")) : undefined;
    } catch { return; }
  };
  const [mine, marked] = await Promise.all([developer(extra), developer([...extra, "-c", `developer_instructions=${JSON.stringify(marker)}`])]);
  const m = marked?.findIndex(parts => parts.includes(marker)) ?? -1;
  if (!mine || m < 0) return;
  const i = marked![m].indexOf(marker);
  // with a value configured it sits where the marker went; without one the marker added a part there
  return { own: mine[m]?.length === marked![m].length ? mine[m][i].trim() || undefined : undefined };
}

// The name Codex gave a session (from its first message, or /rename); the last entry in session_index.jsonl wins.
export function codexSessionName(session: string, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")): string | undefined {
  let name: string | undefined;
  try {
    for (const line of readFileSync(join(codexHome, "session_index.jsonl"), "utf8").split("\n")) {
      if (!line.includes(session)) continue;
      try { const e = JSON.parse(line); if (e.id === session && typeof e.thread_name === "string") name = e.thread_name.trim() || name; } catch {}
    }
  } catch {}
  return name;
}

// Codex shows the session name in its terminal title ("name | folder", a spinner in front while busy), and Herdr
// reads each pane's title on its own, so the title tells which pane a session is in when nothing else can.
export const titleShows = (title: string | undefined, name: string) =>
  (title ?? "").split(" | ").some(s => s.replace(/^[^\p{L}\p{N}]+/u, "").trim() === name);

// The Codex panes in `cwd` whose title shows `name`. tg-bind and the Watcher both place a shared session by this:
// it is in a pane only when that pane is the single one listed.
export const panesShowing = (agents: Agent[], cwd: string, name: string) =>
  agents.filter(a => a.agent === "codex" && a.cwd === cwd && titleShows(a.terminal_title_stripped, name)).map(a => a.pane_id);
