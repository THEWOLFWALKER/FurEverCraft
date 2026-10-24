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
const executionTerminal = new Set(['succeeded', 'failed', 'canceled']);
const MEMORY_SCOPE_KEYS = ['serverProfileId', 'accountId', 'worldGenerationId', 'dimensionId'] as const;
const coreScope = (value: unknown): Partial<Record<(typeof MEMORY_SCOPE_KEYS)[number], string>> | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.serverProfileId !== 'string' || !record.serverProfileId) return undefined;
  const scope: Partial<Record<(typeof MEMORY_SCOPE_KEYS)[number], string>> = {};
  for (const key of MEMORY_SCOPE_KEYS) if (typeof record[key] === 'string' && record[key]) scope[key] = record[key] as string;
  return scope;
};

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
        last_verified_at TEXT, payload_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        provenance_json TEXT, invalidated_reason TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS episodes(episode_id TEXT PRIMARY KEY, context TEXT NOT NULL,
        event_refs_json TEXT NOT NULL, summary_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        provenance_json TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS memory_scope(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_receipts(
        receipt_id TEXT PRIMARY KEY, scope TEXT NOT NULL, command_id TEXT NOT NULL, status TEXT NOT NULL,
        result_json TEXT, context_json TEXT, payload_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(scope, command_id));
      CREATE TABLE IF NOT EXISTS knowledge_releases(
        release_id TEXT PRIMARY KEY, version TEXT NOT NULL, release_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_active(release_id TEXT PRIMARY KEY, activated_at TEXT NOT NULL);
    `);
    const receiptColumns = this.db.prepare('PRAGMA table_info(action_receipts)').all() as Array<{ name: string }>;
    if (!receiptColumns.some(column => column.name === 'payload_hash')) this.db.exec('ALTER TABLE action_receipts ADD COLUMN payload_hash TEXT');
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)').run(now());
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)').run(now());
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)').run(now());
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, ?)').run(now());
    })();
    // Widening primary keys rebuilds tables, so it runs outside the schema DDL transaction.
    this.db.transaction(() => {
      this.scopeMemoryKeys('places', 'place_id');
      this.scopeMemoryKeys('episodes', 'episode_id');
      this.ensureMemoryColumns('places', ['revision INTEGER NOT NULL DEFAULT 0', 'provenance_json TEXT', 'invalidated_reason TEXT', 'updated_at TEXT']);
      this.ensureMemoryColumns('episodes', ['revision INTEGER NOT NULL DEFAULT 0', 'provenance_json TEXT', 'updated_at TEXT']);
    })();
  }

  /** Additive columns keep existing databases readable; no data is rewritten or dropped. */
  private ensureMemoryColumns(table: 'places' | 'episodes', definitions: string[]) {
    const existing = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));
    for (const definition of definitions) {
      const name = definition.split(' ')[0]!;
      if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  }

  close() { this.db.close(); }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  saveGoal(goal: { goalId: string; revision: number; status: string; text: string; context?: unknown }) {
    const timestamp = now();
    const current = this.getGoal(goal.goalId);
    // A goal's first revision is 0 or 1; any other first write is a skip and is rejected.
    if (!current && goal.revision !== 0 && goal.revision !== 1) throw new Error('goal-revision-conflict:0');
    // Only the next revision may be written; a repeat of the current revision is a conflict.
    if (current && goal.revision !== current.revision + 1) throw new Error(`goal-revision-conflict:${current.revision}`);
    this.db.prepare(`INSERT INTO goals(goal_id,revision,status,body_context,spec_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET revision=excluded.revision,
      status=excluded.status, body_context=excluded.body_context, spec_json=excluded.spec_json, updated_at=excluded.updated_at
      WHERE goals.revision=excluded.revision-1`)
      .run(goal.goalId, goal.revision, goal.status, json(goal.context ?? 'simulated'), json({ text: goal.text }), timestamp, timestamp);
    // A write that loses the revision race (or rolls the revision back) must fail, not silently no-op.
    const stored = this.getGoal(goal.goalId);
    if (!stored || stored.revision !== goal.revision) throw new Error(`goal-revision-conflict:${stored?.revision ?? 0}`);
  }

  getGoal(id: string) {
    const row = this.db.prepare('SELECT * FROM goals WHERE goal_id=?').get(id) as any;
    return row ? { ...row, context: parse(row.body_context), spec: parse(row.spec_json) } : undefined;
  }

  saveExecution(e: any) {
    const existing = this.db.prepare('SELECT * FROM executions WHERE proposal_id=?').get(e.proposalId) as any;
    if (existing) {
      if (existing.proposal_hash !== e.proposalHash) throw new Error('proposal-id-conflict');
      // A late writer must not resurrect or overwrite a terminal execution.
      if (executionTerminal.has(existing.status) && existing.status !== e.status) return this.getExecution(existing.execution_id) ?? this.getExecution(existing.proposal_id);
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
    const existing = this.getExecution(id);
    if (existing && executionTerminal.has(existing.status) && existing.status !== status) return existing;
    this.db.prepare(`UPDATE executions SET status=?, reason=COALESCE(?,reason), outcome=COALESCE(?,outcome)
      WHERE execution_id=? OR proposal_id=?`).run(status, reason ?? null, outcome ?? null, id, id);
    return this.getExecution(id);
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

  savePlace(place: { placeId: string; context: unknown; status: string; lastVerifiedAt?: string; payload: unknown; provenance?: unknown; revision?: number; expectedRevision?: number; invalidatedReason?: string }) {
    // A place id is only unique inside its scope: the same place in another world must not
    // overwrite this one. Legacy single-column layouts are widened to (place_id, context).
    const reuse = place.context === undefined ? undefined : this.findPlaceByScope(place.placeId, place.context) as { rowid: number; revision: number; provenance?: unknown } | undefined;
    const timestamp = now();
    if (reuse) {
      if (place.expectedRevision !== undefined && Number(reuse.revision ?? 0) !== place.expectedRevision) throw new Error(`place-revision-conflict:${Number(reuse.revision ?? 0)}`);
      const revision = Number(reuse.revision ?? 0) + 1;
      const provenance = place.provenance === undefined ? reuse.provenance ?? null : json(place.provenance);
      this.db.prepare(`UPDATE places SET context=?, status=?, last_verified_at=?, payload_json=?, revision=?, provenance_json=?,
        invalidated_reason=?, updated_at=? WHERE rowid=?`)
        .run(json(place.context), place.status, place.lastVerifiedAt ?? null, json(place.payload), revision, provenance,
          place.status === 'invalid' ? place.invalidatedReason ?? null : null, timestamp, reuse.rowid);
    } else {
      this.db.prepare(`INSERT INTO places(place_id,context,status,last_verified_at,payload_json,revision,provenance_json,invalidated_reason,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(place.placeId, json(place.context), place.status, place.lastVerifiedAt ?? null, json(place.payload),
          Math.max(0, place.revision ?? 0), place.provenance === undefined ? null : json(place.provenance),
          place.status === 'invalid' ? place.invalidatedReason ?? null : null, timestamp);
    }
    this.touchScope(place.context);
  }

  /** Update an existing place with optional optimistic concurrency. Missing places are not created. */
  updatePlace(place: { placeId: string; context: unknown; status?: string; lastVerifiedAt?: string; payload?: unknown; provenance?: unknown; expectedRevision?: number }) {
    const existing = this.findPlaceByScope(place.placeId, place.context);
    if (!existing) throw new Error('place-not-found');
    return this.savePlace({
      placeId: place.placeId, context: place.context, status: place.status ?? existing.status,
      lastVerifiedAt: place.lastVerifiedAt ?? existing.lastVerifiedAt, payload: place.payload === undefined ? existing.payload : place.payload,
      provenance: place.provenance ?? existing.provenance, expectedRevision: place.expectedRevision,
    });
  }

  invalidatePlace(placeId: string, context: unknown, reason: string, expectedRevision?: number) {
    const existing = this.findPlaceByScope(placeId, context);
    if (!existing) throw new Error('place-not-found');
    this.savePlace({
      placeId, context, status: 'invalid', lastVerifiedAt: existing.lastVerifiedAt, payload: existing.payload,
      provenance: { ...(existing.provenance as Record<string, unknown> | undefined), invalidatedAt: now(), reason },
      expectedRevision, invalidatedReason: reason,
    });
    return this.findPlaceByScope(placeId, context);
  }

  /** Returns the record with this id: the one visible in the current scope when a scope is given. */
  getPlace(placeId: string, context?: unknown) {
    if (context !== undefined) return this.placeRow(this.db.prepare('SELECT * FROM places WHERE place_id=? AND context=?').get(placeId, json(context)) as any);
    const current = this.currentScope();
    if (current !== undefined) {
      const scoped = this.placeRow(this.db.prepare('SELECT * FROM places WHERE place_id=? AND context=?').get(placeId, current) as any);
      if (scoped) return scoped;
    }
    return this.placeRow(this.db.prepare('SELECT * FROM places WHERE place_id=? ORDER BY rowid DESC LIMIT 1').get(placeId) as any);
  }

  listPlaces(context?: unknown) {
    const rows = (context === undefined
      ? this.db.prepare('SELECT * FROM places ORDER BY place_id, context').all()
      : this.db.prepare('SELECT * FROM places WHERE context=? ORDER BY place_id').all(json(context))) as any[];
    return rows.map(row => this.placeRow(row)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  }

  /**
   * Resolve a place by its stable scope fields. Connection/body epochs are evidence fences, not
   * place identity, so a reconnect to the same world still finds the same place.
   */
  findPlaceByScope(placeId: string, context?: unknown) {
    if (context === undefined) return this.getPlace(placeId);
    const core = coreScope(context);
    if (!core) return this.getPlace(placeId, context);
    const entries = Object.entries(core);
    const where = entries.map(([key]) => `json_extract(context, '$.${key}')=?`).join(' AND ');
    return this.placeRow(this.db.prepare(`SELECT rowid, * FROM places WHERE place_id=? AND ${where} ORDER BY rowid DESC LIMIT 1`).get(placeId, ...entries.map(([, value]) => value)) as any);
  }

  /** Bounded page over the stable scope fields (legacy string contexts still match exactly). */
  listPlacesPageByScope(context: unknown, options: { status?: string; limit?: number; cursor?: string } = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 50);
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isInteger(start) || start < 0) throw new Error('invalid-memory-cursor');
    const core = context === undefined ? undefined : coreScope(context);
    const values: unknown[] = [];
    let where = '';
    if (context !== undefined) {
      if (core) {
        where = Object.entries(core).map(([key]) => `json_extract(context, '$.${key}')=?`).join(' AND ');
        values.push(...Object.values(core));
      } else { where = 'context=?'; values.push(json(context)); }
    }
    if (options.status) { where = where ? `${where} AND status=?` : 'status=?'; values.push(options.status); }
    values.push(limit + 1, start);
    const rows = (this.db.prepare(`SELECT * FROM places ${where ? `WHERE ${where}` : ''} ORDER BY place_id, context LIMIT CAST(? AS INTEGER) OFFSET CAST(? AS INTEGER)`).all(...values) as any[]).map(row => this.placeRow(row)).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const page = rows.slice(0, limit);
    return { items: page, truncated: rows.length > limit, ...(rows.length > limit ? { nextCursor: String(start + limit) } : {}) };
  }

  /** Bounded page. `limit + 1` detects truncation without counting the whole table. */
  listPlacesPage(context: unknown, options: { status?: string; limit?: number; cursor?: string } = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 50);
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isInteger(start) || start < 0) throw new Error('invalid-memory-cursor');
    const status = options.status ? ' AND status=?' : '';
    const values: unknown[] = context === undefined ? [] : [json(context)];
    if (options.status) values.push(options.status);
    values.push(limit + 1, start);
    const where = context === undefined ? (options.status ? 'WHERE status=?' : '') : `WHERE context=?${status}`;
    const rows = (this.db.prepare(`SELECT * FROM places ${where} ORDER BY place_id, context LIMIT CAST(? AS INTEGER) OFFSET CAST(? AS INTEGER)`).all(...values) as any[]).map(row => this.placeRow(row)).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const page = rows.slice(0, limit);
    return { items: page, truncated: rows.length > limit, ...(rows.length > limit ? { nextCursor: String(start + limit) } : {}) };
  }

  /** Persist a scoped place and return the row for that scope (never another world's row). */
  rememberPlace(place: { placeId: string; context: unknown; status: string; lastVerifiedAt?: string; payload: unknown }) {
    this.savePlace(place);
    return this.getPlace(place.placeId, place.context);
  }

  private placeRow(row: any) {
    return row ? {
      ...row, context: parse(row.context), payload: parse(row.payload_json),
      lastVerifiedAt: row.last_verified_at ?? undefined,
      revision: Number(row.revision ?? 0),
      provenance: row.provenance_json ? parse(row.provenance_json) : undefined,
      invalidatedReason: row.invalidated_reason ?? undefined,
      updatedAt: row.updated_at ?? undefined,
    } : undefined;
  }

  saveEpisode(episode: { episodeId: string; context: unknown; eventRefs: unknown; summary: unknown; provenance?: unknown; revision?: number }) {
    // Episodes are scoped like places so the same episode id in another world is a separate record.
    const reuse = episode.context === undefined ? undefined : this.db.prepare('SELECT rowid, revision, provenance_json FROM episodes WHERE episode_id=? AND context=?').get(episode.episodeId, json(episode.context)) as { rowid: number; revision: number; provenance_json?: string } | undefined;
    const timestamp = now();
    if (reuse) {
      const revision = Number(reuse.revision ?? 0) + 1;
      const provenance = episode.provenance === undefined ? reuse.provenance_json ?? null : json(episode.provenance);
      this.db.prepare('UPDATE episodes SET event_refs_json=?, summary_json=?, revision=?, provenance_json=?, updated_at=? WHERE rowid=?')
        .run(json(episode.eventRefs), json(episode.summary), revision, provenance, timestamp, reuse.rowid);
    } else {
      this.db.prepare(`INSERT INTO episodes(episode_id,context,event_refs_json,summary_json,revision,provenance_json,updated_at) VALUES (?,?,?,?,?,?,?)`)
        .run(episode.episodeId, json(episode.context), json(episode.eventRefs), json(episode.summary),
          Math.max(0, episode.revision ?? 0), episode.provenance === undefined ? null : json(episode.provenance), timestamp);
    }
    this.touchScope(episode.context);
  }

  /** Returns the record with this id: the one visible in the current scope when a scope is given. */
  getEpisode(episodeId: string, context?: unknown) {
    if (context !== undefined) return this.episodeRow(this.db.prepare('SELECT * FROM episodes WHERE episode_id=? AND context=?').get(episodeId, json(context)) as any);
    const current = this.currentScope();
    if (current !== undefined) {
      const scoped = this.episodeRow(this.db.prepare('SELECT * FROM episodes WHERE episode_id=? AND context=?').get(episodeId, current) as any);
      if (scoped) return scoped;
    }
    return this.episodeRow(this.db.prepare('SELECT * FROM episodes WHERE episode_id=? ORDER BY rowid DESC LIMIT 1').get(episodeId) as any);
  }

  listEpisodes(context?: unknown) {
    const rows = (context === undefined
      ? this.db.prepare('SELECT * FROM episodes ORDER BY episode_id, context').all()
      : this.db.prepare('SELECT * FROM episodes WHERE context=? ORDER BY episode_id').all(json(context))) as any[];
    return rows.map(row => this.episodeRow(row)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  }

  /** Bounded page, optionally restricted to a summary kind (e.g. execution-experience). */
  listEpisodesPage(context: unknown, options: { limit?: number; cursor?: string; kind?: string } = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 50);
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isInteger(start) || start < 0) throw new Error('invalid-memory-cursor');
    const values: unknown[] = context === undefined ? [] : [json(context)];
    const kind = options.kind ? ` AND json_extract(summary_json, '$.kind')=?` : '';
    if (options.kind) values.push(options.kind);
    const where = context === undefined ? (options.kind ? `WHERE json_extract(summary_json, '$.kind')=?` : '') : `WHERE context=?${kind}`;
    values.push(limit + 1, start);
    const rows = (this.db.prepare(`SELECT * FROM episodes ${where} ORDER BY episode_id, context LIMIT CAST(? AS INTEGER) OFFSET CAST(? AS INTEGER)`).all(...values) as any[]).map(row => this.episodeRow(row)).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const page = rows.slice(0, limit);
    return { items: page, truncated: rows.length > limit, ...(rows.length > limit ? { nextCursor: String(start + limit) } : {}) };
  }

  /** Persist a scoped episode and return the row for that scope (never another world's row). */
  recordEpisode(episode: { episodeId: string; context: unknown; eventRefs: unknown; summary: unknown }) {
    this.saveEpisode(episode);
    return this.getEpisode(episode.episodeId, episode.context);
  }

  private episodeRow(row: any) {
    return row ? {
      ...row, context: parse(row.context), eventRefs: parse(row.event_refs_json), summary: parse(row.summary_json),
      revision: Number(row.revision ?? 0),
      provenance: row.provenance_json ? parse(row.provenance_json) : undefined,
      updatedAt: row.updated_at ?? undefined,
    } : undefined;
  }

  /** The scope reported by this database's most recent scoped memory write, if any. */
  private currentScope(): string | undefined {
    const row = this.db.prepare("SELECT value FROM memory_scope WHERE key='current'").get() as { value?: string } | undefined;
    return row?.value;
  }

  private touchScope(context: unknown) {
    if (context === undefined) return;
    this.db.prepare("INSERT INTO memory_scope(key,value) VALUES ('current',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(json(context));
  }

  /**
   * Publish a fully validated knowledge release and, atomically, make it active. A partial
   * failure rolls back both writes; release ids are immutable once published.
   */
  publishKnowledgeRelease(release: { releaseId: string; version: string; payload: unknown; createdAt?: string }, activate = true) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM knowledge_releases WHERE release_id=?').get(release.releaseId) as any;
      if (existing) {
        if (existing.version !== release.version || !sameJson(parse(existing.release_json), release.payload)) throw new Error('knowledge-release-conflict');
      } else {
        this.db.prepare('INSERT INTO knowledge_releases(release_id,version,release_json,created_at) VALUES (?,?,?,?)')
          .run(release.releaseId, release.version, json(release.payload), release.createdAt ?? now());
      }
      if (activate) {
        this.db.prepare('DELETE FROM knowledge_active').run();
        this.db.prepare('INSERT INTO knowledge_active(release_id,activated_at) VALUES (?,?)').run(release.releaseId, now());
      }
      return this.getKnowledgeRelease(release.releaseId)!;
    });
  }

  activateKnowledgeRelease(releaseId: string) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT release_id FROM knowledge_releases WHERE release_id=?').get(releaseId);
      if (!existing) throw new Error('knowledge-release-missing');
      this.db.prepare('DELETE FROM knowledge_active').run();
      this.db.prepare('INSERT INTO knowledge_active(release_id,activated_at) VALUES (?,?)').run(releaseId, now());
      return this.getKnowledgeRelease(releaseId)!;
    });
  }

  getKnowledgeRelease(releaseId: string) {
    const row = this.db.prepare('SELECT * FROM knowledge_releases WHERE release_id=?').get(releaseId) as any;
    return row ? { releaseId: row.release_id, version: row.version, payload: parse(row.release_json), createdAt: row.created_at } : undefined;
  }

  getActiveKnowledgeRelease() {
    const row = this.db.prepare('SELECT r.* FROM knowledge_active a JOIN knowledge_releases r ON r.release_id=a.release_id LIMIT 1').get() as any;
    return row ? { releaseId: row.release_id, version: row.version, payload: parse(row.release_json), createdAt: row.created_at } : undefined;
  }

  listKnowledgeReleases() {
    return (this.db.prepare('SELECT * FROM knowledge_releases ORDER BY created_at, release_id').all() as any[])
      .map(row => ({ releaseId: row.release_id, version: row.version, payload: parse(row.release_json), createdAt: row.created_at }));
  }

  /**
   * Widen a legacy single-column primary key to (id, context). The rebuild re-applies the current
   * schema, so this must run inside the migration transaction where a failure rolls everything back.
   */
  private scopeMemoryKeys(table: 'places' | 'episodes', idColumn: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
    const keys = columns.filter(column => column.pk > 0).sort((left, right) => left.pk - right.pk).map(column => column.name);
    if (keys.length === 2 && keys[0] === idColumn && keys[1] === 'context') return;
    if (keys.length !== 1 || keys[0] !== idColumn) throw new Error(`memory-schema-mismatch:${table}`);
    this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy`);
    this.db.exec(`CREATE TABLE ${table}(${table === 'places'
      ? 'place_id TEXT NOT NULL, context TEXT NOT NULL, status TEXT NOT NULL, last_verified_at TEXT, payload_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, provenance_json TEXT, invalidated_reason TEXT, updated_at TEXT'
      : 'episode_id TEXT NOT NULL, context TEXT NOT NULL, event_refs_json TEXT NOT NULL, summary_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, provenance_json TEXT, updated_at TEXT'}, PRIMARY KEY(${idColumn}, context))`);
    const target = table === 'places' ? 'place_id,context,status,last_verified_at,payload_json' : 'episode_id,context,event_refs_json,summary_json';
    this.db.exec(`INSERT INTO ${table}(${target}) SELECT ${target} FROM ${table}_legacy`);
    this.db.exec(`DROP TABLE ${table}_legacy`);
  }
}
