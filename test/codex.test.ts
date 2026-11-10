import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { codexParser, findTranscript, TranscriptTail } from "../src/transcript";
import { lastExchange } from "../src/lifecycle";
import { codexInstructions, launchArgs } from "../src/providers";
import { loadBackends, newSpec } from "../src/backends";
import { loadConfig } from "../src/config";

const L = (type: string, payload: any) => JSON.stringify({ type, payload });
const message = (role: string, text: string, phase?: string) => L("response_item", {
  type: "message", role, phase, content: [{ type: role === "user" ? "input_text" : "output_text", text }],
});
const done = (text?: string) => L("event_msg", { type: "task_complete", last_agent_message: text });

describe("Codex transcript", () => {
  test("relays the final once despite mirrored events; keeps commentary separate", () => {
    const parse = codexParser();
    const input = [L("event_msg", { type: "task_started" }), message("user", "问题"),
      L("event_msg", { type: "user_message", message: "问题" }),
      message("assistant", "正在检查", "commentary"),
      L("response_item", { type: "function_call", call_id: "x", name: "exec_command", arguments: '{"cmd":"date"}' }),
      L("event_msg", { type: "agent_message", message: "答案" }), message("assistant", "答案", "final_answer"), done("答案")];
    const events = input.flatMap(parse);
    expect(events).toEqual([{ kind: "user", text: "问题" }, { kind: "commentary", text: "正在检查" },
      { kind: "tool", id: "x", name: "Bash", input: { command: "date" } }, { kind: "text", text: "答案" }, { kind: "end" }]);
  });
  test("does not disclose reasoning, instructions, mirrored items, or tool outputs", () => {
    const parse = codexParser();
    const lines = ["broken json", L("session_meta", { secret: "hidden" }), message("developer", "hidden"),
      message("user", "# AGENTS.md instructions for /a/dir\n\n<INSTRUCTIONS>\nhidden\n</INSTRUCTIONS>"),
      message("system", "hidden"), message("assistant", "hidden", "analysis"),
      L("response_item", { type: "reasoning", summary: [{ text: "hidden" }] }),
      L("response_item", { type: "function_call_output", output: "hidden" }),
      L("event_msg", { type: "item_completed", item: { type: "AgentMessage", text: "hidden" } })];
    expect(lines.flatMap(parse)).toEqual([]);
  });
  test("falls back to completed-task answer when no final record exists, and resets each turn", () => {
    const parse = codexParser();
    expect(parse(done("第一答"))).toEqual([{ kind: "text", text: "第一答" }, { kind: "end" }]);
    expect(parse(message("assistant", "第二答", "final"))).toEqual([]);
    expect(parse(done("第二答"))).toEqual([{ kind: "text", text: "第二答" }, { kind: "end" }]);
    parse(L("event_msg", { type: "task_started" }));
    expect(parse(done("第三答"))).toEqual([{ kind: "text", text: "第三答" }, { kind: "end" }]);
  });
  test("an interrupted turn does not fabricate a final answer, nor relay one written before the interruption", () => {
    const parse = codexParser();
    expect(parse(L("event_msg", { type: "turn_aborted" }))).toEqual([{ kind: "end", aborted: true }]);
    expect(parse(done())).toEqual([{ kind: "end" }]);
    expect(parse(message("assistant", "半截回答", "final_answer"))).toEqual([]);
    expect(parse(L("event_msg", { type: "turn_aborted" }))).toEqual([{ kind: "end", aborted: true }]);
    expect(parse(done())).toEqual([{ kind: "end" }]);
  });
  test("final text followed by more work in the same turn is released in order, as before", () => {
    const parse = codexParser();
    expect(parse(message("assistant", "先说一句", "final"))).toEqual([]);
    expect(parse(L("response_item", { type: "function_call", call_id: "x", name: "exec_command", arguments: '{"cmd":"ls"}' })))
      .toEqual([{ kind: "text", text: "先说一句" }, { kind: "tool", id: "x", name: "Bash", input: { command: "ls" } }]);
  });
  test("handoff keeps the last completed question and answer together after interruption", () => {
    const lines = [message("user", "first question"), message("assistant", "first answer", "final"), done("first answer"),
      message("user", "interrupted question"), message("assistant", "checking", "commentary"),
      message("assistant", "partial answer", "final_answer"), L("event_msg", { type: "turn_aborted" })];
    expect(lastExchange(lines.join("\n"), "codex")).toEqual({ ask: "first question", answer: "first answer", title: undefined });
  });
  test("request_user_input becomes AskUserQuestion with its questions intact", () => {
    const questions = [{ header: "语言", id: "language", question: "用哪种语言？", options: [{ label: "Python", description: "d" }] }];
    expect(codexParser()(L("response_item", { type: "function_call", name: "request_user_input", call_id: "q", arguments: JSON.stringify({ questions }) })))
      .toEqual([{ kind: "tool", id: "q", name: "AskUserQuestion", input: { questions } }]);
  });
  test("custom calls do not leak arbitrary non-JSON code into progress", () => {
    expect(codexParser()(L("response_item", { type: "custom_tool_call", name: "exec", input: "secret code", call_id: "x" })))
      .toEqual([{ kind: "tool", id: "x", name: "exec", input: {} }]);
  });
  test("valid JSON with malformed fields cannot discard the following final answer", () => {
    const parse = codexParser();
    expect(parse("null")).toEqual([]);
    expect(parse(L("response_item", { type: "message", role: "assistant", content: [null] }))).toEqual([]);
    expect(parse(L("response_item", { type: "function_call", name: "exec_command", arguments: "null" })))
      .toEqual([{ kind: "tool", id: "", name: "Bash", input: { command: "" } }]);
    parse(message("assistant", "still delivered", "final"));
    expect(parse(done("still delivered"))).toEqual([{ kind: "text", text: "still delivered" }, { kind: "end" }]);
  });
  test("incremental UTF-8 lines preserve parser state across reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "tgb-codex-"));
    try {
      const path = join(dir, "s.jsonl");
      writeFileSync(path, message("assistant", "旧回复", "final") + "\n");
      const tail = new TranscriptTail(path, true, codexParser());
      appendFileSync(path, message("assistant", "新回复", "final") + "\n" + done("新回复").slice(0, 20));
      expect(tail.read()).toEqual([]);
      appendFileSync(path, done("新回复").slice(20) + "\n");
      expect(tail.read()).toEqual([{ kind: "text", text: "新回复" }, { kind: "end" }]);
    } finally { rmSync(dir, { recursive: true }); }
  });
  test("handoff uses only the last completed exchange, excluding intermediate commentary", () => {
    const lines = [message("user", "问题"), message("assistant", "查一下", "commentary"),
      message("assistant", "答案", "final_answer"), done("答案"), message("user", "还未完成的问题")];
    expect(lastExchange(lines.join("\n"), "codex")).toEqual({ ask: "问题", answer: "答案", title: undefined });
  });
});

