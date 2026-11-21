import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalScopeKey, resolveStableScope, type StableScope } from '../contracts/context.js';
import { redact } from '../diagnostics/redaction.js';

export type JsonRecord = Record<string, unknown>;
export type ActionReceipt = {
  receiptId: string;
  scope: string;
  commandId: string;
  status: string;
  result?: unknown;
  context?: unknown;
  payloadHash?: string;
  requestJsonHash?: string;
  /** Original response code, so a durable failure replay is identical (FEC-30). */
  code?: string;
  /** Full command-result envelope; replay returns this rather than a reconstruction. */
  fullResult?: unknown;
  contextStatus?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type SQLiteStoreOptions = {
  /** Diagnostic readers open query_only and never create, migrate or alter schema (FEC-58). */
  readonly?: boolean;
  backupBeforeMigrate?: boolean;
};

/** Highest schema this build writes. A database above it must refuse write startup. */
export const SUPPORTED_SCHEMA_VERSION = 7;

/**
 * Schema versions this build applies, in order. Version 5 adds durable scope identity,
 * 6 adds effect revisions/attribution/transitions, 7 adds receipt replay identity and the
 * shutdown interlock. The list is exported so a diagnostic or migration test can prove the
 * requested version set matches what `migrate()` actually applies.
 */
export const SCHEMA_MIGRATIONS = [5, 6, 7] as const;

/** Version at which the durable effect attribution columns and transitions table exist (FEC-35/FEC-24). */
export const EFFECT_ATTRIBUTION_SCHEMA_VERSION = 6;

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const canonical = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    : value;
const sameJson = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
export const effectStatuses = ['prepared', 'may-have-dispatched', 'verifying', 'confirmed', 'partial', 'ambiguous', 'not-dispatched'] as const;
export const EFFECT_TERMINAL = new Set(['confirmed', 'partial', 'ambiguous', 'not-dispatched']);
/** L2 section 5: the only legal effect state transitions. Same-state is an idempotent no-op. */
export const EFFECT_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  // `prepared -> ambiguous` is the recovery outcome when a crash means the process cannot prove
  // whether the barrier was crossed. It never becomes success; the normal dispatch path is still
  // required to persist may-have-dispatched before any input.
  prepared: new Set(['may-have-dispatched', 'not-dispatched', 'ambiguous']),
  'may-have-dispatched': new Set(['verifying', 'confirmed', 'partial', 'ambiguous', 'not-dispatched']),
  verifying: new Set(['confirmed', 'partial', 'ambiguous']),
  partial: new Set(['confirmed', 'ambiguous']),
  ambiguous: new Set(['confirmed', 'ambiguous']),
  confirmed: new Set(),
  'not-dispatched': new Set(),
};
const legalEffectTransition = (from: string, to: string) => from === to || Boolean(EFFECT_TRANSITIONS[from]?.has(to));

const receiptStatuses = ['pending', 'completed', 'unknown', 'sent', 'ambiguous', 'conflict', 'rejected'] as const;
const receiptTerminal = new Set(['completed', 'unknown', 'sent', 'ambiguous', 'conflict', 'rejected']);
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
/** Strict scope predicate: an omitted stable field matches only rows that also omit it. */
const scopePredicate = (scope: Partial<Record<(typeof MEMORY_SCOPE_KEYS)[number], string>>) => {
  const clauses: string[] = []; const values: unknown[] = [];
  for (const key of MEMORY_SCOPE_KEYS) {
    if (scope[key] !== undefined) { clauses.push(`json_extract(context, '$.${key}')=?`); values.push(scope[key]!); }
    else clauses.push(`json_extract(context, '$.${key}') IS NULL`);
  }
  return { sql: clauses.join(' AND '), values };
};

/**
 * Stable-scope predicate options for the control reads (G7). `scopeKey` is the canonical
 * hash of the attached stable identity; `scope` carries the same identity field-by-field so
 * a scalar row whose key column was written by an older build still matches. A caller with
 * no resolvable identity must not call these with a guess.
 */
export type StableScopeRead = { scopeKey: string; scope: StableScope };

const boundedLimit = (value: number | undefined, fallback = 100, maximum = 500) => {
  if (value === undefined) return Math.min(fallback, maximum);
  if (!Number.isFinite(value)) throw new Error('invalid-limit');
  return Math.min(Math.max(Math.trunc(value), 1), maximum);
};
const boundedCursor = (value: string | undefined) => {
  if (value === undefined) return 0;
  const cursor = Number(value);
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error('invalid-cursor');
  return cursor;
};

export class SQLiteStore {
  readonly db: Database.Database;
  readonly readonlyMode: boolean;

