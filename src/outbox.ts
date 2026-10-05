// Which files a turn produced that should go back to Telegram automatically.
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Config } from "./config";

export function pickOutbox(paths: string[], cfg: Pick<Config, "autosendExt" | "stateDir">): string[] {
  const claudeDir = join(homedir(), ".claude");
  const seen = new Set<string>();
  return paths.filter(p => {
    if (seen.has(p)) return false;
    seen.add(p);
    if (p.startsWith(claudeDir) || p.startsWith(cfg.stateDir)) return false;
    if (/\/(\.git|node_modules)\//.test(p)) return false;
    const ext = p.split(".").pop()?.toLowerCase() ?? "";
    if (!cfg.autosendExt.has(ext)) return false;
    return existsSync(p) && statSync(p).isFile();
  });
}
