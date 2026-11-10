// Incremental reader for Claude Code session transcripts (~/.claude/projects/<cwd-slug>/<session>.jsonl).
import { existsSync, statSync, openSync, readSync, closeSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Glob } from "bun";
import type { AgentKind } from "./providers";

export type TEvent =
  | { kind: "user"; text: string }
  | { kind: "queued"; text: string }
  | { kind: "tool"; id: string; name: string; input: any }
  | { kind: "text"; text: string }
  | { kind: "commentary"; text: string }
  | { kind: "title"; title: string }
  | { kind: "end"; aborted?: true }; // the main agent ended its turn (even if background agents keep the session busy); aborted: interrupted

export const transcriptPath = (cwd: string, session: string) =>
  join(homedir(), ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`);

// Search by the exact session id, never by cwd or "latest": concurrent sessions can share a directory.
// Root arguments are injectable so tests do not inspect any personal session files.
export function findTranscript(cwd: string, session: string, kind: AgentKind = "claude",
  roots = { claude: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"), codex: process.env.CODEX_HOME || join(homedir(), ".codex") }): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(session)) return "";
  if (kind === "claude") {
    const p = join(roots.claude, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`);
    if (existsSync(p)) return p;
    if (existsSync(roots.claude)) for (const hit of new Glob(`*/${session}.jsonl`).scanSync(roots.claude)) return join(roots.claude, hit);
    return p;
  }
  for (const dir of ["sessions", "archived_sessions"]) {
    const root = join(roots.codex, dir);
    if (!existsSync(root)) continue;
    for (const hit of new Glob(`**/rollout-*-${session}.jsonl`).scanSync(root)) return join(root, hit);
  }
  return "";
}

// From the session_meta record that opens a Codex rollout: the folder the session started in, and whether it runs in
// Codex's shared app-server (source "vscode", as for the desktop app) rather than in its own process ("cli").
export function codexSessionMeta(path: string): { cwd?: string; shared: boolean } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(256 * 1024);
    const line = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8").split("\n")[0];
    const p = JSON.parse(line)?.payload;
    return { cwd: typeof p?.cwd === "string" ? p.cwd : undefined, shared: p?.source === "vscode" };
  } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
}

// Codex writes both event_msg and response_item records for the same content.
// Use response_item for content; task_complete is the authoritative turn boundary.
// No reasoning, system/developer instructions, or tool outputs are relayed.
// Final text is held until the turn completes: an interrupted turn (turn_aborted) drops it, so a partial answer is
// never relayed or shown as the last answer. Anything that follows it within the turn releases it, in order.
export function codexParser(): (line: string) => TEvent[] {
  let sawFinal = false, held: string[] = [];
  const release = (): TEvent[] => held.splice(0).map(text => ({ kind: "text", text }));
  return line => {
    let d: any;
    try { d = JSON.parse(line); } catch { return []; }
    if (!d || typeof d !== "object") return [];
    const p = d.payload;
    if (!p) return [];
    if (d.type === "event_msg") {
      if (p.type === "task_started") { sawFinal = false; held = []; return []; }
      if (p.type === "task_complete") {
        const fallback: TEvent[] = !sawFinal && typeof p.last_agent_message === "string" && p.last_agent_message.trim()
          ? [{ kind: "text", text: p.last_agent_message }] : [];
        sawFinal = false;
        return [...release(), ...fallback, { kind: "end" }];
      }
      if (p.type === "turn_aborted") { sawFinal = false; held = []; return [{ kind: "end", aborted: true }]; }
      return [];
    }
    if (d.type !== "response_item") return [];
    if (p.type === "message") {
      if (p.role !== "user" && p.role !== "assistant") return [];
      const content = Array.isArray(p.content) ? p.content : [];
      const text = content.filter((b: any) => b && (b.type === "input_text" || b.type === "output_text" || b.type === "text"))
        .map((b: any) => typeof b.text === "string" ? b.text : "").filter(Boolean).join("\n");
      if (!text.trim()) return [];
      // Codex records its context as user messages too: "<environment_context>" and other "<...>" wrappers, which
      // the Watcher already skips like Claude's, and AGENTS.md, the one that is not wrapped. None of them was typed.
      if (p.role === "user") { if (text.startsWith("# AGENTS.md instructions")) return []; sawFinal = false; return [...release(), { kind: "user", text }]; }
      if (p.phase === "commentary") return [...release(), { kind: "commentary", text }];
      // Unknown phases are never treated as final content (in particular analysis).
      if (p.phase && p.phase !== "final" && p.phase !== "final_answer") return [];
      sawFinal = true;
      held.push(text);
      return [];
    }
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      let input: any = p.arguments ?? p.input ?? {};
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = {}; } }
      if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
      const raw = typeof p.name === "string" ? p.name : "tool";
      // request_user_input has AskUserQuestion's questions/options shape and answers with the same keys (down… enter)
      const name = ["exec_command", "shell_command", "shell"].includes(raw) ? "Bash" : raw === "request_user_input" ? "AskUserQuestion" : raw;
      if (name === "Bash") input = { command: input.cmd ?? input.command ?? "" };
      return [...release(), { kind: "tool", id: p.call_id ?? p.id ?? "", name, input }];
    }
    return [];
  };
}

export const transcriptParser = (kind: AgentKind = "claude") => kind === "codex" ? codexParser() : parseLine;

export function parseLine(line: string): TEvent[] {
  let d: any;
  try { d = JSON.parse(line); } catch { return []; }
  if (d.isSidechain) return [];
  if (d.type === "ai-title" && d.aiTitle) return [{ kind: "title", title: d.aiTitle }];
  if (d.type === "attachment" && d.attachment?.type === "queued_command" && typeof d.attachment.prompt === "string")
    return [{ kind: "queued", text: d.attachment.prompt }];
  if (d.type === "user" && !d.isMeta && typeof d.message?.content === "string") return [{ kind: "user", text: d.message.content }];
  if (d.type !== "assistant" || !Array.isArray(d.message?.content)) return [];
  const out: TEvent[] = [];
  for (const b of d.message.content) {
    if (b.type === "tool_use") out.push({ kind: "tool", id: b.id, name: b.name, input: b.input });
    else if (b.type === "text" && b.text?.trim()) out.push({ kind: "text", text: b.text });
  }
  // one reply can be written as several lines (thinking, then text); only the line carrying the text closes the turn
  if (d.message.stop_reason === "end_turn" && out.some(e => e.kind === "text")) out.push({ kind: "end" });
  return out;
}

export class TranscriptTail {
  pos = 0;
  constructor(public path: string, fromEnd = true, private parse = parseLine) {
    if (fromEnd && existsSync(path)) this.pos = statSync(path).size;
  }
  read(): TEvent[] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size < this.pos) this.pos = 0; // rewritten
    if (size === this.pos) return [];
    const buf = Buffer.alloc(size - this.pos);
    const fd = openSync(this.path, "r");
    try { readSync(fd, buf, 0, buf.length, this.pos); } finally { closeSync(fd); }
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return [];
    this.pos += end + 1;
    return buf.subarray(0, end + 1).toString("utf8").split("\n").filter(l => l.trim()).flatMap(this.parse);
  }
}
