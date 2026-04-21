/**
 * NeonAdapter — PersistenceAdapter backed by Neon / Postgres + pgvector.
 *
 * Requires the `pg` package as an optional peer dep. We dynamic-import it so
 * consumers who only use the MemoryAdapter do not need `pg` installed.
 *
 * Schema (auto-bootstrapped on first set() unless skipBootstrap: true):
 *
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *   CREATE TABLE IF NOT EXISTS mnemopay_memories (
 *     agent_id   TEXT        NOT NULL,
 *     id         TEXT        NOT NULL,
 *     content    TEXT        NOT NULL,
 *     embedding  VECTOR(384) NOT NULL,
 *     metadata   JSONB,
 *     created_at TIMESTAMPTZ DEFAULT NOW(),
 *     PRIMARY KEY (agent_id, id)
 *   );
 *   CREATE INDEX IF NOT EXISTS mnemopay_memories_hnsw
 *     ON mnemopay_memories USING hnsw (embedding vector_cosine_ops);
 *
 * Usage:
 *   const adapter = new NeonAdapter({ url: process.env.NEON_URL! });
 *   // adapter is passed to RecallEngine internally via the persist option.
 *
 * No silent fallbacks: if the Neon connection or schema bootstrap fails, the
 * first `set()` / `search()` call rejects with a descriptive Error.
 */

import type { PersistedRow, PersistenceAdapter, SearchHit } from "./types.js";

// Structural typing so we don't hard-depend on @types/pg.
interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  end(): Promise<void>;
  on?(event: string, handler: (err: Error) => void): void;
}

interface PgModuleLike {
  Pool: new (config: { connectionString: string }) => PgPoolLike;
}

export interface NeonAdapterConfig {
  /** Postgres connection string (Neon pooler or direct). */
  url: string;
  /** Table name. Defaults to "mnemopay_memories". Must be a valid identifier. */
  table?: string;
  /** Skip CREATE EXTENSION + CREATE TABLE bootstrap (default: false). */
  skipBootstrap?: boolean;
  /**
   * Inject a pre-built pg Pool for testing. When supplied, `url` is still
   * required for error messages but is not used to construct the pool.
   */
  pool?: PgPoolLike;
}

// Valid Postgres identifier: letters, digits, underscore; must not start with
// a digit. We refuse anything else rather than try to quote — simpler and safer.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdent(name: string, what: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(
      `NeonAdapter: ${what} "${name}" is not a valid Postgres identifier ` +
        `(must match /^[A-Za-z_][A-Za-z0-9_]*$/)`,
    );
  }
}

/**
 * Convert a Float32Array into the pgvector text literal form, e.g. "[0.1,0.2,...]".
 * pgvector accepts this as a parameter for a VECTOR column.
 */
function toVectorLiteral(vec: Float32Array): string {
  // Build without intermediate array allocation when possible.
  let s = "[";
  for (let i = 0; i < vec.length; i++) {
    if (i > 0) s += ",";
    // Use Number so non-finite values stand out (Postgres will reject NaN/Infinity).
    s += String(vec[i]);
  }
  s += "]";
  return s;
}

function parseVectorLiteral(raw: string | number[] | Float32Array | null | undefined): Float32Array {
  if (raw == null) return new Float32Array(0);
  if (raw instanceof Float32Array) return raw;
  if (Array.isArray(raw)) return new Float32Array(raw);
  // pgvector text output: "[0.1,0.2,0.3]"
  const trimmed = raw.trim();
  const inner =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (!inner) return new Float32Array(0);
  const parts = inner.split(",");
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]);
  return out;
}

export class NeonAdapter implements PersistenceAdapter {
  private readonly config: Required<Omit<NeonAdapterConfig, "pool">> & { pool?: PgPoolLike };
  private pool: PgPoolLike | null;
  private bootstrapped: boolean;
  private bootstrapPromise: Promise<void> | null = null;
  private closed = false;

  constructor(config: NeonAdapterConfig) {
    if (!config || typeof config.url !== "string" || config.url.length === 0) {
      throw new Error("NeonAdapter: `url` is required (e.g. process.env.NEON_URL)");
    }
    const table = config.table ?? "mnemopay_memories";
    assertIdent(table, "table");

    this.config = {
      url: config.url,
      table,
      skipBootstrap: config.skipBootstrap ?? false,
      pool: config.pool,
    };
    this.pool = config.pool ?? null;
    this.bootstrapped = this.config.skipBootstrap;
  }

  private async getPool(): Promise<PgPoolLike> {
    if (this.closed) throw new Error("NeonAdapter: adapter is closed");
    if (this.pool) return this.pool;

    let pgMod: PgModuleLike;
    try {
      // Dynamic import keeps `pg` optional. The indirection via a variable
      // prevents TypeScript from trying to resolve `pg` types at build time
      // so the SDK compiles without `@types/pg` installed.
      const modName = "pg";
      pgMod = (await import(modName)) as unknown as PgModuleLike;
      // Some bundlers wrap CJS exports under .default.
      if (!pgMod.Pool && (pgMod as any).default?.Pool) {
        pgMod = (pgMod as any).default;
      }
    } catch (err) {
      throw new Error(
        "NeonAdapter: the `pg` package is required for Neon persistence. " +
          "Install it with `npm install pg` (optional peer dependency). " +
          `Underlying error: ${(err as Error).message}`,
      );
    }

    if (!pgMod.Pool) {
      throw new Error("NeonAdapter: loaded `pg` module has no Pool export");
    }

    try {
      this.pool = new pgMod.Pool({ connectionString: this.config.url });
      // Attach an error handler so idle-client errors don't crash the process.
      // We re-throw on the next query instead.
      this.pool.on?.("error", () => {
        /* swallowed — surfaced on next query */
      });
    } catch (err) {
      throw new Error(
        `NeonAdapter: failed to create Postgres pool for ${this.safeUrl()}: ${(err as Error).message}`,
      );
    }
    return this.pool;
  }

