import {
  closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

/**
 * Durable record written into the runtime ownership lock. `runtimeId`/`epoch` identify this
 * runtime incarnation; release compares the stored record so a stale finalizer can never remove
 * a replacement owner's lock.
 */
export type OwnershipRecord = {
  pid: number;
  hostname: string;
  createdAt: number;
  epoch: string;
  runtimeId: string;
};

export type OwnershipLockOptions = {
  hostname?: string;
  now?: () => number;
  /** Test seam; defaults to signal 0 liveness probing. */
  isProcessAlive?: (pid: number) => boolean;
  lockPath?: string;
  /** Maximum create/retry rounds when a stale lock is reclaimed concurrently. */
  attempts?: number;
};

const owned = () => new Error('runtime-control-owned');

const defaultAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user: still alive.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

/**
 * Cross-process single-owner lock for one storage path.
 *
 * Acquisition uses an atomic `open(..., 'wx')` create. A pre-existing lock is only reclaimed
 * when its record is well formed, belongs to this host, and its PID is demonstrably dead;
 * otherwise the second instance is refused. Reclamation is itself atomic: the stale file is
 * renamed aside (only one contender can win the rename), verified to still be the stale record,
 * and only then removed. Unknown or unreadable locks are never deleted.
 */
export class RuntimeOwnershipLock {
  readonly lockPath: string;
  readonly runtimeId = `owner_${randomUUID()}`;
  readonly epoch = `${this.runtimeId}:${process.pid}`;
  private readonly hostname: string;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly attempts: number;
  private record?: OwnershipRecord;

  constructor(storagePath: string, options: OwnershipLockOptions = {}) {
    this.lockPath = options.lockPath ?? `${storagePath}.owner.lock`;
    this.hostname = options.hostname ?? os.hostname();
    this.now = options.now ?? Date.now;
    this.isProcessAlive = options.isProcessAlive ?? defaultAlive;
    this.attempts = Math.max(1, options.attempts ?? 4);
  }

  get held(): boolean { return this.record !== undefined; }
  get owner(): OwnershipRecord | undefined { return this.record; }

  acquire(): OwnershipRecord {
    if (this.record) return this.record;
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      const created = this.tryCreate();
      if (created) { this.record = created; return created; }
      const existing = this.read();
      // A lock we cannot positively identify as a dead owner's is retained untouched.
      if (!existing || existing.hostname !== this.hostname || existing.pid === process.pid || this.isProcessAlive(existing.pid)) {
        throw owned();
      }
      if (!this.reclaim(existing)) continue;
    }
    throw owned();
  }

  /** Remove the lock only when it is still this runtime's record. */
  release(): boolean {
    if (!this.record) return false;
    let current: OwnershipRecord | undefined;
    try { current = this.read(); } catch { return false; }
    if (!current || current.runtimeId !== this.record.runtimeId || current.pid !== process.pid) return false;
    try { unlinkSync(this.lockPath); } catch { return false; }
    this.record = undefined;
    return true;
  }

  private newRecord(): OwnershipRecord {
    return { pid: process.pid, hostname: this.hostname, createdAt: this.now(), epoch: this.epoch, runtimeId: this.runtimeId };
  }

  private tryCreate(): OwnershipRecord | undefined {
    const record = this.newRecord();
    // Write the full record to a private temp file first, then publish it with an atomic hard
    // link. `link` either creates the lock with complete contents or fails with EEXIST; there is
    // no observable window where the lock exists but is unreadable after a crash.
    const temp = `${this.lockPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } catch (error) {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
    closeSync(fd);
    try { linkSync(temp, this.lockPath); }
    catch (error) {
      try { unlinkSync(temp); } catch { /* best effort */ }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw error;
    }
    try { unlinkSync(temp); } catch { /* a stray temp file is not an ownership record */ }
    return record;
  }

  private read(): OwnershipRecord | undefined {
    let raw: string;
    try { raw = readFileSync(this.lockPath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<OwnershipRecord>;
      if (!parsed || typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || typeof parsed.hostname !== 'string'
        || typeof parsed.runtimeId !== 'string' || typeof parsed.epoch !== 'string') return undefined;
      return {
        pid: parsed.pid,
        hostname: parsed.hostname,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
        epoch: parsed.epoch,
        runtimeId: parsed.runtimeId,
      };
    } catch { return undefined; }
  }

  /** Atomically move a verified-dead owner's lock aside, then remove it. */
  private reclaim(stale: OwnershipRecord): boolean {
    const quarantine = `${this.lockPath}.stale.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    try { renameSync(this.lockPath, quarantine); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw owned();
    }
    // Another contender may have replaced the lock between our read and rename. If the
    // quarantined record is not the one we judged stale, put it back and refuse ownership.
    const moved = this.readPath(quarantine);
    if (!moved || moved.runtimeId !== stale.runtimeId || moved.pid !== stale.pid) {
      try { renameSync(quarantine, this.lockPath); } catch { /* a new lock now exists */ }
      throw owned();
    }
    try { unlinkSync(quarantine); } catch { /* quarantine remains but lock slot is free */ }
    return true;
  }

  private readPath(file: string): OwnershipRecord | undefined {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<OwnershipRecord>;
      if (!parsed || typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || typeof parsed.hostname !== 'string'
        || typeof parsed.runtimeId !== 'string' || typeof parsed.epoch !== 'string') return undefined;
      return {
        pid: parsed.pid,
        hostname: parsed.hostname,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
        epoch: parsed.epoch,
        runtimeId: parsed.runtimeId,
      };
    } catch { return undefined; }
  }
}
