// Telegram HTML rendering: tg-fold style progress bubble, Markdown -> HTML, chunking.
import { homedir } from "os";
import { tr } from "./i18n";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
export const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export const fmtSecs = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`);
const HOME = homedir();

// tool line = "{emoji} {verb} {preview}", Hermes tg-fold verbs mapped onto Claude Code tool names
const TOOLS: Record<string, [string, string]> = {
  Bash: ["💻", "Running"], Read: ["📖", "Reading"], Write: ["✍️", "Writing"], Edit: ["🔧", "Editing"], MultiEdit: ["🔧", "Editing"],
  NotebookEdit: ["🔧", "Editing"], Grep: ["🔎", "Searching files for"], Glob: ["🔎", "Finding files"], WebSearch: ["🔍", "Searching the web for"],
  WebFetch: ["📄", "Reading"], Agent: ["🔀", "Delegating"], Task: ["🔀", "Delegating"], TodoWrite: ["📋", "Updating tasks"],
  Skill: ["📚", "Reading skill"], AskUserQuestion: ["❓", "Asking"], ToolSearch: ["🧰", "Loading tools"],
};

export function toolLine(name: string, input: any): string {
  const [emoji, verb] = TOOLS[name] ?? ["⚙️", name.replace(/^mcp__/, "").replace(/__/g, " · ")];
  let p =
    name === "Bash" ? String(input?.command ?? "").split("\n")[0]
    : input?.file_path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.skill ?? input?.description ?? input?.questions?.[0]?.question ?? "";
  p = String(p).replace(/\s+/g, " ").split(HOME).join("~");
  return cut(p ? `${emoji} ${verb} ${p}` : `${emoji} ${verb}`, 300);
}

export const commentLine = (text: string) => `💬 ${cut(text.replace(/[*`#_]/g, "").replace(/\s+/g, " ").trim(), 500)}`;
export const isComment = (line: string) => /^(💬|🖥)/u.test(line);

// Collapsed view shows the first three lines: status, counters, "...".
export function bubble(lines: string[], calls: number, secs: number, done: boolean, max = 3600, extra = ""): string {
  const head = `<b>${done ? tr("✅ 完成", "✅ Done") : tr("⚙️ 执行中", "⚙️ Working")}</b>\n<i>🔧 ${tr(`${calls} 次调用`, `${calls} call${calls === 1 ? "" : "s"}`)} · ${fmtSecs(secs)}${extra ? ` · ${esc(extra)}` : ""}</i>`;
  let body = lines.map(l => (isComment(l) ? `<b>${esc(l)}</b>` : esc(l)));
  while (body.length && body.join("\n").length > max) body = body.slice(1);
  return `<blockquote expandable>${head}${body.length ? "\n...\n" + body.join("\n") : ""}</blockquote>`;
}

// GFM table -> grouped bullets (Telegram has no tables)
export function tables2bullets(md: string): string {
  return md.replace(/((?:^[ \t]*\|.*\|[ \t]*(?:\n|$))+)/gm, block => {
    const rows = block.trim().split("\n").map(r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
    if (rows.length < 2 || !rows[1].every(c => /^:?-{2,}:?$/.test(c))) return block;
    const [head, , ...body] = rows;
    return body.map(r => `• **${r[0]}**\n` + r.slice(1).map((c, i) => `  ${head[i + 1]}${tr("：", ": ")}${c}`).join("\n")).join("\n") + "\n";
  });
}

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/^#{1,6} (.+)$/gm, "<b>$1</b>")
    .replace(/^(\s*)[-*] /gm, "$1• ");
}

export function md2html(md: string): string {
  const parts = tables2bullets(md).split(/^```[^\n]*\n?/m);
  return parts.map((p, i) => (i % 2 === 1 ? `<pre>${esc(p.replace(/\n$/, ""))}</pre>` : inline(p))).join("").trim();
}

// Split Markdown on line boundaries into pieces whose HTML stays under the limit; code fences are closed and reopened.
export function mdChunks(md: string, limit = 3800): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (!cur.length) return;
    out.push(md2html(cur.join("\n") + (fence ? "\n```" : "")));
    cur = fence ? [fence] : [];
  };
  for (const raw of md.split("\n")) {
    for (let line = raw; ; ) {
      const piece = line.length > limit / 2 ? line.slice(0, limit / 2) : line;
      if (md2html([...cur, piece].join("\n")).length > limit) flush();
      cur.push(piece);
      if (/^```/.test(piece.trim())) fence = fence ? null : piece.trim();
      if (piece.length === line.length) break;
      line = line.slice(piece.length);
    }
  }
  flush();
  return out.filter(c => stripTags(c).trim());
}
