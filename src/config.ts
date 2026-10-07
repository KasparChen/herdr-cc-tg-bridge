// All personal values come from the environment; see .env.example.
import { homedir } from "os";
import { join, resolve } from "path";

export type Config = {
  token: string;
  chatId: number;
  allowedUsers: Set<number>;
  workdir: string;
  workspace?: string; // Herdr workspace id or label for new sessions
  stateDir: string;
  port: number;
  sim: boolean;
  autosendExt: Set<string>;
  claudeArgs: string[];
  statusIntervalSec: number;
  onlineWindowSec: number;
  usageFile?: string;     // JSON with five_hour / seven_day used_percentage + resets_at (Claude Code status line data)
  fableUsageFile?: string; // JSON with percent + resets_at for a per-model weekly limit
};

const DEFAULT_EXT = "png,jpg,jpeg,gif,webp,svg,pdf,docx,doc,xlsx,xls,pptx,ppt,csv,zip,tar,gz,html,mp4,mov,mp3,wav,m4a";

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing: string[] = [];
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) missing.push(k);
    return v ?? "";
  };
  const token = need("TELEGRAM_BOT_TOKEN");
  const chat = need("TG_CHAT_ID");
  const users = need("TG_ALLOWED_USERS");
  const workdir = need("TG_BRIDGE_WORKDIR");
  if (missing.length) throw new Error(`missing required config: ${missing.join(", ")} (see .env.example)`);
  const expand = (p: string) => resolve(p.replace(/^~(?=\/|$)/, homedir()));
  return {
    token,
    chatId: Number(chat),
    allowedUsers: new Set(users.split(",").map(s => Number(s.trim())).filter(Boolean)),
    workdir: expand(workdir),
    workspace: env.HERDR_WORKSPACE?.trim() || undefined,
    stateDir: expand(env.TG_BRIDGE_STATE_DIR?.trim() || join(homedir(), ".tg-bridge")),
    port: Number(env.TG_BRIDGE_PORT ?? 18820),
    sim: env.TG_BRIDGE_SIM === "1",
    autosendExt: new Set((env.TG_AUTOSEND_EXT ?? DEFAULT_EXT).split(",").map(s => s.trim().toLowerCase().replace(/^\./, "")).filter(Boolean)),
    claudeArgs: (env.TG_CLAUDE_ARGS ?? "").split(/\s+/).filter(Boolean),
    statusIntervalSec: Number(env.TG_STATUS_INTERVAL ?? 30),
    onlineWindowSec: Number(env.TG_ONLINE_WINDOW ?? 90),
    usageFile: env.TG_USAGE_FILE?.trim() ? expand(env.TG_USAGE_FILE.trim()) : undefined,
    fableUsageFile: env.TG_FABLE_USAGE_FILE?.trim() ? expand(env.TG_FABLE_USAGE_FILE.trim()) : undefined,
  };
}
