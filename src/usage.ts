// Context and plan-limit figures for display. Context comes from the Herdr agent token that Claude Code's
// integration reports ("⛁ 43% (430k)"); plan limits come from optional JSON files the user's status line keeps fresh.
import { existsSync, readFileSync } from "fs";
import type { Config } from "./config";

export type Ctx = { text: string; pct?: number };

export function parseCtx(token?: string): Ctx | undefined {
  if (!token) return;
  const text = token.replace(/^[^\w\d]+/u, "").trim(); // drop the "⛁ " glyph
  const m = text.match(/(\d+(?:\.\d+)?)%/);
  return { text, pct: m ? Number(m[1]) : undefined };
}

const readJson = (p?: string): any => {
  if (!p || !existsSync(p)) return;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch {}
};

export const left = (resetsAt: number | undefined, now = Date.now()) => {
  if (!resetsAt) return "";
  const s = Math.max(0, Math.round(resetsAt - now / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d${h}h` : h ? `${h}h${m}m` : `${m}m`;
};

// "5h 7%（4h10m 后重置）· 7d 24%（4d1h）· Fable 2%（4d1h）· 更新于 3 分钟前", or "" when nothing is configured
export function limitsLine(cfg: Pick<Config, "usageFile" | "fableUsageFile">, now = Date.now()): string {
  const u = readJson(cfg.usageFile);
  const f = readJson(cfg.fableUsageFile);
  const parts: string[] = [];
  const seg = (name: string, pct: unknown, reset?: number) => {
    if (typeof pct !== "number") return;
    const l = left(reset, now);
    parts.push(`${name} ${Math.round(pct)}%${l ? `（${l} 后重置）` : ""}`);
  };
  seg("5h", u?.five_hour?.used_percentage, u?.five_hour?.resets_at);
  seg("7d", u?.seven_day?.used_percentage, u?.seven_day?.resets_at);
  seg("Fable", f?.percent, f?.resets_at);
  if (!parts.length) return "";
  const at = Math.max(u?.updated_at ?? 0, f?.fetched_at ?? 0);
  const mins = at ? Math.floor((now / 1000 - at) / 60) : -1;
  return parts.join(" · ") + (mins >= 2 ? ` · 更新于 ${mins} 分钟前` : "");
}
