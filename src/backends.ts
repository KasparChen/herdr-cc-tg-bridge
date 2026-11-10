// Backends: named ways to start a session. `claude` and `codex` are Herdr's own agents; custom ones (e.g. a wrapper
// that points Claude Code at another gateway) are shell commands from .env, run in the pane and then named for Herdr.
import { homedir } from "os";
import type { AgentKind } from "./providers";
import type { Binding } from "./store";

export type Backend = {
  name: string;
  kind: AgentKind;  // argument format and where the transcript lives
  cmd?: string;     // custom: shell text run in the pane; built-ins use `herdr agent start --kind`
  baseUrl?: string; // custom Claude backends: an ANTHROPIC_BASE_URL equal to this marks a desktop session as this backend
  keyFile?: string; // custom: file holding the API key the command uses; only its last 4 characters are ever shown
  color: number;    // topic icon colour (Telegram accepts only these six)
};

const COLORS = { blue: 7322096, yellow: 16766590, violet: 13338331, green: 9367192, rose: 16749490, red: 16478047 };
const CUSTOM_COLORS = [COLORS.violet, COLORS.blue, COLORS.rose, COLORS.red];
const NAME = /^[a-z][a-z0-9_-]{0,15}$/;

export function loadBackends(env: Record<string, string | undefined>): Backend[] {
  const out: Backend[] = [
    { name: "claude", kind: "claude", color: COLORS.yellow },
    { name: "codex", kind: "codex", color: COLORS.green },
  ];
  const names = (env.TG_BACKENDS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  names.forEach((name, i) => {
    if (!NAME.test(name)) throw new Error(`TG_BACKENDS: "${name}" is not a valid name (a-z, 0-9, - and _, starting with a letter)`);
    if (out.some(b => b.name === name)) throw new Error(`TG_BACKENDS: "${name}" is already defined`);
    const key = `TG_BACKEND_${name.toUpperCase().replace(/-/g, "_")}`;
    const cmd = env[`${key}_CMD`]?.trim();
    if (!cmd) throw new Error(`${key}_CMD is missing: the command that starts the "${name}" backend`);
    const kind = (env[`${key}_KIND`]?.trim() || "claude") as AgentKind;
    if (kind !== "claude" && kind !== "codex") throw new Error(`${key}_KIND must be claude or codex`);
    const keyFile = env[`${key}_KEY_FILE`]?.trim().replace(/^~(?=\/|$)/, homedir()) || undefined;
    out.push({ name, kind, cmd, baseUrl: env[`${key}_BASE_URL`]?.trim() || undefined, keyFile, color: CUSTOM_COLORS[i % CUSTOM_COLORS.length] });
  });
  return out;
}

// The backend a binding runs on. Bindings from before v4 have none: Codex ones are `codex`, everything else `claude`.
export const backendName = (b?: Pick<Binding, "backend" | "kind">) => b?.backend ?? (b?.kind === "codex" ? "codex" : "claude");

// `/new gw my topic` -> gw + "my topic"; a first word that is no backend name is part of the name.
export function newSpec(args: string[], backends: Backend[], fallback: string) {
  const hit = backends.find(b => b.name === args[0]?.toLowerCase());
  return { backend: hit?.name ?? fallback, name: (hit ? args.slice(1) : args).join(" ") };
}

// A desktop Claude session started through a custom backend is told apart by the gateway its environment points at.
export function detectBackend(backends: Backend[], kind: AgentKind, baseUrl?: string): string {
  const norm = (u?: string) => u?.trim().replace(/\/+$/, "");
  const hit = baseUrl && backends.find(b => b.kind === kind && b.baseUrl && norm(b.baseUrl) === norm(baseUrl));
  return hit ? hit.name : kind;
}

// POSIX shell quoting: `herdr pane run` types the command as given, so every argument is quoted here.
export const shq = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
