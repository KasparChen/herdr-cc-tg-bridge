// /config: a control panel in one message, edited in place. Home shows the state; buttons open the default backend
// and each backend's details, every page has a way back, and the panel collapses to one line.
// Callback data: pn:<page>[:<arg>]  pages: home, def, list, be:<name>, set:<name>:<back>, fold
import { readFileSync } from "fs";
import type { Config } from "./config";
import { backendName, type Backend } from "./backends";
import type { Lifecycle } from "./lifecycle";
import { cut, esc } from "./render";
import type { Status } from "./status";
import type { Store } from "./store";
import { limitsLine } from "./usage";
import { locale, tr } from "./i18n";

export type View = { html: string; keyboard: any[][] };
const btn = (text: string, data: string) => ({ text, callback_data: data });
const BACK = (to = "home") => btn(tr("« 返回", "« Back"), `pn:${to}`);
const now = () => new Date().toLocaleTimeString(locale(), { hour12: false });

// "••••a1b2 (40 chars)": enough to tell keys apart, never enough to use one
export function maskKey(file?: string): string | undefined {
  if (!file) return;
  try {
    const k = readFileSync(file, "utf8").trim();
    return k ? `••••${k.slice(-4)}${tr(`（共 ${k.length} 位）`, ` (${k.length} chars)`)}` : tr("文件是空的", "file is empty");
  } catch { return tr("读不到 key 文件", "cannot read the key file"); }
}

export class Panel {
  constructor(private cfg: Config, private store: Store, private life: Lifecycle, private status?: Pick<Status, "health">) {}

  // open sessions per backend, e.g. "gw 3 · codex 1"
  private counts(): { open: number; by: string } {
    const n = new Map<string, number>();
    for (const b of Object.values(this.store.state.topics)) if (!b.closedAt) n.set(backendName(b), (n.get(backendName(b)) ?? 0) + 1);
    return { open: [...n.values()].reduce((a, c) => a + c, 0), by: [...n].map(([k, v]) => `${esc(k)} ${v}`).join(" · ") };
  }

  private endpoint(b: Backend): string {
    if (b.baseUrl) return `<code>${esc(b.baseUrl)}</code>`;
    if (b.name === "claude") return tr("Anthropic 官方（订阅登录）", "Anthropic (subscription login)");
    if (b.name === "codex") return tr("OpenAI（Codex 自己的登录）", "OpenAI (Codex's own login)");
    return tr("由启动命令自己决定", "whatever the command uses");
  }

  private key(b: Backend): string {
    if (!b.cmd) return tr("不用 key，用登录状态", "no key, uses the login");
    const k = maskKey(b.keyFile);
    return k ? `<code>${esc(k)}</code>` : tr(`未设置（<code>TG_BACKEND_${esc(b.name.toUpperCase().replace(/-/g, "_"))}_KEY_FILE</code>）`, `not set (<code>TG_BACKEND_${esc(b.name.toUpperCase().replace(/-/g, "_"))}_KEY_FILE</code>)`);
  }

  private details(b: Backend): string[] {
    const n = Object.values(this.store.state.topics).filter(t => backendName(t) === b.name);
    return [
      `${tr("端点名称", "Name")}${tr("：", ": ")}<b>${esc(b.name)}</b>`,
      `${tr("类型", "Kind")}${tr("：", ": ")}${b.kind === "codex" ? "Codex" : "Claude Code"}`,
      `${tr("启动", "Starts with")}${tr("：", ": ")}${b.cmd ? `<code>${esc(cut(b.cmd, 60))}</code>` : tr(`Herdr 内置 <code>${b.kind}</code>`, `Herdr's own <code>${b.kind}</code>`)}`,
      `${tr("网关", "Endpoint")}${tr("：", ": ")}${this.endpoint(b)}`,
      `API key${tr("：", ": ")}${this.key(b)}`,
      tr(`话题：${n.filter(t => !t.closedAt).length} 个开着，共 ${n.length} 个`, `Topics: ${n.filter(t => !t.closedAt).length} open, ${n.length} in all`),
    ];
  }