  private safeUrl(): string {
    // Strip credentials for logging.
    try {
      const u = new URL(this.config.url);
      if (u.password) u.password = "***";
      if (u.username) u.username = "***";
      return u.toString();
    } catch {
      return "<invalid-url>";
    }
  }

  private async ensureBootstrapped(): Promise<void> {
    if (this.bootstrapped) return;
    if (this.bootstrapPromise) return this.bootstrapPromise;

    this.bootstrapPromise = (async () => {
      const pool = await this.getPool();
      const table = this.config.table;
      try {
        await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        await pool.query(
          `CREATE TABLE IF NOT EXISTS ${table} (
             agent_id   TEXT        NOT NULL,
             id         TEXT        NOT NULL,
             content    TEXT        NOT NULL,
             embedding  VECTOR(384) NOT NULL,
             metadata   JSONB,
             created_at TIMESTAMPTZ DEFAULT NOW(),
             PRIMARY KEY (agent_id, id)
           )`,
        );
        await pool.query(
          `CREATE INDEX IF NOT EXISTS ${table}_hnsw
             ON ${table} USING hnsw (embedding vector_cosine_ops)`,
        );
        this.bootstrapped = true;
      } catch (err) {
        // Reset so the next call can retry.
        this.bootstrapPromise = null;
        throw new Error(
          `NeonAdapter: schema bootstrap failed on ${this.safeUrl()}: ${(err as Error).message}`,
        );
      }
    })();

    return this.bootstrapPromise;
  }

  async set(
    agentId: string,
    id: string,
    content: string,
    embedding: Float32Array,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!agentId) throw new Error("NeonAdapter.set: agentId is required");
    if (!id) throw new Error("NeonAdapter.set: id is required");
    await this.ensureBootstrapped();
    const pool = await this.getPool();
    const table = this.config.table;
    const vec = toVectorLiteral(embedding);
    const meta = metadata == null ? null : JSON.stringify(metadata);

    try {
      await pool.query(
        `INSERT INTO ${table} (agent_id, id, content, embedding, metadata)
         VALUES ($1, $2, $3, $4::vector, $5::jsonb)
         ON CONFLICT (agent_id, id) DO UPDATE
           SET content  = EXCLUDED.content,
               embedding = EXCLUDED.embedding,
               metadata  = EXCLUDED.metadata`,
        [agentId, id, content, vec, meta],
      );
    } catch (err) {
      throw new Error(
        `NeonAdapter.set(${agentId}, ${id}) failed: ${(err as Error).message}`,
      );
    }
  }

  async get(agentId: string, id: string): Promise<PersistedRow | null> {
    await this.ensureBootstrapped();
    const pool = await this.getPool();
    const table = this.config.table;
    try {
      const res = await pool.query(
        `SELECT content, embedding::text AS embedding, metadata
           FROM ${table}
          WHERE agent_id = $1 AND id = $2`,
        [agentId, id],
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        content: row.content as string,
        embedding: parseVectorLiteral(row.embedding),
        metadata: row.metadata ?? undefined,
      };
    } catch (err) {
      throw new Error(
        `NeonAdapter.get(${agentId}, ${id}) failed: ${(err as Error).message}`,
      );
    }
  }

  async delete(agentId: string, id: string): Promise<void> {
    await this.ensureBootstrapped();
    const pool = await this.getPool();
    const table = this.config.table;
    try {
      await pool.query(
        `DELETE FROM ${table} WHERE agent_id = $1 AND id = $2`,
        [agentId, id],
      );
    } catch (err) {
      throw new Error(
        `NeonAdapter.delete(${agentId}, ${id}) failed: ${(err as Error).message}`,
      );
    }
  }

  async search(
    agentId: string,
    queryEmbedding: Float32Array,
    topK: number,
  ): Promise<SearchHit[]> {
    await this.ensureBootstrapped();
    const pool = await this.getPool();
    const table = this.config.table;
    const k = Math.max(1, Math.floor(topK || 10));
    const vec = toVectorLiteral(queryEmbedding);

    try {
      // pgvector cosine *distance* operator is `<=>` (smaller = closer).
      // Convert to cosine *similarity* as 1 - distance so the public API
      // matches MemoryAdapter (higher = better, range ≈ [-1, 1]).
      const res = await pool.query(
        `SELECT id, content, metadata, 1 - (embedding <=> $2::vector) AS score
           FROM ${table}
          WHERE agent_id = $1
          ORDER BY embedding <=> $2::vector
          LIMIT $3`,
        [agentId, vec, k],
      );
      return res.rows.map((r) => ({
        id: r.id as string,
        content: r.content as string,
        score: Number(r.score),
        metadata: r.metadata ?? undefined,
      }));
    } catch (err) {
      throw new Error(
        `NeonAdapter.search(${agentId}, k=${k}) failed: ${(err as Error).message}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pool = this.pool;
    this.pool = null;
    if (pool) {
      try {
        await pool.end();
      } catch {
        // Swallow close errors — best-effort shutdown.
      }
    }
  }
}
