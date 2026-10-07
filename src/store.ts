// Persistent bridge state: Telegram update offset and topic <-> pane bindings.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

export type Binding = {
  pane: string; tab?: string; session?: string; cwd: string; title?: string; autoName?: boolean;
  name?: string;        // label given when the topic was bound; shown until the session has a title
  terminal?: string;    // Herdr terminal id of the pane, so a reused pane id is never mistaken for ours
  closedAt?: number;    // topic closed (by /close or in the client): no pane, no watcher, reopening resumes the session
  notified?: boolean;   // the topic was already told its pane is down; cleared once it is live again
  lastActive?: number;
  attached?: boolean;   // a desktop session bound with tg-bind: closing or deleting the topic only disconnects it
  ctxWarned?: boolean;  // the topic was told the context is nearly full; cleared once it drops again
};
export type State = { offset: number; topics: Record<string, Binding>; statusMessage?: number };

export class Store {
  state: State;
  private file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "state.json");
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { offset: 0, topics: {} };
  }
  save() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.state, null, 2));
    renameSync(this.file + ".tmp", this.file);
  }
  remove(thread: number) {
    delete this.state.topics[thread];
    this.save();
  }
  topicOfPane(pane: string): number | undefined {
    const hit = Object.entries(this.state.topics).find(([, b]) => b.pane === pane && !b.closedAt);
    return hit ? Number(hit[0]) : undefined;
  }
}