  view(page = "home", arg?: string, note?: string): View {
    const cur = this.life.defaultBackend();
    const head = (t: string) => [`⚙️ <b>${t}</b>`, ...(note ? [note] : [])];
    const foot = `<i>${tr(`更新于 ${now()}`, `Updated ${now()}`)}</i>`;
    if (page === "fold") return {
      html: tr(`⚙️ 控制面板已收起 · 默认端点 <b>${esc(cur)}</b>`, `⚙️ Panel closed · default <b>${esc(cur)}</b>`),
      keyboard: [[btn(tr("⚙️ 展开", "⚙️ Open"), "pn:home")]],
    };
    if (page === "def") {
      const b = this.life.backend(cur)!;
      const others = this.cfg.backends.filter(x => x.name !== cur);
      return {
        html: [...head(tr("默认端点", "Default backend")),
          tr("<code>/new 名字</code> 和客户端里新建的话题用它", "Used by <code>/new name</code> and topics created in the client"), "",
          ...this.details(b), "", others.length ? tr("切换为：", "Switch to:") : tr("没有其他端点", "No other backend"), foot].join("\n"),
        keyboard: [...(others.length ? [others.map(x => btn(x.name, `pn:set:${x.name}:def`))] : []), [BACK()]],
      };
    }
    if (page === "list") return {
      html: [...head(tr("全部端点", "Backends")),
        ...this.cfg.backends.map(b => `${b.name === cur ? "✅" : "▫️"} <b>${esc(b.name)}</b> · ${b.kind === "codex" ? "Codex" : "Claude Code"} · ${this.endpoint(b)}`),
        tr("点一个看详情", "Tap one for details"), foot].join("\n"),
      keyboard: [...this.cfg.backends.map(b => [btn(`${b.name === cur ? "✅ " : ""}${b.name}`, `pn:be:${b.name}`)]), [BACK()]],
    };
    if (page === "be") {
      const b = this.life.backend(arg);
      if (!b) return this.view("list", undefined, tr(`⚠️ 没有叫 ${esc(arg ?? "")} 的端点了`, `⚠️ No backend named ${esc(arg ?? "")} any more`));
      return {
        html: [...head(tr(`端点 ${esc(b.name)}`, `Backend ${esc(b.name)}`)), ...this.details(b),
          b.name === cur ? tr("✅ 这是默认端点", "✅ This is the default") : "", foot].filter(Boolean).join("\n"),
        keyboard: [...(b.name === cur ? [] : [[btn(tr("设为默认", "Make default"), `pn:set:${b.name}:be`)]]), [BACK("list")]],
      };
    }
    // home
    const h = this.status?.health?.();
    const c = this.counts();
    const limits = esc(limitsLine(this.cfg));
    return {
      html: [...head(tr("tg-bridge 控制面板", "tg-bridge panel")),
        h ? `${h.online ? "🟢" : "🟡"} ${h.online ? tr("在线", "online") : tr("异常", "degraded")} · Telegram ${h.telegram ? tr("正常", "OK") : tr("异常", "down")} · Herdr ${h.herdr ? tr("正常", "OK") : tr("连不上", "unreachable")}` : "",
        tr(`默认端点：<b>${esc(cur)}</b>`, `Default backend: <b>${esc(cur)}</b>`),
        tr(`端点：${this.cfg.backends.map(b => esc(b.name)).join("、")}`, `Backends: ${this.cfg.backends.map(b => esc(b.name)).join(", ")}`),
        tr(`话题：${c.open} 个开着${c.by ? `（${c.by}）` : ""}${h ? `，运行中 ${h.working} 个` : ""}`, `Topics: ${c.open} open${c.by ? ` (${c.by})` : ""}${h ? `, ${h.working} running` : ""}`),
        ...(limits ? [tr(`额度：${limits}`, `Limits: ${limits}`)] : []), foot].filter(Boolean).join("\n"),
      keyboard: [
        [btn(tr("⭐ 默认端点", "⭐ Default backend"), "pn:def"), btn(tr("🧩 全部端点", "🧩 Backends"), "pn:list")],
        [btn(tr("🔄 刷新", "🔄 Refresh"), "pn:home"), btn(tr("✖ 收起", "✖ Close"), "pn:fold")],
      ],
    };
  }

  // a button press: change what it asks for, then the page to show in the same message
  press(data: string): View {
    const [, page = "home", a, back] = data.split(":");
    if (page === "set") {
      const ok = this.life.setDefaultBackend(a);
      const note = ok ? tr(`✅ 默认端点已切换为 <b>${esc(a)}</b>`, `✅ Default backend is now <b>${esc(a)}</b>`) : tr(`⚠️ 没有叫 ${esc(a)} 的端点`, `⚠️ No backend named ${esc(a)}`);
      return back === "be" ? this.view("be", a, note) : this.view("def", undefined, note);
    }
    return this.view(page, a);
  }
}
