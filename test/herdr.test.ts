import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

// spawnAgent runs in its own bun process: other test files mock ../src/herdr for the whole run.
// `herdr` there is a stand-in on PATH; errors come as JSON on stderr, like the real one.
let dir: string;
const fake = (startReply: string) => writeFileSync(join(dir, "herdr"), `#!/bin/sh
case "$1 $2" in
  "--version ") echo stub-herdr ;;
  "tab create") echo '{"result":{"root_pane":{"pane_id":"p1"},"tab":{"tab_id":"t1"}}}' ;;
  "agent start") ${startReply} ;;
  "agent get") echo '{"result":{"agent":{"agent":"codex","agent_status":"blocked","pane_id":"p1","tab_id":"t1","terminal_id":"term1"}}}' ;;
  "pane close") echo '{"result":{}}' >> "${dir}/closed" ;;
  *) echo '{"result":{}}' ;;
esac
`, { mode: 0o755 });

// a stand-in that knows the workspaces in $dir/ws (one "id label" per line) and logs every create
const fakeWs = (have: string) => {
  writeFileSync(join(dir, "ws"), have);
  writeFileSync(join(dir, "herdr"), `#!/bin/sh
case "$1 $2" in
  "--version ") echo stub-herdr ;;
  "workspace list") printf '{"result":{"workspaces":['; sep=; while read id label; do printf '%s{"workspace_id":"%s","label":"%s"}' "$sep" "$id" "$label"; sep=,; done < "${dir}/ws"; echo ']}}' ;;
  "workspace create") echo "$*" >> "${dir}/created"; echo '{"result":{"workspace":{"workspace_id":"wN"},"root_pane":{"pane_id":"wN:p1"},"tab":{"tab_id":"wN:t1"}}}' ;;
  *) echo '{"result":{}}' ;;
esac
`, { mode: 0o755 });
};

// never reaches the real Herdr: the child checks first that `herdr` is the stand-in, and stops otherwise
async function spawnInChild(call = `spawnAgent({ kind: "codex", cwd: "/tmp", label: "x", agent: "tg-1", args: [] })`): Promise<any> {
  const src = resolve(import.meta.dir, "../src/herdr.ts");
  const code = `import * as H from ${JSON.stringify(src)};
    if (String(await H.herdr("--version")).trim() !== "stub-herdr") { console.log(JSON.stringify({ notStub: true })); process.exit(0); }
    const s = await H.${call};
    console.log(JSON.stringify({ s: s ?? null }));`;
  const p = Bun.spawn(["bun", "-e", code], { cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const r = JSON.parse(out.trim().split("\n").pop()!);
  expect(r.notStub).toBeUndefined();
  return r.s;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tgb-herdr-")); });
afterEach(() => { rmSync(dir, { recursive: true }); });

describe("spawnAgent", () => {
  test("an agent held at a startup screen (Herdr 0.9 agent_not_ready) counts as started, its pane is kept", async () => {
    fake(`echo '{"error":{"code":"agent_not_ready","message":"agent tg-1 is blocked during startup"}}' >&2; exit 1`);
    expect(await spawnInChild()).toEqual({ pane: "p1", tab: "t1", terminal: "term1" });
    expect(await Bun.file(join(dir, "closed")).exists()).toBe(false);
  });
  test("any other error still fails and closes the new tab", async () => {
    fake(`echo '{"error":{"code":"agent_exited","message":"gone"}}' >&2; exit 1`);
    expect(await spawnInChild()).toBeNull();
    expect(await Bun.file(join(dir, "closed")).exists()).toBe(true);
  });
  test("ensureWorkspace: an existing label or id is used as it is; a missing label is created once, an id never", async () => {
    fakeWs("wB Projects\nwE Telegram\n");
    expect(await spawnInChild(`ensureWorkspace("Telegram", "/w")`)).toEqual({ id: "wE" });
    expect(await spawnInChild(`ensureWorkspace("wB", "/w")`)).toEqual({ id: "wB" });
    expect(await Bun.file(join(dir, "created")).exists()).toBe(false);
    fakeWs("wB Projects\n");
    expect(await spawnInChild(`ensureWorkspace("wE", "/w")`)).toEqual({});
    expect(await Bun.file(join(dir, "created")).exists()).toBe(false);
    expect(await spawnInChild(`ensureWorkspace("Telegram", "/w")`)).toEqual({ id: "wN", pane: "wN:p1", tab: "wN:t1" });
    expect((await Bun.file(join(dir, "created")).text()).trim()).toBe("workspace create --label Telegram --cwd /w --no-focus");
    expect(await spawnInChild(`ensureWorkspace(undefined, "/w")`)).toEqual({});
  });
});
