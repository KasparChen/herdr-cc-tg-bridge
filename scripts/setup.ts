// Telegram side of install.sh: check the token, find the group and the user, check the bot's rights, write .env.
// Run by install.sh with stdin on the terminal. Input comes from the environment, never argv (argv shows up in ps):
//   TG_SETUP_TOKEN   bot token (required)
//   TG_SETUP_LANG    zh | en
//   TG_SETUP_ROOT    project directory, .env is written there
//   TG_SETUP_WORKSPACE  Herdr workspace label written as HERDR_WORKSPACE
//   TG_API_BASE      Bot API base URL (tests point it at a mock server)
//   TG_SETUP_CODE    fixed one-time code (tests only)
// Exit codes: 0 done, 2 token rejected (install.sh asks again), 1 anything else.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const zh = process.env.TG_SETUP_LANG === "zh";
const t = (cn: string, en: string) => (zh ? cn : en);
const token = process.env.TG_SETUP_TOKEN ?? "";
const root = process.env.TG_SETUP_ROOT ?? process.cwd();
const workspace = process.env.TG_SETUP_WORKSPACE ?? "Telegram";
const base = (process.env.TG_API_BASE ?? "https://api.telegram.org").replace(/\/$/, "");
const envFile = join(root, ".env");

const say = (s = "") => console.log(s);
const ok = (s: string) => say(`  ✓ ${s}`);
const bad = (s: string) => say(`  ✗ ${s}`);
const ask = (q: string, def = "") => (prompt(`  ${q}${def ? ` [${def}]` : ""}`) ?? "").trim() || def;
const yes = (q: string, def = true) => /^(y|yes|是|好)?$/i.test(ask(`${q} ${def ? "[Y/n]" : "[y/N]"}`, def ? "" : "n"));

async function api(method: string, body: Record<string, unknown> = {}): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${base}/bot${token}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(40000),
      });
      return await r.json();
    } catch (e) {
      if (i >= 2) return { ok: false, description: `network: ${String(e).slice(0, 100)}` };
      await Bun.sleep(2000);
    }
  }
}

