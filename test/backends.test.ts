import { describe, expect, test } from "bun:test";
import { backendName, detectBackend, loadBackends, newSpec, shq } from "../src/backends";
import { loadConfig } from "../src/config";

const base = { TELEGRAM_BOT_TOKEN: "test", TG_CHAT_ID: "-1", TG_ALLOWED_USERS: "1", TG_BRIDGE_WORKDIR: "/tmp" };
const gw = { TG_BACKENDS: "gw", TG_BACKEND_GW_CMD: "claude-gw", TG_BACKEND_GW_BASE_URL: "https://gw.example/" };

describe("backends", () => {
  test("built-ins plus custom ones from .env, each with a topic colour", () => {
    const bs = loadBackends({ ...gw, TG_BACKENDS: "gw, my-codex", TG_BACKEND_MY_CODEX_CMD: "codex --profile x", TG_BACKEND_MY_CODEX_KIND: "codex" });
    expect(bs.map(b => [b.name, b.kind, b.cmd])).toEqual([["claude", "claude", undefined], ["codex", "codex", undefined], ["gw", "claude", "claude-gw"], ["my-codex", "codex", "codex --profile x"]]);
    expect(new Set(bs.map(b => b.color)).size).toBe(4);
  });
  test("bad custom backends stop the bridge at start with the reason", () => {
    expect(() => loadBackends({ TG_BACKENDS: "Gw!" })).toThrow("not a valid name");
    expect(() => loadBackends({ TG_BACKENDS: "claude" })).toThrow("already defined");
    expect(() => loadBackends({ TG_BACKENDS: "gw" })).toThrow("TG_BACKEND_GW_CMD");
    expect(() => loadBackends({ ...gw, TG_BACKEND_GW_KIND: "gemini" })).toThrow("claude or codex");
  });
  test("default backend: TG_DEFAULT_BACKEND, else TG_AGENT_KIND, else claude; an unknown one is refused", () => {
    expect(loadConfig(base).defaultBackend).toBe("claude");
    expect(loadConfig({ ...base, TG_AGENT_KIND: "codex" }).defaultBackend).toBe("codex");
    expect(loadConfig({ ...base, ...gw, TG_AGENT_KIND: "codex", TG_DEFAULT_BACKEND: "Gw" }).defaultBackend).toBe("gw");
    expect(() => loadConfig({ ...base, TG_DEFAULT_BACKEND: "gw" })).toThrow('no backend named "gw"');
  });
  test("/new picks a backend only when the first word names one", () => {
    const bs = loadBackends(gw);
    expect(newSpec(["GW", "周报"], bs, "claude")).toEqual({ backend: "gw", name: "周报" });
    expect(newSpec(["gwx", "周报"], bs, "codex")).toEqual({ backend: "codex", name: "gwx 周报" });
  });
  test("a desktop Claude session is told apart by its gateway; old bindings keep their kind", () => {
    const bs = loadBackends(gw);
    expect(detectBackend(bs, "claude", "https://gw.example")).toBe("gw");
    expect(detectBackend(bs, "claude", undefined)).toBe("claude");
    expect(detectBackend(bs, "claude", "https://api.anthropic.com")).toBe("claude");
    expect(detectBackend(bs, "codex", "https://gw.example")).toBe("codex");
    expect(backendName({})).toBe("claude");
    expect(backendName({ kind: "codex" })).toBe("codex");
    expect(backendName({ kind: "claude", backend: "gw" })).toBe("gw");
  });
  test("arguments survive the shell the way they were given", async () => {
    const args = ["--append-system-prompt", "It's a \"phone\"; run: tg-send <path> [$HOME]", "line1\nline2", "plain-arg"];
    const p = Bun.spawn(["sh", "-c", `printf '%s\\0' ${args.map(shq).join(" ")}`], { stdout: "pipe" });
    const out = await new Response(p.stdout).text();
    expect(out.split("\0").slice(0, -1)).toEqual(args);
  });
});