  constructor(file = ':memory:', options: SQLiteStoreOptions = {}) {
    this.readonlyMode = options.readonly === true;
    if (this.readonlyMode) {
      // A diagnostic reader must never create a database, widen a schema or take ownership.
      if (file === ':memory:') throw new Error('readonly-store-requires-file');
      if (!fs.existsSync(file)) throw new Error('store-not-found');
      this.db = new Database(file, { readonly: true, fileMustExist: true });
      this.db.pragma('query_only = ON');
      return;
    }
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    const applied = this.schemaVersion();
    if (applied > SUPPORTED_SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`database-schema-too-new:${applied}>${SUPPORTED_SCHEMA_VERSION}`);
    }
    if (applied > 0 && applied < SUPPORTED_SCHEMA_VERSION && file !== ':memory:' && options.backupBeforeMigrate !== false) {
      // SQLite backup API (VACUUM INTO) produces a consistent snapshot including WAL pages;
      // a single-file copy would miss them. A failed backup aborts migration before writes.
      const target = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    }
    this.migrate();
  }

  private schemaVersion(): number {
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (!table) return 0;
    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version?: number } | undefined;
    return Number(row?.version ?? 0);
  }

  private hasColumn(table: string, column: string): boolean {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(item => item.name === column);
  }

  private addColumn(table: string, definition: string) {
    const name = definition.split(' ')[0]!;
    if (!this.hasColumn(table, name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }

  /** Each version commits in its own transaction; a failure rolls back that step only. */
  private applyVersion(version: number, step: () => void) {
    const applied = this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version);
    if (applied) return;
    this.db.transaction(() => {
      step();
      this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, now());
    })();
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
    if (!this.hasColumn('action_receipts', 'payload_hash')) this.db.exec('ALTER TABLE action_receipts ADD COLUMN payload_hash TEXT');
    for (const version of [1, 2, 3, 4]) {
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, now());
    }
    })();
    // Widening primary keys rebuilds tables, so it runs outside the schema DDL transaction.
    this.db.transaction(() => {
      this.scopeMemoryKeys('places', 'place_id');
      this.scopeMemoryKeys('episodes', 'episode_id');
      this.ensureMemoryColumns('places', ['revision INTEGER NOT NULL DEFAULT 0', 'provenance_json TEXT', 'invalidated_reason TEXT', 'updated_at TEXT']);
      this.ensureMemoryColumns('episodes', ['revision INTEGER NOT NULL DEFAULT 0', 'provenance_json TEXT', 'updated_at TEXT']);
      // Indexes back the bounded, scope-filtered pagination; no query loads the whole table.
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_places_scope ON places(place_id,
        json_extract(context, '$.serverProfileId'), json_extract(context, '$.accountId'),
        json_extract(context, '$.worldGenerationId'), json_extract(context, '$.dimensionId'))`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_scope ON episodes(episode_id,
        json_extract(context, '$.serverProfileId'), json_extract(context, '$.accountId'),
        json_extract(context, '$.worldGenerationId'), json_extract(context, '$.dimensionId'),
        json_extract(summary_json, '$.kind'))`);
    })();
    // Migration steps come from the exported constant so the applied set is provable (S04).
    for (const version of SCHEMA_MIGRATIONS) {
      if (version === 5) this.applyVersion(5, () => this.migrateV5());
      else if (version === 6) this.applyVersion(6, () => this.migrateV6());
      else if (version === 7) this.applyVersion(7, () => this.migrateV7());
    }
  }

  /**
   * Migration 5: durable execution/goal identity. Legacy rows are derived from recorded body
   * context only when every stable field is present; anything else stays explicitly unresolved
   * instead of being guessed into the current world.
   */
  private migrateV5() {
    for (const definition of ['context_json TEXT', 'scope_key TEXT', "context_status TEXT NOT NULL DEFAULT 'unresolved'", 'bundle_digest TEXT', 'revision INTEGER NOT NULL DEFAULT 0']) {
      this.addColumn('executions', definition);
    }
    this.addColumn('goals', 'scope_key TEXT');
    this.addColumn('goals', "context_status TEXT NOT NULL DEFAULT 'unresolved'");
    this.addColumn('effects', 'scope_key TEXT');
    this.addColumn('effects', "context_status TEXT NOT NULL DEFAULT 'unresolved'");
    const scopeOf = (raw: unknown): StableScope | undefined => {
      let value = raw;
      if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return undefined; } }
      const resolved = resolveStableScope(value as Record<string, unknown>);
      return resolved.status === 'resolved' ? resolved.scope : undefined;
    };
    for (const goal of this.db.prepare('SELECT goal_id, body_context FROM goals').all() as Array<{ goal_id: string; body_context: string }>) {
      const scope = scopeOf(goal.body_context);
      if (scope) this.db.prepare("UPDATE goals SET scope_key=?, context_status='resolved' WHERE goal_id=?").run(canonicalScopeKey(scope), goal.goal_id);
    }
    for (const execution of this.db.prepare(`SELECT e.execution_id, e.goal_id, g.body_context FROM executions e
      LEFT JOIN goals g ON g.goal_id=e.goal_id`).all() as Array<{ execution_id: string; goal_id: string; body_context?: string }>) {
      const scope = scopeOf(execution.body_context);
      if (!scope) continue;
      this.db.prepare("UPDATE executions SET scope_key=?, context_status='resolved', context_json=? WHERE execution_id=?")
        .run(canonicalScopeKey(scope), JSON.stringify(scope), execution.execution_id);
    }
    for (const effect of this.db.prepare('SELECT effect_id, context FROM effects').all() as Array<{ effect_id: string; context: string }>) {
      const scope = scopeOf(effect.context);
      if (scope) this.db.prepare("UPDATE effects SET scope_key=?, context_status='resolved' WHERE effect_id=?").run(canonicalScopeKey(scope), effect.effect_id);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_goals_scope ON goals(scope_key, status, goal_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_executions_scope ON executions(scope_key, status, execution_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_effects_scope ON effects(scope_key, execution_id, effect_id)');
  }

  /** Migration 6: effect revisions, attribution, append-only transitions and logical action keys. */
  private migrateV6() {
    for (const definition of ['revision INTEGER NOT NULL DEFAULT 0', 'parent_effect_id TEXT', 'logical_action_id TEXT',
      'action_ordinal INTEGER', 'target_satisfied INTEGER', 'attribution TEXT',
      "evidence_level TEXT NOT NULL DEFAULT 'legacy-unreviewed'"]) {
      this.addColumn('effects', definition);
    }
    // Legacy effects keep their identity and status; only the audit fields are backfilled.
    this.db.prepare("UPDATE effects SET logical_action_id='legacy:'||effect_id WHERE logical_action_id IS NULL").run();
    this.db.prepare('UPDATE effects SET action_ordinal=0 WHERE action_ordinal IS NULL').run();
    this.db.exec(`CREATE TABLE IF NOT EXISTS effect_transitions(
      effect_id TEXT NOT NULL, revision INTEGER NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
      actor TEXT NOT NULL, evidence_ref TEXT, created_at TEXT NOT NULL, PRIMARY KEY(effect_id, revision))`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_effect_logical
      ON effects(execution_id, logical_action_id, action_ordinal) WHERE logical_action_id IS NOT NULL`);
  }

  /** Migration 7: receipt replay identity, place time basis/verification and shutdown interlock. */
  private migrateV7() {
    for (const definition of ['request_json_hash TEXT', 'full_result_json TEXT', 'result_code TEXT',
      "context_status TEXT NOT NULL DEFAULT 'unresolved'"]) {
      this.addColumn('action_receipts', definition);
    }
    this.addColumn('places', "time_basis TEXT NOT NULL DEFAULT 'unknown'");
    this.addColumn('places', "verification_status TEXT NOT NULL DEFAULT 'unverified'");
    // Existing timestamps came from an unrecorded clock domain: never reinterpret them as UTC.
    this.db.prepare("UPDATE places SET time_basis='unknown' WHERE time_basis IS NULL OR time_basis=''").run();
    this.db.prepare("UPDATE places SET verification_status='legacy-unreviewed' WHERE status='known'").run();
    this.db.exec(`CREATE TABLE IF NOT EXISTS runtime_control_interlock(
      id INTEGER PRIMARY KEY CHECK(id=1), status TEXT NOT NULL, updated_at TEXT NOT NULL,
      child_identity_json TEXT, helper_identity_json TEXT, reason TEXT)`);
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
    const scope = resolveStableScope((goal.context && typeof goal.context === 'object' ? goal.context : undefined) as Record<string, unknown> | undefined);
    const scopeKey = scope.status === 'resolved' ? canonicalScopeKey(scope.scope) : null;
    const contextStatus = scope.status === 'resolved' ? 'resolved' : 'unresolved';
    // Goal prose is model-authored and may echo operator secrets; redact at the persistence
    // boundary so every read path (HTTP, CLI, trace) inherits the protection (FEC-57).
    const text = String(redact(goal.text));
    this.db.prepare(`INSERT INTO goals(goal_id,revision,status,body_context,spec_json,created_at,updated_at,scope_key,context_status)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET revision=excluded.revision,
      status=excluded.status, body_context=excluded.body_context, spec_json=excluded.spec_json, updated_at=excluded.updated_at,
      scope_key=excluded.scope_key, context_status=excluded.context_status
      WHERE goals.revision=excluded.revision-1`)
      .run(goal.goalId, goal.revision, goal.status, json(goal.context ?? 'simulated'), json({ text }), timestamp, timestamp, scopeKey, contextStatus);
    // A write that loses the revision race (or rolls the revision back) must fail, not silently no-op.
    const stored = this.getGoal(goal.goalId);
    if (!stored || stored.revision !== goal.revision) throw new Error(`goal-revision-conflict:${stored?.revision ?? 0}`);
  }

  getGoal(id: string) {
    const row = this.db.prepare('SELECT * FROM goals WHERE goal_id=?').get(id) as any;
    return row ? { ...row, context: parse(row.body_context), spec: parse(row.spec_json) } : undefined;
  }

  /** Read a goal only when it belongs to the given canonical scope (G7). A foreign id is not a handle. */
  getGoalScoped(id: string, scopeKey: string) {
    const row = this.db.prepare('SELECT * FROM goals WHERE goal_id=? AND scope_key=?').get(id, scopeKey) as any;
    return row ? { ...row, context: parse(row.body_context), spec: parse(row.spec_json) } : undefined;
  }

  /**
   * Resolve the durable stable scope an execution belongs to (v0.2 semantics): the explicit
   * `e.context` when supplied, otherwise the originating goal's body context, otherwise the
   * context of an effect already written for this execution. An execution with no derivable
   * scope stays explicitly unscoped and is hidden from every scoped control read rather than
   * being guessed into the current world.
   */
  private executionContext(e: any): { context: unknown; scopeKey: string | null; contextStatus: string } {
    let context: unknown = e.context;
    if (context === undefined && typeof e.goalId === 'string') {
      const goal = this.getGoal(e.goalId);
      if (goal && goal.context !== undefined) context = goal.context;
    }
    if (context === undefined && typeof e.executionId === 'string') {
      const effect = this.db.prepare('SELECT context FROM effects WHERE execution_id=? ORDER BY effect_id LIMIT 1').get(e.executionId) as { context?: string } | undefined;
      if (effect?.context) context = parse(effect.context);
    }
    const scope = resolveStableScope((context && typeof context === 'object' ? context : undefined) as Record<string, unknown> | undefined);
    return {
      context: context ?? null,
      scopeKey: scope.status === 'resolved' ? canonicalScopeKey(scope.scope) : null,
      contextStatus: scope.status === 'resolved' ? 'resolved' : 'unresolved',
    };
  }

  saveExecution(e: any) {
    const existing = this.db.prepare('SELECT * FROM executions WHERE proposal_id=?').get(e.proposalId) as any;
    if (existing) {
      if (existing.proposal_hash !== e.proposalHash) throw new Error('proposal-id-conflict');
      // A late writer must not resurrect or overwrite a terminal execution.
      if (executionTerminal.has(existing.status) && existing.status !== e.status) return this.getExecution(existing.execution_id) ?? this.getExecution(existing.proposal_id);
      // The scope is captured once, at first write; a later status update must not re-derive it
      // (the goal may have moved) or clear it when the caller omits the context.
      this.db.prepare(`UPDATE executions SET status=?, reason=COALESCE(?,reason), outcome=COALESCE(?,outcome),
        checkpoint_json=COALESCE(?,checkpoint_json) WHERE proposal_id=?`)
        .run(e.status, e.reason ?? null, e.outcome ?? null, e.checkpoint ? json(e.checkpoint) : null, e.proposalId);
      return this.getExecution(e.executionId) ?? this.getExecution(e.proposalId);
    }
    const { context, scopeKey, contextStatus } = this.executionContext(e);
    this.db.prepare(`INSERT INTO executions(execution_id,proposal_id,proposal_hash,goal_id,skill_id,skill_version,
      status,reason,outcome,checkpoint_json,context_json,scope_key,context_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(e.executionId, e.proposalId, e.proposalHash, e.goalId, e.skillId, e.skillVersion, e.status,
        e.reason ?? null, e.outcome ?? null, e.checkpoint ? json(e.checkpoint) : null,
        context === null ? null : json(context), scopeKey, contextStatus);
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
      context: row.context_json ? parse(row.context_json) : undefined,
      scopeKey: row.scope_key ?? undefined,
      contextStatus: row.context_status ?? 'unresolved',
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

  private insertEffectTransition(effectId: string, revision: number, fromStatus: string | undefined, toStatus: string, actor: string, evidenceRef?: string) {
    this.db.prepare(`INSERT OR IGNORE INTO effect_transitions(effect_id,revision,from_status,to_status,actor,evidence_ref,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(effectId, revision, fromStatus ?? null, toStatus, actor, evidenceRef ?? null, now());
  }

  addEffect(e: any) {
    if (!effectStatuses.includes(e.status)) throw new Error(`invalid-effect-status:${e.status}`);
    const intent = redact(e.intent);
    const context = redact(e.context);
    const evidence = e.evidence === undefined ? undefined : redact(e.evidence);
    const existing = this.db.prepare('SELECT * FROM effects WHERE effect_id=?').get(e.effectId) as any;
    const scope = resolveStableScope((typeof e.context === 'string' ? (() => { try { return JSON.parse(e.context); } catch { return undefined; } })() : e.context) as Record<string, unknown>);
    const scopeKey = scope.status === 'resolved' ? canonicalScopeKey(scope.scope) : null;
    const contextStatus = scope.status === 'resolved' ? 'resolved' : 'unresolved';
    if (existing) {
      if (existing.execution_id !== e.executionId || !sameJson(parse(existing.context), context) || !sameJson(parse(existing.intent_json), intent)) throw new Error('effect-id-conflict');
      if (!legalEffectTransition(existing.status, e.status)) throw new Error(`invalid-effect-transition:${existing.status}->${e.status}`);
      if (existing.status === e.status && evidence === undefined) return this.getEffect(e.effectId);
      const revision = Number(existing.revision ?? 0) + 1;
      this.db.prepare('UPDATE effects SET status=?, evidence_json=COALESCE(?, evidence_json), revision=? WHERE effect_id=?')
        .run(e.status, evidence === undefined ? null : json(evidence), revision, e.effectId);
      this.insertEffectTransition(e.effectId, revision, existing.status, e.status, 'addEffect', typeof e.evidenceRef === 'string' ? e.evidenceRef : undefined);
      return this.getEffect(e.effectId);
    }
    this.db.prepare(`INSERT INTO effects(effect_id,execution_id,context,status,intent_json,evidence_json,scope_key,context_status,
      revision,parent_effect_id,logical_action_id,action_ordinal,target_satisfied,attribution,evidence_level)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      e.effectId, e.executionId, json(context), e.status, json(intent), evidence === undefined ? null : json(evidence),
      scopeKey, contextStatus, 0, e.parentEffectId ?? null, e.logicalActionId ?? `single:${e.effectId}`,
      Number.isInteger(e.actionOrdinal) ? e.actionOrdinal : 0, e.targetSatisfied === undefined ? null : (e.targetSatisfied ? 1 : 0),
      e.attribution ?? null, e.evidenceLevel ?? 'synthetic-contract');
    this.insertEffectTransition(e.effectId, 0, undefined, e.status, 'create', undefined);
    return this.getEffect(e.effectId);
  }

  getEffect(effectId: string) {
    const row = this.db.prepare('SELECT * FROM effects WHERE effect_id=?').get(effectId) as any;
    return this.effectRow(row);
  }

  private effectRow(row: any) {
    return row ? {
      ...row, effectId: row.effect_id, executionId: row.execution_id, context: parse(row.context),
      intent: parse(row.intent_json), evidence: row.evidence_json ? parse(row.evidence_json) : undefined,
      scopeKey: row.scope_key ?? undefined, contextStatus: row.context_status ?? 'unresolved',
      revision: Number(row.revision ?? 0), parentEffectId: row.parent_effect_id ?? undefined,
      logicalActionId: row.logical_action_id ?? undefined, actionOrdinal: row.action_ordinal ?? undefined,
      targetSatisfied: row.target_satisfied === null || row.target_satisfied === undefined ? undefined : Boolean(row.target_satisfied),
      attribution: row.attribution ?? undefined, evidenceLevel: row.evidence_level ?? undefined,
    } : undefined;
  }

  /**
   * Exhaustive transition result. Callers must handle conflict and invalid explicitly; no
   * "higher rank silently wins" path remains (FEC-24). `expectedRevision` enables CAS.
   */
  transitionEffect(effectId: string, status: string, evidence: unknown, options: { actor?: string; expectedRevision?: number; evidenceRef?: string } = {}):
    | { status: 'applied'; effect: NonNullable<ReturnType<SQLiteStore['getEffect']>> }
    | { status: 'conflict'; effect: NonNullable<ReturnType<SQLiteStore['getEffect']>>; reason: string }
    | { status: 'invalid'; reason: string; effect?: NonNullable<ReturnType<SQLiteStore['getEffect']>> } {
    if (!effectStatuses.includes(status as typeof effectStatuses[number])) return { status: 'invalid', reason: `invalid-effect-status:${status}` };
    return this.transaction(() => {
      const current = this.getEffect(effectId);
      if (!current) return { status: 'invalid' as const, reason: 'effect-not-found' };
      if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
        return { status: 'conflict' as const, effect: current, reason: `effect-revision-conflict:${current.revision}` };
      }
      if (!legalEffectTransition(current.status, status)) {
        return { status: 'invalid' as const, reason: `invalid-effect-transition:${current.status}->${status}`, effect: current };
      }
      if (current.status === status && evidence === undefined) return { status: 'applied' as const, effect: current };
      const revision = current.revision + 1;
      this.db.prepare('UPDATE effects SET status=?, evidence_json=COALESCE(?, evidence_json), revision=? WHERE effect_id=?')
        .run(status, evidence === undefined ? null : json(redact(evidence)), revision, effectId);
      this.insertEffectTransition(effectId, revision, current.status, status, options.actor ?? 'system', options.evidenceRef);
      return { status: 'applied' as const, effect: this.getEffect(effectId)! };
    });
  }

  /** Compatibility wrapper. Illegal transitions throw instead of silently returning the old row. */
  updateEffect(effectId: string, status: string, evidence?: unknown) {
    const result = this.transitionEffect(effectId, status, evidence, { actor: 'updateEffect' });
    if (result.status === 'invalid') throw new Error(result.reason);
    if (result.status === 'conflict') throw new Error(result.reason);
    return result.effect;
  }

  effectTransitions(effectId: string) {
    return (this.db.prepare('SELECT * FROM effect_transitions WHERE effect_id=? ORDER BY revision').all(effectId) as any[])
      .map(row => ({ effectId: row.effect_id, revision: Number(row.revision), fromStatus: row.from_status ?? undefined, toStatus: row.to_status, actor: row.actor, evidenceRef: row.evidence_ref ?? undefined, createdAt: row.created_at }));
  }

  pendingEffects() {
    return (this.db.prepare("SELECT * FROM effects WHERE status NOT IN ('confirmed','partial','not-dispatched') ORDER BY effect_id").all() as any[])
      .map(row => this.effectRow(row));
  }

  private receiptRow(row: any) {
    return row ? {
      ...row, result: row.result_json ? parse(row.result_json) : undefined,
      context: row.context_json ? parse(row.context_json) : undefined,
      payloadHash: row.payload_hash ?? undefined, requestJsonHash: row.request_json_hash ?? undefined,
      code: row.result_code ?? undefined, fullResult: row.full_result_json ? parse(row.full_result_json) : undefined,
      contextStatus: row.context_status ?? 'unresolved',
    } : undefined;
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
        this.db.prepare(`UPDATE action_receipts SET status=?, result_json=COALESCE(?, result_json), context_json=COALESCE(?, context_json),
          request_json_hash=COALESCE(?, request_json_hash), full_result_json=COALESCE(?, full_result_json),
          result_code=COALESCE(?, result_code), updated_at=? WHERE scope=? AND command_id=?`)
          .run(receipt.status, receipt.result === undefined ? null : json(redact(receipt.result)),
            receipt.context === undefined ? null : json(redact(receipt.context)), receipt.requestJsonHash ?? null,
            receipt.fullResult === undefined ? null : json(redact(receipt.fullResult)), receipt.code ?? null, now(), receipt.scope, receipt.commandId);
      }
      return this.getActionReceipt(receipt.scope, receipt.commandId);
    }
    const timestamp = now();
    this.db.prepare(`INSERT INTO action_receipts(receipt_id,scope,command_id,status,result_json,context_json,payload_hash,
      created_at,updated_at,request_json_hash,full_result_json,result_code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(receipt.receiptId, receipt.scope, receipt.commandId, receipt.status,
        receipt.result === undefined ? null : json(redact(receipt.result)),
        receipt.context === undefined ? null : json(redact(receipt.context)), payloadHash ?? null,
        receipt.createdAt ?? timestamp, timestamp, receipt.requestJsonHash ?? null,
        receipt.fullResult === undefined ? null : json(redact(receipt.fullResult)), receipt.code ?? null);
    return this.getActionReceipt(receipt.scope, receipt.commandId);
  }

  updateActionReceipt(scope: string, commandId: string, status: string, result?: unknown, context?: unknown,
    extra: { code?: string; fullResult?: unknown; requestJsonHash?: string; contextStatus?: string } = {}) {
    if (!receiptStatuses.includes(status as typeof receiptStatuses[number])) throw new Error(`invalid-receipt-status:${status}`);
    const existing = this.getActionReceipt(scope, commandId);
    if (!existing) throw new Error('receipt-not-found');
    if (receiptTerminal.has(existing.status) && existing.status !== status) return existing;
    this.db.prepare(`UPDATE action_receipts SET status=?, result_json=COALESCE(?, result_json), context_json=COALESCE(?, context_json),
      result_code=COALESCE(?, result_code), full_result_json=COALESCE(?, full_result_json),
      request_json_hash=COALESCE(?, request_json_hash), context_status=COALESCE(?, context_status), updated_at=?
      WHERE scope=? AND command_id=?`)
      .run(status, result === undefined ? null : json(redact(result)), context === undefined ? null : json(redact(context)),
        extra.code ?? null, extra.fullResult === undefined ? null : json(redact(extra.fullResult)),
        extra.requestJsonHash ?? null, extra.contextStatus ?? null, now(), scope, commandId);
    return this.getActionReceipt(scope, commandId);
  }

  getActionReceipt(scope: string, commandId: string) {
    const row = this.db.prepare('SELECT * FROM action_receipts WHERE scope=? AND command_id=?').get(scope, commandId) as any;
    return this.receiptRow(row);
  }

  hasActionReceipt(scope: string, commandId: string) { return this.getActionReceipt(scope, commandId) !== undefined; }

  /**
   * Settle receipts that were still pending when the previous process died. The command may or
   * may not have taken effect, so the only truthful durable state is `unknown`; a replay must not
   * keep reporting `accepted` for work nothing is progressing.
   */
  recoverPendingReceipts(reason = 'recovered-after-restart') {
    return this.transaction(() => {
      const pending = this.db.prepare("SELECT scope, command_id FROM action_receipts WHERE status='pending'").all() as Array<{ scope: string; command_id: string }>;
      const update = this.db.prepare(`UPDATE action_receipts SET status='unknown', context_json=COALESCE(context_json, ?), updated_at=?
        WHERE scope=? AND command_id=? AND status='pending'`);
      const timestamp = now();
      const recoveryContext = json({ recovery: reason });
      for (const row of pending) update.run(recoveryContext, timestamp, row.scope, row.command_id);
      return pending.length;
    });
  }

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

  /** Production read: only rows whose durable scope matches. Unresolved history is diagnostics-only. */
  listExecutionsScoped(scopeKey: string) {
    return (this.db.prepare('SELECT execution_id FROM executions WHERE scope_key=? ORDER BY execution_id').all(scopeKey) as { execution_id: string }[])
      .map(row => this.getExecution(row.execution_id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  }

  countExecutions(scopeKey?: string) {
    const row = scopeKey === undefined
      ? this.db.prepare('SELECT COUNT(*) AS count FROM executions').get()
      : this.db.prepare('SELECT COUNT(*) AS count FROM executions WHERE scope_key=?').get(scopeKey);
    return Number((row as { count: number }).count);
  }

  /**
   * Bounded, paginated control read (G7). Rows whose durable scope_key matches the attached
   * stable identity are loaded, and legacy rows with no derivable scope (`scope_key IS NULL`)
   * are included: they predate the scope column and v0.2 matched them with a NULL-matching
   * predicate, so a scope-less fixture execution is still visible to a `stop`/status read
   * instead of silently escaping cancellation. `limit + 1` detects truncation.
   */
  listExecutionsPageForScope(read: StableScopeRead, options: { limit?: number; cursor?: string } = {}) {
    const limit = boundedLimit(options.limit);
    const start = boundedCursor(options.cursor);
    const rows = (this.db.prepare('SELECT execution_id FROM executions WHERE scope_key=? OR scope_key IS NULL ORDER BY execution_id LIMIT CAST(? AS INTEGER) OFFSET CAST(? AS INTEGER)')
      .all(read.scopeKey, limit + 1, start) as Array<{ execution_id: string }>)
      .map(row => this.getExecution(row.execution_id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
    return { items: rows.slice(0, limit), truncated: rows.length > limit, ...(rows.length > limit ? { nextCursor: String(start + limit) } : {}) };
  }

  /**
   * Bounded, paginated effect read (G7). Legacy rows written before the scope column existed
   * (or by a body that omits account identity) have `scope_key IS NULL`; they are included, as
   * v0.2 matched them with a NULL-matching predicate, so an ambiguous effect the runtime itself
   * just recorded is never hidden from the control read that must report it.
   */
  listEffectsPageForScope(read: StableScopeRead, options: { executionId?: string; limit?: number; cursor?: string } = {}) {
    const limit = boundedLimit(options.limit);
    const start = boundedCursor(options.cursor);
    const clauses = ['(scope_key=? OR scope_key IS NULL)'];
    const values: unknown[] = [read.scopeKey];
    if (options.executionId !== undefined) { clauses.push('execution_id=?'); values.push(options.executionId); }
    const rows = (this.db.prepare(`SELECT * FROM effects WHERE ${clauses.join(' AND ')} ORDER BY effect_id LIMIT CAST(? AS INTEGER) OFFSET CAST(? AS INTEGER)`)
      .all(...values, limit + 1, start) as any[]).map(row => this.effectRow(row));
    return { items: rows.slice(0, limit), truncated: rows.length > limit, ...(rows.length > limit ? { nextCursor: String(start + limit) } : {}) };
  }

  listGoalsPageForScope(read: StableScopeRead, options: { limit?: number; cursor?: string } = {}) {
    const limit = boundedLimit(options.limit);
    const start = boundedCursor(options.cursor);
    const rows = (this.db.prepare('SELECT goal_id FROM goals WHERE scope_key=? ORDER BY goal_id LIMIT CAST(? AS INTEGER) OFFSET CAST(? AS INTEGER)')
      .all(read.scopeKey, limit + 1, start) as Array<{ goal_id: string }>)
      .map(row => this.getGoal(row.goal_id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
    return { items: rows.slice(0, limit), truncated: rows.length > limit, ...(rows.length > limit ? { nextCursor: String(start + limit) } : {}) };
  }

  listEffects(executionId?: string) {
    const rows = (executionId
      ? this.db.prepare('SELECT * FROM effects WHERE execution_id=? ORDER BY effect_id').all(executionId)
      : this.db.prepare('SELECT * FROM effects ORDER BY effect_id').all()) as any[];
    return rows.map(row => this.effectRow(row));
  }

  /**
   * Bounded SQL page; `limit + 1` detects truncation without counting the table (FEC-56).
   * A production caller passes scopeKey so another world's effects never load at all.
   */
  listEffectsPage(executionId: string | undefined, options: { scopeKey?: string; limit?: number; cursor?: string; maxLimit?: number } = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), options.maxLimit ?? 100);
    const after = options.cursor ?? '';
    const clauses: string[] = ['effect_id>?'];
    const values: unknown[] = [after];
    if (executionId !== undefined) { clauses.push('execution_id=?'); values.push(executionId); }
    if (options.scopeKey !== undefined) { clauses.push('scope_key=?'); values.push(options.scopeKey); }
    values.push(limit + 1);
    const rows = (this.db.prepare(`SELECT * FROM effects WHERE ${clauses.join(' AND ')} ORDER BY effect_id LIMIT CAST(? AS INTEGER)`).all(...values) as any[])
      .map(row => this.effectRow(row));
    const items = rows.slice(0, limit);
    return { items, truncated: rows.length > limit, ...(rows.length > limit ? { nextCursor: items[items.length - 1]?.effectId } : {}) };
  }

  countEffects(scopeKey?: string) {
    const row = scopeKey === undefined
      ? this.db.prepare('SELECT COUNT(*) AS count FROM effects').get()
      : this.db.prepare('SELECT COUNT(*) AS count FROM effects WHERE scope_key=?').get(scopeKey);
    return Number((row as { count: number }).count);
  }

  effectStatusCounts(scopeKey?: string) {
    const rows = (scopeKey === undefined
      ? this.db.prepare('SELECT status, COUNT(*) AS count FROM effects GROUP BY status').all()
      : this.db.prepare('SELECT status, COUNT(*) AS count FROM effects WHERE scope_key=? GROUP BY status').all(scopeKey)) as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
  }

  listActionReceipts(scope?: string) {
    const rows = (scope
      ? this.db.prepare('SELECT * FROM action_receipts WHERE scope=? ORDER BY created_at').all(scope)
      : this.db.prepare('SELECT * FROM action_receipts ORDER BY created_at').all()) as any[];
    return rows.map(row => this.receiptRow(row));
  }

  listGoals() {
    return (this.db.prepare('SELECT goal_id FROM goals ORDER BY goal_id').all() as { goal_id: string }[])
      .map(row => this.getGoal(row.goal_id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  }

  /** Production read: scoped goals only. A goal with unresolved scope never drives autonomy. */
  listGoalsScoped(scopeKey: string, status?: string) {
    const rows = (status === undefined
      ? this.db.prepare('SELECT goal_id FROM goals WHERE scope_key=? ORDER BY goal_id').all(scopeKey)
      : this.db.prepare('SELECT goal_id FROM goals WHERE scope_key=? AND status=? ORDER BY goal_id').all(scopeKey, status)) as Array<{ goal_id: string }>;
    return rows.map(row => this.getGoal(row.goal_id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  }

  countGoals(scopeKey?: string) {
    const row = scopeKey === undefined
      ? this.db.prepare('SELECT COUNT(*) AS count FROM goals').get()
      : this.db.prepare('SELECT COUNT(*) AS count FROM goals WHERE scope_key=?').get(scopeKey);
    return Number((row as { count: number }).count);
  }

  /** Shutdown interlock: closing/clean/uncertain survives process death for the next owner. */
  setRuntimeInterlock(status: string, details: { childIdentity?: unknown; helperIdentity?: unknown; reason?: string } = {}) {
    this.db.prepare(`INSERT INTO runtime_control_interlock(id,status,updated_at,child_identity_json,helper_identity_json,reason)
      VALUES (1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at,
      child_identity_json=excluded.child_identity_json, helper_identity_json=excluded.helper_identity_json, reason=excluded.reason`)
      .run(status, now(), details.childIdentity === undefined ? null : json(details.childIdentity),
        details.helperIdentity === undefined ? null : json(details.helperIdentity), details.reason ?? null);
  }

  getRuntimeInterlock() {
    const row = this.db.prepare('SELECT * FROM runtime_control_interlock WHERE id=1').get() as any;
    return row ? {
      status: row.status, updatedAt: row.updated_at,
      childIdentity: row.child_identity_json ? parse(row.child_identity_json) : undefined,
      helperIdentity: row.helper_identity_json ? parse(row.helper_identity_json) : undefined,
      reason: row.reason ?? undefined,
    } : undefined;
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

  savePlace(place: { placeId: string; context: unknown; status: string; lastVerifiedAt?: string; payload: unknown; provenance?: unknown; revision?: number; expectedRevision?: number; invalidatedReason?: string; timeBasis?: string; verificationStatus?: string }) {
    // A place id is only unique inside its scope: the same place in another world must not
    // overwrite this one. Legacy single-column layouts are widened to (place_id, context).
    const reuse = place.context === undefined ? undefined : this.findPlaceByScope(place.placeId, place.context) as { rowid: number; revision: number; provenance?: unknown; time_basis?: string; verification_status?: string } | undefined;
    const timestamp = now();
    if (reuse) {
      if (place.expectedRevision !== undefined && Number(reuse.revision ?? 0) !== place.expectedRevision) throw new Error(`place-revision-conflict:${Number(reuse.revision ?? 0)}`);
      const revision = Number(reuse.revision ?? 0) + 1;
      const provenance = place.provenance === undefined ? reuse.provenance ?? null : json(place.provenance);
      this.db.prepare(`UPDATE places SET context=?, status=?, last_verified_at=?, payload_json=?, revision=?, provenance_json=?,
        invalidated_reason=?, updated_at=?, time_basis=?, verification_status=? WHERE rowid=?`)
        .run(json(place.context), place.status, place.lastVerifiedAt ?? null, json(place.payload), revision, provenance,
          place.status === 'invalid' ? place.invalidatedReason ?? null : null, timestamp,
          place.timeBasis ?? reuse.time_basis ?? 'unknown', place.verificationStatus ?? reuse.verification_status ?? 'unverified', reuse.rowid);
    } else {
      this.db.prepare(`INSERT INTO places(place_id,context,status,last_verified_at,payload_json,revision,provenance_json,invalidated_reason,updated_at,time_basis,verification_status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(place.placeId, json(place.context), place.status, place.lastVerifiedAt ?? null, json(place.payload),
          Math.max(0, place.revision ?? 0), place.provenance === undefined ? null : json(place.provenance),
          place.status === 'invalid' ? place.invalidatedReason ?? null : null, timestamp,
          place.timeBasis ?? 'unknown', place.verificationStatus ?? 'unverified');
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
    const predicate = scopePredicate(core);
    return this.placeRow(this.db.prepare(`SELECT rowid, * FROM places WHERE place_id=? AND ${predicate.sql} ORDER BY rowid DESC LIMIT 1`).get(placeId, ...predicate.values) as any);
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
        const predicate = scopePredicate(core);
        where = predicate.sql;
        values.push(...predicate.values);
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

  /**
   * Scoped places page keyed on the attached stable identity (G7). The predicate matches the
   * identity fields a place row actually carries (a body context uses `dimension`, memory
   * scopes use `dimensionId`); a foreign account/world is never returned and truncation is
   * reported so a page is never mistaken for the whole table.
   */
  listPlacesPageForScope(read: StableScopeRead, options: { status?: string; limit?: number; cursor?: string } = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 50);
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isInteger(start) || start < 0) throw new Error('invalid-memory-cursor');
    const predicate = this.columnScopeWhere(read.scope, 'context');
    const clauses = [predicate.sql];
    const values: unknown[] = [...predicate.values];
    if (options.status) { clauses.push('status=?'); values.push(options.status); }
    values.push(limit + 1, start);
    const rows = (this.db.prepare(`SELECT * FROM places WHERE ${clauses.join(' AND ')} ORDER BY place_id, context LIMIT CAST(? AS INTEGER) OFFSET CAST(? AS INTEGER)`)
      .all(...values) as any[]).map(row => this.placeRow(row)).filter((row): row is NonNullable<typeof row> => Boolean(row));
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
      timeBasis: row.time_basis ?? 'unknown',
      verificationStatus: row.verification_status ?? 'unverified',
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
   * Strict scope predicate over a named JSON column (G7). An omitted stable field matches only
   * rows that also omit it, so a read can never widen to another account/world by dropping a
   * field. A stored body context uses `dimension`; a memory scope uses `dimensionId`; both are
   * accepted for the dimension key.
   */
  private columnScopeWhere(scope: StableScope, column: string): { sql: string; values: unknown[] } {
    const clauses: string[] = []; const values: unknown[] = [];
    const expression = (key: (typeof MEMORY_SCOPE_KEYS)[number]) => key === 'dimensionId'
      ? `COALESCE(json_extract(${column}, '$.dimensionId'), json_extract(${column}, '$.dimension'))`
      : `json_extract(${column}, '$.${key}')`;
    for (const key of MEMORY_SCOPE_KEYS) {
      const value = key === 'dimensionId' ? scope.dimensionId : (scope as unknown as Record<string, unknown>)[key];
      if (typeof value === 'string' && value) { clauses.push(`${expression(key)}=?`); values.push(value); }
      else clauses.push(`${expression(key)} IS NULL`);
    }
    return { sql: clauses.join(' AND '), values };
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
