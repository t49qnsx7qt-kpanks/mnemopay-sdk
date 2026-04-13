/**
 * SQLite Persistence Layer for MnemoPay
 *
 * Replaces toy JSON file persistence with production-grade SQLite.
 * Zero-config, ACID-compliant, single-file database.
 *
 * Requires: better-sqlite3 >= 12.0.0 (bundles SQLite >= 3.52, which fixes a
 * WAL-mode corruption bug present in every SQLite from 3.7.0 through 3.51.2).
 * The SDK peer-dependency pin is ">=12.0.0"; earlier versions are unsupported.
 *
 * ⚠ Operational safety rules for this storage adapter:
 *
 *   1. SINGLE-PROCESS WRITES. Exactly one process may hold a write connection
 *      to a given .db file at any time. Multiple readers are fine. If you need
 *      multi-process access, run a dedicated writer process and have other
 *      processes read via IPC / HTTP, not by opening the same file.
 *
 *   2. NEVER COPY A RUNNING DB WITH fs.copyFile / cp / shutil.copy. In WAL
 *      mode the `-wal` and `-shm` sidecars contain uncommitted state; copying
 *      the main file alone is a known corruption vector. Use SQLite's
 *      `VACUUM INTO 'backup.db'` statement or the online backup API.
 *
 *   3. CLOSE CLEANLY. `SQLiteStorage.close()` runs a WAL checkpoint before
 *      releasing the connection so the main DB file is consistent on exit.
 *      If the process crashes without calling close(), WAL recovery runs the
 *      next time the DB is opened — which is safe but leaves `-wal`/`-shm`
 *      sidecars on disk.
 *
 *   4. DAILY BACKUP. The ledger, Merkle tree, and credit score history live
 *      here. A corrupted ledger is the worst possible failure mode for a
 *      financial SDK. Schedule daily `VACUUM INTO` to an offsite location
 *      and verify backup integrity by opening it in read-only mode.
 *
 * Usage:
 *   import { SQLiteStorage } from "@mnemopay/sdk/storage";
 *   const agent = MnemoPay.quick("id", { storage: new SQLiteStorage("./agent.db") });
 */

export interface StorageAdapter {
  /** Load all persisted state for an agent */
  load(agentId: string): PersistedState | null;
  /** Save agent state atomically */
  save(state: PersistedState): void;
  /** Close the storage connection */
  close(): void;
}

export interface PersistedMemory {
  id: string;
  agentId: string;
  content: string;
  importance: number;
  score: number;
  createdAt: string;
  lastAccessed: string;
  accessCount: number;
  tags: string; // JSON-encoded string[]
}

export interface PersistedTransaction {
  id: string;
  agentId: string;
  amount: number;
  reason: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  platformFee?: number;
  netAmount?: number;
  riskScore?: number;
  externalId?: string;
  externalStatus?: string;
  counterpartyId?: string;
}

export interface PersistedState {
  agentId: string;
  wallet: number;
  reputation: number;
  createdAt: string;
  memories: PersistedMemory[];
  transactions: PersistedTransaction[];
  auditLog: Array<{
    id: string;
    agentId: string;
    action: string;
    details: string; // JSON-encoded
    createdAt: string;
  }>;
  fraudGuard?: any;
  streak?: { currentStreak: number; bestStreak: number; lastSettlement: number; streakBonus: number };
  badges?: Array<{ id: string; name: string; description: string; earnedAt: number }>;
}

// ─── SQLite Storage ─────────────────────────────────────────────────────────

export class SQLiteStorage implements StorageAdapter {
  private db: any;

  /**
   * @param dbPath — Path to SQLite database file (e.g. "./mnemopay.db" or ":memory:")
   */
  constructor(dbPath: string) {
    try {
      const Database = require("better-sqlite3");
      this.db = new Database(dbPath);
    } catch {
      throw new Error("better-sqlite3 not installed. Run: npm install better-sqlite3");
    }

    // Enable WAL mode for better concurrent read performance
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this._createTables();
  }

  private _createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_state (
        agent_id TEXT PRIMARY KEY,
        wallet REAL NOT NULL DEFAULT 0,
        reputation REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL,
        fraud_guard TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_accessed TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (agent_id) REFERENCES agent_state(agent_id)
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        amount REAL NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        platform_fee REAL,
        net_amount REAL,
        risk_score REAL,
        external_id TEXT,
        external_status TEXT,
        counterparty_id TEXT,
        FOREIGN KEY (agent_id) REFERENCES agent_state(agent_id)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agent_state(agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_agent ON transactions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
      CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

      -- FTS5: external-content table to index memories.content safely.
      -- This uses parameterized queries only (no dynamic SQL string concatenation).
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content='memories',
        content_rowid='rowid',
        tokenize='unicode61',
        prefix='2 3'
      );

      -- Keep FTS in sync. These are idempotent.
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
  }

