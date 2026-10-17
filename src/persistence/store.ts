import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type JsonRecord = Record<string, unknown>;
export type ActionReceipt = {
  receiptId: string;
  scope: string;
  commandId: string;
  status: string;
  result?: unknown;
  context?: unknown;
  payloadHash?: string;
  createdAt?: string;
  updatedAt?: string;
};

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const canonical = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    : value;
const sameJson = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const effectStatuses = ['prepared', 'may-have-dispatched', 'verifying', 'confirmed', 'partial', 'ambiguous'] as const;
const receiptStatuses = ['pending', 'completed', 'unknown', 'sent', 'ambiguous', 'conflict', 'rejected'] as const;
const receiptTerminal = new Set(['completed', 'unknown', 'sent', 'ambiguous', 'conflict', 'rejected']);
const effectRank: Record<string, number> = { prepared: 0, 'may-have-dispatched': 1, verifying: 2, ambiguous: 3, partial: 4, confirmed: 5 };

export class SQLiteStore {
  readonly db: Database.Database;

  constructor(file = ':memory:') {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate() {
    this.db.transaction(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS goals(goal_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL,
        body_context TEXT NOT NULL, spec_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executions(execution_id TEXT PRIMARY KEY, proposal_id TEXT UNIQUE NOT NULL,
        proposal_hash TEXT NOT NULL, goal_id TEXT NOT NULL, skill_id TEXT NOT NULL, skill_version TEXT NOT NULL,
        status TEXT NOT NULL, reason TEXT, outcome TEXT, checkpoint_json TEXT);
      CREATE TABLE IF NOT EXISTS effects(effect_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE, context TEXT NOT NULL,
        status TEXT NOT NULL, intent_json TEXT NOT NULL, evidence_json TEXT);
      CREATE TABLE IF NOT EXISTS critical_events(event_seq TEXT PRIMARY KEY, event_id TEXT NOT NULL, kind TEXT NOT NULL,
        context TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints(checkpoint_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL,
        revision INTEGER NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS places(place_id TEXT PRIMARY KEY, context TEXT NOT NULL, status TEXT NOT NULL,
        last_verified_at TEXT, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS episodes(episode_id TEXT PRIMARY KEY, context TEXT NOT NULL,
        event_refs_json TEXT NOT NULL, summary_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_receipts(
        receipt_id TEXT PRIMARY KEY, scope TEXT NOT NULL, command_id TEXT NOT NULL, status TEXT NOT NULL,
        result_json TEXT, context_json TEXT, payload_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(scope, command_id));
    `);
    const receiptColumns = this.db.prepare('PRAGMA table_info(action_receipts)').all() as Array<{ name: string }>;
    if (!receiptColumns.some(column => column.name === 'payload_hash')) this.db.exec('ALTER TABLE action_receipts ADD COLUMN payload_hash TEXT');
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)').run(now());
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)').run(now());
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)').run(now());
    })();
  }

  close() { this.db.close(); }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  saveGoal(goal: { goalId: string; revision: number; status: string; text: string; context?: unknown }) {
    const timestamp = now();
    const current = this.getGoal(goal.goalId);
    if (!current && goal.revision !== 0 && goal.revision !== 1) throw new Error('goal-revision-conflict:0');
    if (current && goal.revision !== current.revision && goal.revision !== current.revision + 1) throw new Error(`goal-revision-conflict:${current.revision}`);
    this.db.prepare(`INSERT INTO goals(goal_id,revision,status,body_context,spec_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET revision=excluded.revision,
      status=excluded.status, body_context=excluded.body_context, spec_json=excluded.spec_json, updated_at=excluded.updated_at
      WHERE goals.revision=excluded.revision-1 OR goals.revision=excluded.revision`)
      .run(goal.goalId, goal.revision, goal.status, json(goal.context ?? 'simulated'), json({ text: goal.text }), timestamp, timestamp);
  }

  getGoal(id: string) {
    const row = this.db.prepare('SELECT * FROM goals WHERE goal_id=?').get(id) as any;
    return row ? { ...row, context: parse(row.body_context), spec: parse(row.spec_json) } : undefined;
  }

  saveExecution(e: any) {
    const existing = this.db.prepare('SELECT * FROM executions WHERE proposal_id=?').get(e.proposalId) as any;
    if (existing) {
      if (existing.proposal_hash !== e.proposalHash) throw new Error('proposal-id-conflict');
      this.db.prepare(`UPDATE executions SET status=?, reason=COALESCE(?,reason), outcome=COALESCE(?,outcome),
        checkpoint_json=COALESCE(?,checkpoint_json) WHERE proposal_id=?`)
        .run(e.status, e.reason ?? null, e.outcome ?? null, e.checkpoint ? json(e.checkpoint) : null, e.proposalId);
      return this.getExecution(e.executionId) ?? this.getExecution(e.proposalId);
    }
    this.db.prepare(`INSERT INTO executions(execution_id,proposal_id,proposal_hash,goal_id,skill_id,skill_version,
      status,reason,outcome,checkpoint_json) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(e.executionId, e.proposalId, e.proposalHash, e.goalId, e.skillId, e.skillVersion, e.status,
        e.reason ?? null, e.outcome ?? null, e.checkpoint ? json(e.checkpoint) : null);
    return e;
  }

  getExecution(id: string) {
    const row = this.db.prepare('SELECT * FROM executions WHERE execution_id=? OR proposal_id=?').get(id, id) as any;
    return row ? {
      executionId: row.execution_id,
      proposalId: row.proposal_id,
      proposalHash: row.proposal_hash,
      goalId: row.goal_id,
      skillId: row.skill_id,
      skillVersion: row.skill_version,
      status: row.status,
      reason: row.reason ?? undefined,
      outcome: row.outcome ?? undefined,
      checkpoint: row.checkpoint_json ? parse(row.checkpoint_json) : undefined,
      execution_id: row.execution_id,
      proposal_id: row.proposal_id,
      proposal_hash: row.proposal_hash,
      goal_id: row.goal_id,
      skill_id: row.skill_id,
      skill_version: row.skill_version,
    } : undefined;
  }

  updateExecutionStatus(id: string, status: string, reason?: string, outcome?: string) {
    this.db.prepare(`UPDATE executions SET status=?, reason=COALESCE(?,reason), outcome=COALESCE(?,outcome)
      WHERE execution_id=? OR proposal_id=?`).run(status, reason ?? null, outcome ?? null, id, id);
  }

  addEffect(e: any) {
    if (!effectStatuses.includes(e.status)) throw new Error(`invalid-effect-status:${e.status}`);
    const existing = this.db.prepare('SELECT * FROM effects WHERE effect_id=?').get(e.effectId) as any;
    if (existing) {
      if (existing.execution_id !== e.executionId || !sameJson(parse(existing.context), e.context) || !sameJson(parse(existing.intent_json), e.intent)) throw new Error('effect-id-conflict');
      if ((effectRank[e.status] ?? -1) < (effectRank[existing.status] ?? -1)) return this.getEffect(e.effectId);
      this.db.prepare('UPDATE effects SET status=?, evidence_json=COALESCE(?, evidence_json) WHERE effect_id=?')
        .run(e.status, e.evidence === undefined ? null : json(e.evidence), e.effectId);
      return this.getEffect(e.effectId);
    }
    this.db.prepare(`INSERT INTO effects(effect_id,execution_id,context,status,intent_json,evidence_json)
      VALUES (?,?,?,?,?,?)`).run(e.effectId, e.executionId, json(e.context), e.status, json(e.intent), e.evidence === undefined ? null : json(e.evidence));
    return this.getEffect(e.effectId);
  }

  getEffect(effectId: string) {
    const row = this.db.prepare('SELECT * FROM effects WHERE effect_id=?').get(effectId) as any;
    return row ? { ...row, effectId: row.effect_id, executionId: row.execution_id, context: parse(row.context), intent: parse(row.intent_json), evidence: row.evidence_json ? parse(row.evidence_json) : undefined } : undefined;
  }

  updateEffect(effectId: string, status: string, evidence?: unknown) {
    if (!effectStatuses.includes(status as typeof effectStatuses[number])) throw new Error(`invalid-effect-status:${status}`);
    const current = this.getEffect(effectId);
    if (!current) throw new Error('effect-not-found');
    if ((effectRank[status] ?? -1) < (effectRank[current.status] ?? -1)) return current;
    this.db.prepare('UPDATE effects SET status=?, evidence_json=COALESCE(?, evidence_json) WHERE effect_id=?')
      .run(status, evidence === undefined ? null : json(evidence), effectId);
    return this.getEffect(effectId);
  }

  pendingEffects() {
    return (this.db.prepare("SELECT * FROM effects WHERE status NOT IN ('confirmed','partial') ORDER BY effect_id").all() as any[])
      .map(row => ({ ...row, effectId: row.effect_id, executionId: row.execution_id, context: parse(row.context), intent: parse(row.intent_json), evidence: row.evidence_json ? parse(row.evidence_json) : undefined }));
  }

  addActionReceipt(receipt: ActionReceipt) {
    if (!receiptStatuses.includes(receipt.status as typeof receiptStatuses[number])) throw new Error(`invalid-receipt-status:${receipt.status}`);
    const payloadHash = receipt.payloadHash ?? (receipt.result === undefined ? undefined : JSON.stringify(canonical(receipt.result)));
    const existing = this.getActionReceipt(receipt.scope, receipt.commandId);
    if (existing) {
      if (existing.payloadHash && receipt.payloadHash && existing.payloadHash !== receipt.payloadHash) throw new Error('command-payload-conflict');
      if (existing.receipt_id !== receipt.receiptId && existing.status !== 'pending') return existing;
      if (existing.receipt_id !== receipt.receiptId) throw new Error('receipt-id-conflict');
      if (existing.status === 'pending' && receipt.status !== 'pending') {
        this.db.prepare('UPDATE action_receipts SET status=?, result_json=COALESCE(?, result_json), context_json=COALESCE(?, context_json), updated_at=? WHERE scope=? AND command_id=?')
          .run(receipt.status, receipt.result === undefined ? null : json(receipt.result), receipt.context === undefined ? null : json(receipt.context), now(), receipt.scope, receipt.commandId);
      }
      return this.getActionReceipt(receipt.scope, receipt.commandId);
    }
    const timestamp = now();
    this.db.prepare(`INSERT INTO action_receipts(receipt_id,scope,command_id,status,result_json,context_json,payload_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(receipt.receiptId, receipt.scope, receipt.commandId, receipt.status,
        receipt.result === undefined ? null : json(receipt.result), receipt.context === undefined ? null : json(receipt.context), payloadHash ?? null, receipt.createdAt ?? timestamp, timestamp);
    return this.getActionReceipt(receipt.scope, receipt.commandId);
  }

  updateActionReceipt(scope: string, commandId: string, status: string, result?: unknown, context?: unknown) {
    if (!receiptStatuses.includes(status as typeof receiptStatuses[number])) throw new Error(`invalid-receipt-status:${status}`);
    const existing = this.getActionReceipt(scope, commandId);
    if (!existing) throw new Error('receipt-not-found');
    if (receiptTerminal.has(existing.status) && existing.status !== status) return existing;
    this.db.prepare('UPDATE action_receipts SET status=?, result_json=COALESCE(?, result_json), context_json=COALESCE(?, context_json), updated_at=? WHERE scope=? AND command_id=?')
      .run(status, result === undefined ? null : json(result), context === undefined ? null : json(context), now(), scope, commandId);
    return this.getActionReceipt(scope, commandId);
  }

  getActionReceipt(scope: string, commandId: string) {
    const row = this.db.prepare('SELECT * FROM action_receipts WHERE scope=? AND command_id=?').get(scope, commandId) as any;
      return row ? { ...row, result: row.result_json ? parse(row.result_json) : undefined, context: row.context_json ? parse(row.context_json) : undefined, payloadHash: row.payload_hash ?? undefined } : undefined;
  }

  hasActionReceipt(scope: string, commandId: string) { return this.getActionReceipt(scope, commandId) !== undefined; }

  addCriticalEvent(e: any) {
    this.db.prepare(`INSERT OR IGNORE INTO critical_events(event_seq,event_id,kind,context,payload_json)
      VALUES (?,?,?,?,?)`).run(String(e.seq), e.eventId, e.kind, json(e.context ?? 'simulated'), json(e.payload));
  }

  getCriticalEvents(after = '0', limit = 100, kind?: string) {
    const sql = `SELECT * FROM critical_events WHERE CAST(event_seq AS INTEGER)>CAST(? AS INTEGER) ${kind ? 'AND kind=?' : ''}
      ORDER BY CAST(event_seq AS INTEGER) LIMIT CAST(? AS INTEGER)`;
    const values = kind ? [String(after), kind, String(limit)] : [String(after), String(limit)];
    return (this.db.prepare(sql).all(...values) as any[])
      .map(row => ({ seq: row.event_seq, eventId: row.event_id, kind: row.kind, durable: true, context: parse(row.context), payload: parse(row.payload_json) }));
  }

  getLatestCriticalSequence() {
    const row = this.db.prepare('SELECT event_seq FROM critical_events ORDER BY CAST(event_seq AS INTEGER) DESC LIMIT 1').get() as { event_seq?: string } | undefined;
    return row?.event_seq ?? '0';
  }

  listExecutions() {
    return (this.db.prepare('SELECT execution_id FROM executions ORDER BY execution_id').all() as { execution_id: string }[])
      .map(row => this.getExecution(row.execution_id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  }

  listEffects(executionId?: string) {
    const rows = (executionId
      ? this.db.prepare('SELECT * FROM effects WHERE execution_id=? ORDER BY effect_id').all(executionId)
      : this.db.prepare('SELECT * FROM effects ORDER BY effect_id').all()) as any[];
    return rows.map(row => ({ ...row, effectId: row.effect_id, executionId: row.execution_id, context: parse(row.context), intent: parse(row.intent_json), evidence: row.evidence_json ? parse(row.evidence_json) : undefined }));
  }

  listActionReceipts(scope?: string) {
    const rows = (scope
      ? this.db.prepare('SELECT * FROM action_receipts WHERE scope=? ORDER BY created_at').all(scope)
      : this.db.prepare('SELECT * FROM action_receipts ORDER BY created_at').all()) as any[];
    return rows.map(row => ({ ...row, result: row.result_json ? parse(row.result_json) : undefined, context: row.context_json ? parse(row.context_json) : undefined, payloadHash: row.payload_hash ?? undefined }));
  }

  listGoals() {
    return (this.db.prepare('SELECT goal_id FROM goals ORDER BY goal_id').all() as { goal_id: string }[])
      .map(row => this.getGoal(row.goal_id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  }

  reviseGoal(goalId: string, expectedRevision: number, change: string) {
    return this.transaction(() => {
      const current = this.getGoal(goalId);
      if (!current) throw new Error('goal-not-found');
      if (current.revision !== expectedRevision) throw new Error(`goal-revision-conflict:${current.revision}`);
      this.saveGoal({ goalId, revision: current.revision + 1, status: current.status, text: change, context: current.context });
      return this.getGoal(goalId);
    });
  }

  saveCheckpoint(checkpoint: { checkpointId: string; executionId: string; revision: number; payload: unknown }) {
    this.db.prepare(`INSERT INTO checkpoints(checkpoint_id,execution_id,revision,payload_json) VALUES (?,?,?,?)
      ON CONFLICT(checkpoint_id) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json`)
      .run(checkpoint.checkpointId, checkpoint.executionId, checkpoint.revision, json(checkpoint.payload));
  }

  getCheckpoint(checkpointId: string) {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE checkpoint_id=?').get(checkpointId) as any;
    return row ? { ...row, payload: parse(row.payload_json) } : undefined;
  }

  getLatestCheckpoint(executionId: string) {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE execution_id=? ORDER BY revision DESC LIMIT 1').get(executionId) as any;
    return row ? { ...row, payload: parse(row.payload_json) } : undefined;
  }

  savePlace(place: { placeId: string; context: unknown; status: string; lastVerifiedAt?: string; payload: unknown }) {
    this.db.prepare(`INSERT INTO places(place_id,context,status,last_verified_at,payload_json) VALUES (?,?,?,?,?)
      ON CONFLICT(place_id) DO UPDATE SET context=excluded.context,status=excluded.status,
      last_verified_at=excluded.last_verified_at,payload_json=excluded.payload_json`)
      .run(place.placeId, json(place.context), place.status, place.lastVerifiedAt ?? null, json(place.payload));
  }

  getPlace(placeId: string) {
    const row = this.db.prepare('SELECT * FROM places WHERE place_id=?').get(placeId) as any;
    return row ? { ...row, context: parse(row.context), payload: parse(row.payload_json) } : undefined;
  }

  listPlaces(context?: unknown) {
    const rows = this.db.prepare('SELECT * FROM places ORDER BY place_id').all() as any[];
    return rows.map(row => ({ ...row, context: parse(row.context), payload: parse(row.payload_json) }))
      .filter(row => context === undefined || json(row.context) === json(context));
  }

  saveEpisode(episode: { episodeId: string; context: unknown; eventRefs: unknown; summary: unknown }) {
    this.db.prepare(`INSERT INTO episodes(episode_id,context,event_refs_json,summary_json) VALUES (?,?,?,?)
      ON CONFLICT(episode_id) DO UPDATE SET context=excluded.context,event_refs_json=excluded.event_refs_json,
      summary_json=excluded.summary_json`).run(episode.episodeId, json(episode.context), json(episode.eventRefs), json(episode.summary));
  }

  getEpisode(episodeId: string) {
    const row = this.db.prepare('SELECT * FROM episodes WHERE episode_id=?').get(episodeId) as any;
    return row ? { ...row, context: parse(row.context), eventRefs: parse(row.event_refs_json), summary: parse(row.summary_json) } : undefined;
  }

  listEpisodes(context?: unknown) {
    const rows = this.db.prepare('SELECT * FROM episodes ORDER BY episode_id').all() as any[];
    return rows.map(row => ({ ...row, context: parse(row.context), eventRefs: parse(row.event_refs_json), summary: parse(row.summary_json) }))
      .filter(row => context === undefined || json(row.context) === json(context));
  }
}
