import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { sha256 } from '@noble/hashes/sha256';

import { MnemoPayConfig, SecurityContext, Permission } from '../types/index';
import { NodeCrypto, PlatformCrypto } from '../security/crypto';
import { PermissionGuard, buildContext } from '../security/permissions';
import { RateLimiter } from '../security/rate-limiter';
import { FraudDetector } from '../security/fraud-detector';
import { MemoryStore } from '../memory/store';
import { WalletEngine } from '../payments/wallet';
import { SpatialProver } from '../gridstamp/spatial-prover';
import { EncryptedSync } from '../sync/encrypted-sync';
import { NodeBridge, PlatformBridge } from '../platform/index';

export class MnemoPay {
  private readonly db: Database.Database;
  private readonly crypto: PlatformCrypto;
  private readonly guard: PermissionGuard;
  private readonly rateLimiter: RateLimiter;
  private readonly fraud: FraudDetector;

  readonly memory: MemoryStore;
  readonly wallet: WalletEngine;
  readonly spatial: SpatialProver;
  readonly sync: EncryptedSync;

  private static _bridge: PlatformBridge = new NodeBridge();

  private constructor(
    private readonly config: MnemoPayConfig,
    ctx: SecurityContext,
    dbPath: string,
  ) {
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);

    // WAL mode for concurrent reads
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.crypto = new NodeCrypto(config.encryptionKey ?? this._defaultKey(config.agentId));
    this.guard = new PermissionGuard(ctx);
    this.rateLimiter = new RateLimiter();
    this.fraud = new FraudDetector();

    // Init schemas
    MemoryStore.initSchema(this.db);
    WalletEngine.initSchema(this.db);
    SpatialProver.initSchema(this.db);

    this.memory = new MemoryStore(
      this.db, this.crypto, this.guard, this.rateLimiter, this.fraud, config,
    );

    this.wallet = new WalletEngine(
      this.db, this.crypto, this.guard, this.rateLimiter, this.fraud,
      config.agentId,
      BigInt(config.dailyLimitCents ?? 100_000),
    );

    this.spatial = new SpatialProver(
      this.db, this.crypto, this.guard, this.rateLimiter, this.fraud, config,
    );

    this.sync = new EncryptedSync(
      this.db, this.crypto, this.guard,
      config.agentId,
      config.deviceId ?? 'node-default',
    );
  }

  // ── Factory ───────────────────────────────────────────────────────────────
  static create(config: MnemoPayConfig, permissions?: Permission[]): MnemoPay {
    const perms: Permission[] = permissions ?? [
      'memory:read', 'memory:write', 'memory:delete',
      'wallet:read', 'wallet:send', 'wallet:escrow',
      'spatial:prove', 'spatial:verify',
      'sync:push', 'sync:pull',
    ];

    const ctx = buildContext(config.agentId, perms);
    const dbPath = MnemoPay._resolvePath(config);

    return new MnemoPay(config, ctx, dbPath);
  }

  // Register a hardware platform bridge (call before MnemoPay.create())
  static setPlatformBridge(bridge: PlatformBridge): void {
    MnemoPay._bridge = bridge;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  // Call at the start of a conversation to inject relevant context.
  async sessionStart(userMessage: string): Promise<string> {
    return this.memory.autoRecall(userMessage);
  }

  // Call at the end of a conversation to persist salient facts.
  async sessionEnd(conversation: string, sessionId: string): Promise<void> {
    await this.memory.autoRetain(conversation, sessionId);
    this.memory.purgeExpired();
  }

  close(): void {
    this.db.close();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private _defaultKey(agentId: string): Uint8Array {
    // Derive a 32-byte key from agentId (deterministic, not cryptographically
    // secure — production should always supply a real encryptionKey)
    return sha256(Buffer.from(`mnemopay:${agentId}`, 'utf8'));
  }

  private static _resolvePath(config: MnemoPayConfig): string {
    const dir = config.persistDir ?? path.join(
      process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.',
      '.mnemopay',
    );
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${config.agentId}.db`);
  }
}
