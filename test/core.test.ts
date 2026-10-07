import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { loadConfig } from "../src/config";
import { ago, cleanTitle, lastExchange } from "../src/lifecycle";
import { left, limitsLine, parseCtx } from "../src/usage";
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

describe("lifecycle", () => {
  test("ago", () => {
    const now = 10 * 86400_000;
    expect(ago(undefined, now)).toBe("");
    expect(ago(now - 30_000, now)).toBe("刚刚");
    expect(ago(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(ago(now - 3 * 3600_000, now)).toBe("3 小时前");
    expect(ago(now - 2 * 86400_000, now)).toBe("2 天前");
  });
  test("cleanTitle drops the spinner glyph", () => {
    expect(cleanTitle("◐ HR 圈分享")).toBe("HR 圈分享");
    expect(cleanTitle("✳ 3D 打印")).toBe("3D 打印");
    expect(cleanTitle(undefined)).toBe("");
  });
  test("lastExchange finds the last prompt and the reply that ended its turn", () => {
    const L = (o: any) => JSON.stringify(o);
    const t = [
      L({ type: "user", message: { content: "第一问" } }),
      L({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "第一答" }] } }),
      L({ type: "user", message: { content: "第二问" } }),
      L({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "text", text: "先查一下" }, { type: "tool_use", id: "1", name: "Bash", input: {} }] } }),
      L({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "第二答" }] } }),
      L({ type: "user", message: { content: "<task-notification>x</task-notification>" } }),
      L({ type: "ai-title", aiTitle: "标题" }),
    ].join("\n");
    expect(lastExchange(t)).toEqual({ ask: "第二问", answer: "第二答", title: "标题" });
  });
});

describe("turn end", () => {
  const line = (stop: string, content: any[]) => JSON.stringify({ type: "assistant", message: { stop_reason: stop, content } });
  test("end_turn with text closes the turn, thinking-only or tool_use does not", () => {
    expect(parseLine(line("end_turn", [{ type: "text", text: "done" }])).map(e => e.kind)).toEqual(["text", "end"]);
    expect(parseLine(line("end_turn", [{ type: "thinking", thinking: "x" }])).map(e => e.kind)).toEqual([]);
    expect(parseLine(line("tool_use", [{ type: "text", text: "checking" }])).map(e => e.kind)).toEqual(["text"]);
  });
});

describe("usage", () => {
  test("parseCtx", () => {
    expect(parseCtx("⛁ 43% (430k)")).toEqual({ text: "43% (430k)", pct: 43 });
    expect(parseCtx(undefined)).toBeUndefined();
  });
  test("left", () => {
    const now = 1_000_000_000_000;
    expect(left(now / 1000 + 4 * 3600 + 600, now)).toBe("4h10m");
    expect(left(now / 1000 + 2 * 86400 + 3600, now)).toBe("2d1h");
    expect(left(undefined, now)).toBe("");
  });
  test("limitsLine reads both files and is empty without them", () => {
    const d = mkdtempSync(join(tmpdir(), "tgb-"));
    const now = 1_000_000_000_000, s = now / 1000;
    writeFileSync(join(d, "u.json"), JSON.stringify({ five_hour: { used_percentage: 7.4, resets_at: s + 3600 }, seven_day: { used_percentage: 24, resets_at: s + 86400 * 4 }, updated_at: s - 600 }));
    writeFileSync(join(d, "f.json"), JSON.stringify({ percent: 2, resets_at: s + 86400 * 4, fetched_at: s - 60 }));
    expect(limitsLine({ usageFile: join(d, "u.json"), fableUsageFile: join(d, "f.json") }, now)).toBe("5h 7%（1h0m 后重置） · 7d 24%（4d0h 后重置） · Fable 2%（4d0h 后重置）");
    expect(limitsLine({}, now)).toBe("");
  });
});