function readEnv(): Record<string, string> {
  if (!existsSync(envFile)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const RIGHTS: [string, string, string][] = [
  ["can_manage_topics", "管理话题（Manage Topics）", "Manage Topics"],
  ["can_pin_messages", "置顶消息（Pin Messages）", "Pin Messages"],
  ["can_delete_messages", "删除消息（Delete Messages）", "Delete Messages"],
];

// true when the group is a forum and the bot is an admin with every right the bridge uses
async function checkGroup(chatId: number, botId: number): Promise<boolean> {
  const chat = await api("getChat", { chat_id: chatId });
  if (!chat.ok) { bad(t(`读不到这个群：${chat.description}`, `Cannot read the group: ${chat.description}`)); return false; }
  if (!chat.result.is_forum) { bad(t("群里还没开「话题」（Topics）", "Topics are not enabled in the group")); return false; }
  const me = await api("getChatMember", { chat_id: chatId, user_id: botId });
  const m = me.result ?? {};
  if (m.status !== "administrator") { bad(t("bot 还不是这个群的管理员", "The bot is not an admin of the group yet")); return false; }
  const missing = RIGHTS.filter(([k]) => !m[k]);
  for (const [, cn, en] of missing) bad(t(`bot 缺少管理员权限：${cn}`, `The bot lacks the admin right: ${en}`));
  return missing.length === 0;
}

async function waitForRights(chatId: number, botId: number) {
  while (!(await checkGroup(chatId, botId))) {
    say(t("  在群设置里改好后回车，我再查一次（Ctrl+C 退出）", "  Fix it in the group settings, then press Enter to check again (Ctrl+C to quit)"));
    prompt("");
  }
  ok(t("群已开话题，bot 是管理员且权限齐全", "Topics are on, and the bot is an admin with every right it needs"));
}

// Wait for "/start <code>" in a forum supergroup; returns the group and the sender. Updates queued before the
// installer started are dropped first, and only a message carrying this run's code counts, so a bot that already
// sits in other groups can never make someone else the owner.
async function discover(code: string): Promise<{ chatId: number; title: string; userId: number; userName: string; offset: number }> {
  const drop = await api("getUpdates", { offset: -1, timeout: 0 });
  let offset = drop.ok && drop.result.length ? drop.result[0].update_id + 1 : 0;
  const deadline = Date.now() + 15 * 60_000;
  const warned = new Set<number>();
  while (Date.now() < deadline) {
    const j = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
    if (!j.ok) {
      if (/Conflict/i.test(j.description ?? "")) throw new Error(t("另一个程序正在用这个 bot 收消息（可能是已经在跑的 bridge），先停掉它再重跑安装", "Another program is reading this bot's updates (perhaps a bridge already running). Stop it and run the installer again"));
      bad(j.description); await Bun.sleep(3000); continue;
    }
    for (const u of j.result) {
      offset = u.update_id + 1;
      const m = u.message;
      if (!m?.chat) continue;
      if (m.chat.type === "private") { say(t("  这是私聊消息。要在群里发，不是发给 bot 私聊", "  That was a private chat. Send it in the group, not to the bot directly")); continue; }
      if (!String(m.text ?? "").split(/\s+/).includes(code)) {
        if (!warned.has(-m.chat.id)) { warned.add(-m.chat.id); say(t(`  收到一条消息，但里面没有口令 ${code}，跳过`, `  Got a message without the code ${code}; skipped`)); }
        continue;
      }
      const c = m.chat;
      if (c.type === "private") { say(t("  这是私聊消息。要在群里发，不是发给 bot 私聊", "  That was a private chat. Send it in the group, not to the bot directly")); continue; }
      if (c.type !== "supergroup" || !c.is_forum) {
        if (!warned.has(c.id)) { warned.add(c.id); say(t(`  收到群「${c.title}」的消息，但它还没开话题。先在群设置里打开「话题」，再发一次`, `  Got a message from "${c.title}", but Topics are off there. Turn on Topics in the group settings, then send it again`)); }
        continue;
      }
      if (!m.from || m.from.is_bot || m.sender_chat) { say(t("  这条消息是匿名管理员发的，看不出是谁。请关掉「匿名发言」后再发一次", "  That message was sent anonymously, so the sender is unknown. Turn off \"Remain anonymous\" and send it again")); continue; }
      const userName = m.from.username ? `@${m.from.username}` : [m.from.first_name, m.from.last_name].filter(Boolean).join(" ");
      return { chatId: c.id, title: c.title, userId: m.from.id, userName, offset };
    }
  }
  throw new Error(t("15 分钟内没等到群里的消息，重跑安装即可", "No message from the group within 15 minutes. Run the installer again"));
}

// Claude Code does not remember trusting the home directory itself and asks again on every start, which would stop
// every new session at that prompt; any folder below it is remembered once trusted.
function askWorkdir(def: string): string {
  for (;;) {
    const raw = ask(t("新会话的工作目录（Claude 从这里读 CLAUDE.md，不存在会自动创建）", "Working directory for new sessions (Claude reads CLAUDE.md there; created if missing)"), def);
    const abs = resolve(raw.replace(/^~(?=\/|$)/, homedir()));
    if (abs === homedir() || abs === "/") { bad(t("不能直接用家目录或根目录：Claude Code 每次启动都会重新问是否信任它，会话会卡住。换一个子目录", "Not the home or root directory: Claude Code asks again on every start whether to trust it, and sessions would stall there. Pick a folder inside it")); continue; }
    try { mkdirSync(abs, { recursive: true }); } catch (e) { bad(String(e)); continue; }
    return raw;
  }
}

async function main() {
  say();
  const me = await api("getMe");
  if (!me.ok) {
    bad(t(`token 无效：${me.description}`, `Invalid token: ${me.description}`));
    process.exit(/network/.test(me.description ?? "") ? 1 : 2);
  }
  const bot = me.result;
  ok(t(`bot：@${bot.username}`, `Bot: @${bot.username}`));

  const hook = await api("getWebhookInfo");
  if (hook.result?.url) {
    say(t(`  这个 bot 设置了 webhook（${hook.result.url}），bridge 用轮询收消息，两者不能同时用。`, `  This bot has a webhook (${hook.result.url}). The bridge polls for updates, and the two cannot be used together.`));
    if (!yes(t("删除这个 webhook？", "Delete the webhook?"))) throw new Error(t("保留 webhook 就没法用 bridge", "The bridge cannot run while the webhook is set"));
    await api("deleteWebhook");
    ok(t("webhook 已删除", "Webhook deleted"));
  }

  const old = readEnv();
  let chatId: number, userId: number;
  if (old.TELEGRAM_BOT_TOKEN === token && old.TG_CHAT_ID && old.TG_ALLOWED_USERS
      && yes(t(`发现已有配置（群 ${old.TG_CHAT_ID}），继续用它？`, `Found an existing setup (group ${old.TG_CHAT_ID}). Keep it?`))) {
    chatId = Number(old.TG_CHAT_ID);
    userId = Number(old.TG_ALLOWED_USERS.split(",")[0]);
    await waitForRights(chatId, bot.id);
  } else {
    say();
    say(t("  接下来在 Telegram 里建群，按顺序做：", "  Now set up the group in Telegram, in this order:"));
    say(t(`    1. 新建一个群，成员里加上 @${bot.username}（Telegram 建群至少要加一个成员）`, `    1. Create a new group and add @${bot.username} as a member (Telegram needs at least one member to create a group)`));
    say(t("    2. 群设置 > 打开「话题」（Topics）", "    2. Group settings > turn on Topics"));
    say(t(`    3. 群设置 > 管理员 > 添加 @${bot.username}，勾选「管理话题」「置顶消息」「删除消息」`, `    3. Group settings > Administrators > add @${bot.username} with Manage Topics, Pin Messages and Delete Messages`));
    const code = process.env.TG_SETUP_CODE ?? String(100000 + Math.floor(Math.random() * 900000));
    say(t(`    4. 在群里发 /start@${bot.username} ${code}（${code} 是这次安装的口令）`, `    4. Send /start@${bot.username} ${code} in the group (${code} is this install's code)`));
    say();
    say(t("  等你在群里发消息……", "  Waiting for your message in the group..."));
    const found = await discover(code);
    say();
    say(t(`  群：${found.title}`, `  Group: ${found.title}`));
    say(t(`  账号：${found.userName}`, `  Account: ${found.userName}`));
    say(t("  这个账号将能在这个群里通过 Telegram 使用这台电脑上的 Claude Code，相当于能在这台电脑上执行命令。别人发的消息 bridge 一律不理。",
          "  This account will be able to use Claude Code on this computer from this group, which amounts to running commands on it. The bridge ignores everyone else."));
    if (!yes(t("这是你本人的账号和你刚建的群？", "Is this your own account and the group you just made?"), false)) throw new Error(t("已取消，没有写入配置", "Cancelled; nothing was written"));
    chatId = found.chatId;
    userId = found.userId;
    await waitForRights(chatId, bot.id);
    // confirm what was read, so the bridge does not answer the /start again when it starts
    await api("getUpdates", { offset: found.offset, timeout: 0 });
  }

  say();
  const workdir = askWorkdir(old.TG_BRIDGE_WORKDIR || "~/tg-sessions");
  const values: Record<string, string> = {
    ...old,
    TELEGRAM_BOT_TOKEN: token,
    TG_CHAT_ID: String(chatId),
    TG_ALLOWED_USERS: old.TG_CHAT_ID === String(chatId) && old.TG_ALLOWED_USERS ? old.TG_ALLOWED_USERS : String(userId),
    TG_BRIDGE_WORKDIR: workdir,
    HERDR_WORKSPACE: old.HERDR_WORKSPACE || workspace,
    TG_BRIDGE_LANG: zh ? "zh" : "en",
  };
  if (existsSync(envFile)) {
    const bak = `${envFile}.bak-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    copyFileSync(envFile, bak);
    chmodSync(bak, 0o600);
    ok(t(`原来的 .env 备份为 ${bak}`, `Previous .env saved as ${bak}`));
  }
  const body = ["# Written by install.sh. See .env.example for the other settings.", ...Object.entries(values).map(([k, v]) => `${k}=${v}`), ""].join("\n");
  writeFileSync(envFile, body, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  ok(t(`配置已写入 ${envFile.replace(homedir(), "~")}`, `Settings written to ${envFile.replace(homedir(), "~")}`));
}

main().catch(e => { bad(String(e.message ?? e)); process.exit(1); });