  load(agentId: string): PersistedState | null {
    const state = this.db
      .prepare("SELECT * FROM agent_state WHERE agent_id = ?")
      .get(agentId);

    if (!state) return null;

    const memories = this.db
      .prepare("SELECT * FROM memories WHERE agent_id = ? ORDER BY score DESC")
      .all(agentId);

    const transactions = this.db
      .prepare("SELECT * FROM transactions WHERE agent_id = ? ORDER BY created_at DESC")
      .all(agentId);

    const auditLog = this.db
      .prepare(
        "SELECT * FROM audit_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT 500"
      )
      .all(agentId);

    return {
      agentId: state.agent_id,
      wallet: state.wallet,
      reputation: state.reputation,
      createdAt: state.created_at,
      memories: memories.map((m: any) => ({
        id: m.id,
        agentId: m.agent_id,
        content: m.content,
        importance: m.importance,
        score: m.score,
        createdAt: m.created_at,
        lastAccessed: m.last_accessed,
        accessCount: m.access_count,
        // PersistedMemory expects tags to be a JSON-encoded string
        tags: typeof m.tags === "string" ? m.tags : JSON.stringify(m.tags ?? []),
      })),
      transactions: transactions.map((t: any) => ({
        id: t.id,
        agentId: t.agent_id,
        amount: t.amount,
        reason: t.reason,
        status: t.status,
        createdAt: t.created_at,
        completedAt: t.completed_at,
        platformFee: t.platform_fee,
        netAmount: t.net_amount,
        riskScore: t.risk_score,
        externalId: t.external_id,
        externalStatus: t.external_status,
        counterpartyId: t.counterparty_id,
      })),
      auditLog: auditLog.map((a: any) => ({
        id: a.id,
        agentId: a.agent_id,
        action: a.action,
        details: a.details,
        createdAt: a.created_at,
      })),
      fraudGuard: state.fraud_guard ? JSON.parse(state.fraud_guard) : undefined,
    };
  }

