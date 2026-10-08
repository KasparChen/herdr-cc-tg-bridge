// Bridge liveness: online = last getUpdates succeeded within the window AND the Herdr socket answers.
// Shown in three places: a pinned message in the General topic, /status, and a TTL token on the Herdr workspace.
// The pinned message is only ever edited in place; a new one is sent only when Telegram says the old one is gone.
// While abnormal, edits stop after statusPauseAfter beats with nothing changed, until a change or the refresh button.
import type { Config } from "./config";
import * as H from "./herdr";
import { log } from "./log";
import type { Store } from "./store";
import type { Telegram } from "./telegram";
import type { Watcher } from "./session";
import { esc } from "./render";
import { limitsLine } from "./usage";

export type Health = { online: boolean; telegram: boolean; herdr: boolean; lastPollAgoSec: number; sessions: number; working: number; startedAt: number };

const hhmmss = (t = Date.now()) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
const REFRESH = { inline_keyboard: [[{ text: "🔄 刷新", callback_data: "st:refresh" }]] };

export class Status {
  herdrOk = false;
  startedAt = Date.now();
  workspaceId?: string;
  private timer?: Timer;
  private running = false;
  private lastSig = "";
  private streak = 0; // consecutive abnormal beats with the same signature
  paused = false;

  constructor(private cfg: Config, private tg: Telegram, private store: Store, private watchers: Map<number, Watcher>) {}

  health(): Health {
    const ago = this.tg.lastPollOk ? Math.round((Date.now() - this.tg.lastPollOk) / 1000) : -1;
    const telegram = ago >= 0 && ago < this.cfg.onlineWindowSec;
    const ws = [...this.watchers.values()];
    return {
      online: telegram && this.herdrOk, telegram, herdr: this.herdrOk, lastPollAgoSec: ago,
      sessions: ws.length, working: ws.filter(w => w.status === "working" || w.status === "blocked").length, startedAt: this.startedAt,
    };
  }

  text(h = this.health(), paused = false): string {
    const limits = esc(limitsLine(this.cfg));
    const dot = h.online ? "🟢" : "🟡";
    const tgLine = h.telegram ? "正常" : h.lastPollAgoSec < 0 ? "尚未连上" : `${h.lastPollAgoSec}s 没有成功轮询`;
    return [
      `${dot} <b>tg-bridge ${h.online ? "在线" : "异常"}</b>`,
      `Telegram：${tgLine}`,
      `Herdr：${h.herdr ? "正常" : "连不上"}`,
      `会话：${h.sessions} 个，运行中 ${h.working} 个`,
      ...(limits ? [`额度：${limits}`] : []),
      `启动于 ${new Date(h.startedAt).toLocaleString("zh-CN", { hour12: false })}`,
      paused
        ? `<i>更新于 ${hhmmss()}。连续 ${this.streak} 次异常且没有变化，已停止自动刷新；状态一变会自动恢复，也可以点下面的按钮刷新</i>`
        : `<i>更新于 ${hhmmss()}，超过 ${Math.ceil((this.cfg.statusIntervalSec * 3) / 60)} 分钟没更新就是 bridge 或电脑已离线</i>`,
    ].join("\n");
  }

  start() {
    const run = () => this.beat().catch(e => log("status", e));
    run();
    this.timer = setInterval(run, this.cfg.statusIntervalSec * 1000);
  }

  // manual = the refresh button: edits even while paused. One beat at a time; a beat stuck on the network
  // used to overlap the next ones, and each of them sent its own replacement message.
  async beat(manual = false) {
    if (this.running) return;
    this.running = true;
    try {
      this.herdrOk = (await H.workspaces()) !== undefined;
      if (this.cfg.workspace && !this.workspaceId) this.workspaceId = await H.resolveWorkspace(this.cfg.workspace);
      const h = this.health();
      if (this.workspaceId) {
        await H.workspaceToken(this.workspaceId, "tg", h.online ? `🟢 ${h.sessions}` : "🟡", this.cfg.statusIntervalSec * 3 * 1000);
      }
      const sig = [h.online, h.telegram, h.herdr, h.sessions, h.working].join();
      const changed = sig !== this.lastSig;
      this.lastSig = sig;
      this.streak = h.online ? 0 : changed ? 1 : this.streak + 1;
      if (this.paused && !changed && !manual) return;
      const pause = !h.online && this.streak >= this.cfg.statusPauseAfter;
      if (pause !== this.paused) log("status", pause ? `auto refresh paused after ${this.streak} unchanged abnormal beats` : "auto refresh resumed");
      this.paused = pause;
      await this.pin(this.text(h, pause));
    } finally {
      this.running = false;
    }
  }

  private async pin(html: string) {
    const id = this.store.state.statusMessage;
    if (id && (await this.tg.edit(id, html, { reply_markup: REFRESH }))) return;
    const nid = await this.tg.send(undefined, html, { disable_notification: true, reply_markup: REFRESH });
    if (!nid) return;
    log("status", `status message ${id ?? "(none)"} gone, sent ${nid}`);
    this.store.state.statusMessage = nid;
    this.store.save();
    await this.tg.call("pinChatMessage", { chat_id: this.tg.chatId, message_id: nid, disable_notification: true });
  }

  async offline(reason: string) {
    clearInterval(this.timer);
    if (this.workspaceId) await H.clearWorkspaceToken(this.workspaceId, "tg");
    const id = this.store.state.statusMessage;
    const html = `🔴 <b>tg-bridge 已停止</b>\n原因：${reason}\n<i>${hhmmss()}</i>`;
    if (id) await this.tg.edit(id, html);
  }
}
