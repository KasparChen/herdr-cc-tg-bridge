import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { loadConfig } from "../src/config";
import { pickOutbox } from "../src/outbox";
import { bubble, fmtSecs, md2html, mdChunks, stripTags, tables2bullets, toolLine } from "../src/render";
import { parseLine, TranscriptTail } from "../src/transcript";

describe("render", () => {
  test("bubble keeps the three-line collapsed header", () => {
    const html = bubble(["💻 Running date", "💬 checking"], 1, 65, false);
    expect(html.startsWith("<blockquote expandable><b>⚙️ 执行中</b>\n<i>🔧 1 次调用 · 1m05s</i>\n...\n")).toBe(true);
    expect(html).toContain("<b>💬 checking</b>");
    expect(bubble([], 0, 0, true)).toBe("<blockquote expandable><b>✅ 完成</b>\n<i>🔧 0 次调用 · 0s</i></blockquote>");
  });
  test("bubble drops oldest lines past the limit", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `💻 Running line-${i} ${"x".repeat(40)}`);
    const html = bubble(lines, 200, 1, false);
    expect(html.length).toBeLessThan(3800);
    expect(html).toContain("line-199");
    expect(html).not.toContain("line-0 ");
  });
  test("tool lines", () => {
    expect(toolLine("Bash", { command: "ls -la\necho hi" })).toBe("💻 Running ls -la");
    expect(toolLine("Read", { file_path: join(homedir(), "a/b.md") })).toBe("📖 Reading ~/a/b.md");
    expect(toolLine("mcp__lark__send", {})).toBe("⚙️ lark · send");
  });
  test("fmtSecs", () => {
    expect(fmtSecs(12)).toBe("12s");
    expect(fmtSecs(3600)).toBe("60m00s");
  });
  test("markdown to html escapes and formats", () => {
    expect(md2html("**a** <b> `x<y`")).toBe("<b>a</b> &lt;b&gt; <code>x&lt;y</code>");
    expect(md2html("```ts\nconst a = 1 < 2\n```")).toBe("<pre>const a = 1 &lt; 2</pre>");
    expect(md2html("- one\n- [doc](https://x.y/z)")).toBe('• one\n• <a href="https://x.y/z">doc</a>');
  });
  test("tables become grouped bullets", () => {
    const out = tables2bullets("| 项目 | 结果 |\n|---|---|\n| A | ok |\n| B | no |\n");
    expect(out).toBe("• **A**\n  结果：ok\n• **B**\n  结果：no\n");
  });
  test("chunks stay under the limit and keep all text", () => {
    const md = Array.from({ length: 300 }, (_, i) => `第 ${i} 行，带一些 **加粗** 和 \`code\``).join("\n");
    const cs = mdChunks(md, 1000);
    expect(cs.length).toBeGreaterThan(3);
    for (const c of cs) expect(c.length).toBeLessThanOrEqual(1000);
    expect(cs.map(stripTags).join("\n")).toContain("第 299 行");
  });
  test("chunks reopen code fences", () => {
    const md = "```\n" + Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n```";
    const cs = mdChunks(md, 600);
    for (const c of cs) expect(c.startsWith("<pre>") && c.endsWith("</pre>")).toBe(true);
  });
});

describe("transcript", () => {
  test("parses tool use, text, title, queued", () => {
    expect(parseLine(JSON.stringify({ type: "ai-title", aiTitle: "T" }))).toEqual([{ kind: "title", title: "T" }]);
    const a = parseLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "1", name: "Bash", input: { command: "ls" } }] } }));
    expect(a.map(e => e.kind)).toEqual(["text", "tool"]);
    expect(parseLine(JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: "q" } }))).toEqual([{ kind: "queued", text: "q" }]);
    expect(parseLine(JSON.stringify({ type: "user", isSidechain: true, message: { content: "x" } }))).toEqual([]);
  });
  test("tail reads only complete new lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "tgb-"));
    const f = join(dir, "s.jsonl");
    writeFileSync(f, JSON.stringify({ type: "ai-title", aiTitle: "old" }) + "\n");
    const tail = new TranscriptTail(f, true);
    expect(tail.read()).toEqual([]);
    appendFileSync(f, JSON.stringify({ type: "user", message: { content: "新消息" } }) + "\n" + '{"type":"ai-ti');
    expect(tail.read()).toEqual([{ kind: "user", text: "新消息" }]);
    appendFileSync(f, 'tle","aiTitle":"新"}\n');
    expect(tail.read()).toEqual([{ kind: "title", title: "新" }]);
  });
});

describe("outbox", () => {
  test("filters by extension and excluded dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "tgb-"));
    mkdirSync(join(dir, "node_modules"));
    for (const n of ["a.png", "b.md", "c.pdf", "node_modules/d.png"]) writeFileSync(join(dir, n), "x");
    const cfg = { autosendExt: new Set(["png", "pdf"]), stateDir: "/nonexistent" };
    const got = pickOutbox([join(dir, "a.png"), join(dir, "b.md"), join(dir, "c.pdf"), join(dir, "a.png"), join(dir, "node_modules/d.png"), join(dir, "missing.png")], cfg);
    expect(got).toEqual([join(dir, "a.png"), join(dir, "c.pdf")]);
  });
});

describe("config", () => {
  test("requires the four personal values", () => {
    expect(() => loadConfig({})).toThrow(/TELEGRAM_BOT_TOKEN, TG_CHAT_ID, TG_ALLOWED_USERS, TG_BRIDGE_WORKDIR/);
    const c = loadConfig({ TELEGRAM_BOT_TOKEN: "t", TG_CHAT_ID: "-100", TG_ALLOWED_USERS: "1, 2", TG_BRIDGE_WORKDIR: "~/x" });
    expect([...c.allowedUsers]).toEqual([1, 2]);
    expect(c.workdir).toBe(join(homedir(), "x"));
    expect(c.sim).toBe(false);
  });
});
