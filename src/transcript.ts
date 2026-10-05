// Incremental reader for Claude Code session transcripts (~/.claude/projects/<cwd-slug>/<session>.jsonl).
import { existsSync, statSync, openSync, readSync, closeSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type TEvent =
  | { kind: "user"; text: string }
  | { kind: "queued"; text: string }
  | { kind: "tool"; id: string; name: string; input: any }
  | { kind: "text"; text: string }
  | { kind: "title"; title: string };

export const transcriptPath = (cwd: string, session: string) =>
  join(homedir(), ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`);

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
  return out;
}

export class TranscriptTail {
  pos = 0;
  constructor(public path: string, fromEnd = true) {
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
    return buf.subarray(0, end + 1).toString("utf8").split("\n").filter(l => l.trim()).flatMap(parseLine);
  }
}
