// Local time, same clock as the supervisor's lines in the same log file.
const stamp = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace("T", " ");
export const log = (...a: unknown[]) => console.log(stamp(), ...a);