  save(state: PersistedState): void {
    const saveAll = this.db.transaction(() => {
      const now = new Date().toISOString();

      // Upsert agent state
      this.db
        .prepare(`
        INSERT INTO agent_state (agent_id, wallet, reputation, created_at, fraud_guard, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          wallet = excluded.wallet,
          reputation = excluded.reputation,
          fraud_guard = excluded.fraud_guard,
          updated_at = excluded.updated_at
      `)
        .run(
          state.agentId,
          state.wallet,
          state.reputation,
          state.createdAt,
          state.fraudGuard ? JSON.stringify(state.fraudGuard) : null,
          now
        );

      // Upsert memories
      const upsertMem = this.db.prepare(`
        INSERT INTO memories (id, agent_id, content, importance, score, created_at, last_accessed, access_count, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          importance = excluded.importance,
          score = excluded.score,
          last_accessed = excluded.last_accessed,
          access_count = excluded.access_count,
          content = excluded.content,
          tags = excluded.tags
      `);

      for (const m of state.memories) {
        upsertMem.run(
          m.id,
          m.agentId,
          m.content,
          m.importance,
          m.score,
          m.createdAt,
          m.lastAccessed,
          m.accessCount,
          // Persist tags should already be JSON-encoded string in PersistedMemory
          m.tags
        );
      }

      // Clean deleted memories
      if (state.memories.length > 0) {
        const memIds = state.memories.map((m) => m.id);
        const placeholders = memIds.map(() => "?").join(",");
        this.db
          .prepare(
            `DELETE FROM memories WHERE agent_id = ? AND id NOT IN (${placeholders})`
          )
          .run(state.agentId, ...memIds);
      } else {
        this.db.prepare("DELETE FROM memories WHERE agent_id = ?").run(state.agentId);
      }

      // Upsert transactions
      const upsertTx = this.db.prepare(`
        INSERT INTO transactions (id, agent_id, amount, reason, status, created_at, completed_at, platform_fee, net_amount, risk_score, external_id, external_status, counterparty_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          completed_at = excluded.completed_at,
          platform_fee = excluded.platform_fee,
          net_amount = excluded.net_amount,
          risk_score = excluded.risk_score,
          external_status = excluded.external_status,
          counterparty_id = excluded.counterparty_id
      `);

      for (const t of state.transactions) {
        upsertTx.run(
          t.id,
          t.agentId,
          t.amount,
          t.reason,
          t.status,
          t.createdAt,
          t.completedAt || null,
          t.platformFee || null,
          t.netAmount || null,
          t.riskScore || null,
          t.externalId || null,
          t.externalStatus || null,
          t.counterpartyId || null
        );
      }

      // Insert new audit entries (append-only, never update)
      const insertAudit = this.db.prepare(`
        INSERT OR IGNORE INTO audit_log (id, agent_id, action, details, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const a of state.auditLog) {
        insertAudit.run(a.id, a.agentId, a.action, a.details, a.createdAt);
      }

      // Trim old audit entries (keep last 500)
      this.db
        .prepare(`
        DELETE FROM audit_log WHERE agent_id = ? AND id NOT IN (
          SELECT id FROM audit_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT 500
        )
      `)
        .run(state.agentId, state.agentId);
    });

    saveAll();
  }

  close(): void {
    if (this.db) {
      try {
        this.db.pragma("wal_checkpoint(PASSIVE)");
      } catch {
        // swallow: checkpoint is best-effort on close
      }
      this.db.close();
    }
  }

  /**
   * SQLite-backed FTS5 search over memories for a single agent.
   * Safe: uses prepared statements and binds parameters.
   */
  searchMemoriesFTS(params: {
    agentId: string;
    query: string;
    limit: number;
  }): Array<{
    id: string;
    content: string;
    importance: number;
    score: number;
    createdAt: Date;
    lastAccessed: Date;
    accessCount: number;
    tags: string[];
    ftsScore: number;
  }> {
    const { agentId, query, limit } = params;

    const q = (query ?? "").toString();
    if (!q.trim()) return [];

    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit || 10)));

    const stmt = this.db.prepare(
      `
      SELECT
        mem.id AS id,
        mem.content AS content,
        mem.importance AS importance,
        mem.score AS score,
        mem.created_at AS created_at,
        mem.last_accessed AS last_accessed,
        mem.access_count AS access_count,
        mem.tags AS tags,
        bm25(memories_fts) AS fts_score
      FROM memories_fts
      JOIN memories mem ON mem.rowid = memories_fts.rowid
      WHERE mem.agent_id = ?
        AND memories_fts MATCH ?
      ORDER BY fts_score DESC
      LIMIT ?
    `
    );

    const rows = stmt.all(agentId, q, safeLimit);

    return rows.map((r: any) => {
      let parsedTags: string[] = [];
      if (typeof r.tags === "string") {
        try {
          const maybe = JSON.parse(r.tags || "[]");
          parsedTags = Array.isArray(maybe) ? maybe : [];
        } catch {
          parsedTags = [];
        }
      } else if (Array.isArray(r.tags)) {
        parsedTags = r.tags;
      }

      return {
        id: r.id,
        content: r.content,
        importance: r.importance ?? 0.5,
        score: r.score ?? 0,
        createdAt: new Date(r.created_at),
        lastAccessed: new Date(r.last_accessed),
        accessCount: r.access_count ?? 0,
        tags: parsedTags,
        ftsScore: r.fts_score ?? 0,
      };
    });
  }
}

// ─── JSON File Storage (existing behavior, now as a proper adapter) ─────────

export class JSONFileStorage implements StorageAdapter {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    const path = require("path");
    const fs = require("fs");
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  load(agentId: string): PersistedState | null {
    try {
      const fs = require("fs");
      if (!fs.existsSync(this.filePath)) return null;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      return {
        agentId: raw.agentId,
        wallet: raw.wallet ?? 0,
        reputation: raw.reputation ?? 0.5,
        createdAt: raw.createdAt ?? new Date().toISOString(),
        memories: (raw.memories ?? []).map((m: any) => ({
          ...m,
          tags: typeof m.tags === "string" ? m.tags : JSON.stringify(m.tags ?? []),
        })),
        transactions: raw.transactions ?? [],
        auditLog: (raw.auditLog ?? []).map((a: any) => ({
          ...a,
          details:
            typeof a.details === "string"
              ? a.details
              : JSON.stringify(a.details ?? {}),
        })),
        fraudGuard: raw.fraudGuard,
      };
    } catch (err: any) {
      if (typeof process !== "undefined" && process.stderr) {
        process.stderr.write(
          `[MNEMOPAY WARNING] Failed to load agent state from ${this.filePath}: ${err?.message}\n`
        );
      }
      return null;
    }
  }

  save(state: PersistedState): void {
    try {
      const fs = require("fs");
      const data = JSON.stringify({
        agentId: state.agentId,
        wallet: state.wallet,
        reputation: state.reputation,
        createdAt: state.createdAt,
        memories: state.memories.map((m) => ({
          ...m,
          tags: typeof m.tags === "string" ? JSON.parse(m.tags) : m.tags,
        })),
        transactions: state.transactions,
        auditLog: state.auditLog.slice(-500).map((a) => ({
          ...a,
          details:
            typeof a.details === "string"
              ? JSON.parse(a.details)
              : a.details,
        })),
        fraudGuard: state.fraudGuard,
        savedAt: new Date().toISOString(),
      });
      const tmpPath = this.filePath + ".tmp";
      fs.writeFileSync(tmpPath, data, "utf-8");
      fs.renameSync(tmpPath, this.filePath);
    } catch (err: any) {
      try {
        const fs = require("fs");
        fs.writeFileSync(this.filePath, JSON.stringify(state), "utf-8");
      } catch {
        if (typeof process !== "undefined" && process.stderr) {
          process.stderr.write(
            `[MNEMOPAY CRITICAL] Failed to persist agent state: ${err?.message}\n`
          );
        }
      }
    }
  }

  close(): void {
    // No-op for file storage
  }
}
