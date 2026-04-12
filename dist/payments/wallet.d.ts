import Database from 'better-sqlite3';
import { AgentWallet, Transaction, EscrowContract, EscrowCondition } from '../types/index';
import { PlatformCrypto } from '../security/crypto';
import { PermissionGuard } from '../security/permissions';
import { RateLimiter } from '../security/rate-limiter';
import { FraudDetector } from '../security/fraud-detector';
export declare class WalletEngine {
    private readonly db;
    private readonly crypto;
    private readonly guard;
    private readonly rateLimiter;
    private readonly fraud;
    private readonly agentId;
    private readonly dailyLimitCents;
    constructor(db: Database.Database, crypto: PlatformCrypto, guard: PermissionGuard, rateLimiter: RateLimiter, fraud: FraudDetector, agentId: string, dailyLimitCents: bigint);
    static initSchema(db: Database.Database): void;
    private today;
    private ensureWallet;
    private resetDailyIfNeeded;
    getWallet(agentId?: string): AgentWallet;
    send(toAgent: string, amount: bigint, memoriesAccessed?: string[]): Promise<Transaction>;
    createEscrow(sellerAgent: string, amount: bigint, conditions: Omit<EscrowCondition, 'met'>[], timeoutMs?: number): Promise<EscrowContract>;
    settle(escrowId: string, memoriesAccessed?: string[]): Promise<Transaction>;
    markConditionMet(escrowId: string, conditionType: EscrowCondition['type']): void;
    freezeWallet(agentId: string): void;
    getTransactionHistory(limit?: number): Transaction[];
}
//# sourceMappingURL=wallet.d.ts.map