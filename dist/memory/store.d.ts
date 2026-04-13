import Database from 'better-sqlite3';
import { Memory, MemoryMetadata, MemoryQuery, MemoryRecallResult, MnemoPayConfig } from '../types/index';
import { PlatformCrypto } from '../security/crypto';
import { PermissionGuard } from '../security/permissions';
import { RateLimiter } from '../security/rate-limiter';
import { FraudDetector } from '../security/fraud-detector';
export declare class MemoryStore {
    private readonly db;
    private readonly crypto;
    private readonly guard;
    private readonly rateLimiter;
    private readonly fraud;
    private readonly agentId;
    private readonly halfLifeMs;
    private readonly memoryCap;
    private readonly embeddingDim;
    private readonly embedText;
    private readonly vectorKMultiplier;
    constructor(db: Database.Database, crypto: PlatformCrypto, guard: PermissionGuard, rateLimiter: RateLimiter, fraud: FraudDetector, config: MnemoPayConfig, embedText: (text: string) => Promise<Float32Array>);
    static loadExtensions(db: Database.Database): void;
    static initSchema(db: Database.Database): void;
    private decayedScore;
    retain(content: string, metadata: Omit<MemoryMetadata, 'agentId'>): Promise<Memory>;
    recall(query: MemoryQuery): Promise<MemoryRecallResult[]>;
    forget(memoryId: string): Promise<void>;
    autoRecall(userMessage: string, tokenBudget?: number): Promise<string>;
    autoRetain(conversation: string, sessionId: string): Promise<Memory[]>;
    purgeExpired(): void;
    private evictIfNeeded;
    count(): number;
}
//# sourceMappingURL=store.d.ts.map