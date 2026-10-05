// Persistent bridge state: Telegram update offset and topic <-> pane bindings.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

export type Binding = { pane: string; tab?: string; session?: string; cwd: string; title?: string; autoName?: boolean };
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
  topicOfPane(pane: string): number | undefined {
    const hit = Object.entries(this.state.topics).find(([, b]) => b.pane === pane);
    return hit ? Number(hit[0]) : undefined;
  }
}