describe("provider and transcript routing", () => {
  test("finds exact ids across dates and archives, never another session or a traversal", () => {
    const dir = mkdtempSync(join(tmpdir(), "tgb-path-"));
    const roots = { codex: join(dir, "codex"), claude: join(dir, "claude") };
    try {
      const p = join(roots.codex, "sessions/2026/10/16/rollout-2026-10-16T10-00-00-session-a.jsonl");
      mkdirSync(join(roots.codex, "sessions/2026/10/16"), { recursive: true });
      writeFileSync(p, "");
      expect(findTranscript("/same/cwd", "session-a", "codex", roots)).toBe(p);
      expect(findTranscript("/same/cwd", "session-b", "codex", roots)).toBe("");
      expect(findTranscript("/same/cwd", "../session-a", "codex", roots)).toBe("");
      mkdirSync(join(roots.codex, "archived_sessions"));
      const archive = join(roots.codex, "archived_sessions/rollout-old-archived-id.jsonl"); writeFileSync(archive, "");
      expect(findTranscript("/same/cwd", "archived-id", "codex", roots)).toBe(archive);
      const cp = join(roots.claude, "-same-cwd/session-a.jsonl"); mkdirSync(join(roots.claude, "-same-cwd"), { recursive: true }); writeFileSync(cp, "");
      expect(findTranscript("/same/cwd", "session-a", "claude", roots)).toBe(cp);
    } finally { rmSync(dir, { recursive: true }); }
  });
  test("new and resumed Codex receive native args, Claude retains its own flags", () => {
    expect(launchArgs("codex", "s", ["--model", "m"], "prompt", {})).toEqual(["resume", "s", "-c", 'developer_instructions="prompt"', "--model", "m"]);
    expect(launchArgs("codex", undefined, [], "prompt", { own: "Answer in Chinese." })).toEqual(["-c", 'developer_instructions="Answer in Chinese.\\n\\nprompt"']);
    expect(launchArgs("codex", undefined, ["-c", 'developer_instructions="mine"'], "prompt", {})).toEqual(["-c", 'developer_instructions="mine"']);
    expect(launchArgs("codex", "s", [], "prompt", undefined)).toEqual(["resume", "s"]); // Codex could not tell: never replace the user's value
    expect(launchArgs("claude", "s", [], "prompt")).toEqual(["--resume", "s", "--append-system-prompt", "prompt"]);
    const bs = loadBackends({});
    expect(newSpec(["codex", "我的", "会话"], bs, "claude")).toEqual({ backend: "codex", name: "我的 会话" });
    expect(newSpec(["我的会话"], bs, "claude")).toEqual({ backend: "claude", name: "我的会话" });
    expect(newSpec([], bs, "codex")).toEqual({ backend: "codex", name: "" });
  });
  // runs the real Codex CLI offline (debug prompt-input makes no model call) against a throwaway CODEX_HOME
  test.skipIf(!Bun.which("codex"))("the user's developer_instructions are read from Codex itself, whichever layer sets them", async () => {
    // the real path: Codex matches trusted projects against it (/var/folders is /private/var/folders on macOS)
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tgb-codex-home-"))), old = process.env.CODEX_HOME, oldHome = process.env.HOME;
    process.env.CODEX_HOME = home; process.env.HOME = home;
    try {
      expect(await codexInstructions([], home)).toEqual({ own: undefined });
      writeFileSync(join(home, "config.toml"), 'developer_instructions = """\nAnswer in Chinese.\n"""\n');
      expect(await codexInstructions([], home)).toEqual({ own: "Answer in Chinese." });
      writeFileSync(join(home, "work.config.toml"), 'developer_instructions = "work rules"\n');
      expect(await codexInstructions(["--profile", "work"], home)).toEqual({ own: "work rules" });
      mkdirSync(join(home, "proj/.codex"), { recursive: true });
      writeFileSync(join(home, "proj/.codex/config.toml"), 'developer_instructions = "project rules"\n');
      writeFileSync(join(home, "config.toml"), `developer_instructions = "top"\n[projects."${join(home, "proj")}"]\ntrust_level = "trusted"\n`);
      expect(await codexInstructions([], join(home, "proj"))).toEqual({ own: "project rules" });
      expect(await codexInstructions([], home, join(home, "no-such-codex"))).toBeUndefined();
    } finally { process.env.CODEX_HOME = old; process.env.HOME = oldHome; rmSync(home, { recursive: true }); }
  });
  test("default stays Claude; Codex options are split like TG_CLAUDE_ARGS", () => {
    const base = { TELEGRAM_BOT_TOKEN: "test", TG_CHAT_ID: "-1", TG_ALLOWED_USERS: "1", TG_BRIDGE_WORKDIR: "/tmp" };
    expect(loadConfig(base).agentKind).toBe("claude");
    expect(loadConfig({ ...base, TG_AGENT_KIND: "codex", TG_CODEX_ARGS: " --model  m " }).codexArgs).toEqual(["--model", "m"]);
    expect(() => loadConfig({ ...base, TG_AGENT_KIND: "unknown" })).toThrow("claude or codex");
  });
});
