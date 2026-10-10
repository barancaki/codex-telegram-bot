/** Exclusive per-token lock. Launchers never terminate a previous owner. */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { isPidAlive } from "../sessions/store.js";

interface LockData {
  pid: number;
  startedAt: number;
  supervised: boolean;
}

export class InstanceLock {
  private readonly file: string;
  private held = false;
  private readonly startedAt = Date.now();

  constructor(token: string, locksDir: string, private readonly supervised: boolean) {
    const hash = createHash("sha256").update(token).digest("hex").slice(0, 16);
    this.file = join(locksDir, `${hash}.lock`);
  }

  async acquire(): Promise<boolean> {
    mkdirSync(dirname(this.file), { recursive: true });
    // Serialize stale-lock recovery too; a crashed recovery fails closed.
    const recovery = `${this.file}.reclaim`;
    let guard: number;
    try {
      guard = openSync(recovery, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Lock recovery is already in progress: ${recovery}. Remove it only after verifying no bot instance is running.`);
      }
      throw err;
    }
    try {
      const existing = this.read();
      if (existing) {
        if (isPidAlive(existing.pid)) return false;
        rmSync(this.file);
      }
      const fd = openSync(this.file, "wx");
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: this.startedAt, supervised: this.supervised }));
      } finally {
        closeSync(fd);
      }
      this.held = true;
      return true;
    } finally {
      closeSync(guard);
      rmSync(recovery, { force: true });
    }
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    const current = this.read();
    if (current?.pid === process.pid && current.startedAt === this.startedAt) rmSync(this.file, { force: true });
  }

  private read(): LockData | undefined {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf-8")) as LockData;
      if (!Number.isSafeInteger(data.pid) || data.pid <= 0) throw new Error("Invalid owner PID");
      return data;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Cannot safely read instance lock: ${this.file}`);
    }
  }
}
