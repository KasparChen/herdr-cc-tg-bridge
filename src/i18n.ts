// Language of the bot's own messages: TG_BRIDGE_LANG=zh or en (default en). Read on every call, so tests can switch it.
export const zh = () => process.env.TG_BRIDGE_LANG === "zh";
export const tr = (cn: string, en: string) => (zh() ? cn : en);
export const locale = () => (zh() ? "zh-CN" : "en-US");
