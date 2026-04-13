import Database from 'better-sqlite3';
import { MnemoPayConfig, Permission } from '../types/index';
import { MemoryStore } from '../memory/store';
import { WalletEngine } from '../payments/wallet';
import { SpatialProver } from '../gridstamp/spatial-prover';
import { EncryptedSync } from '../sync/encrypted-sync';
import { PlatformBridge } from '../platform/index';
export declare class MnemoPay {
    private readonly config;
    readonly db: Database.Database;
    private readonly crypto;
    private readonly guard;
    private readonly rateLimiter;
    private readonly fraud;
    readonly memory: MemoryStore;
    readonly wallet: WalletEngine;
    readonly spatial: SpatialProver;
    readonly sync: EncryptedSync;
    private static _bridge;
    private constructor();
    static create(config: MnemoPayConfig, permissions?: Permission[]): MnemoPay;
    static setPlatformBridge(bridge: PlatformBridge): void;
    sessionStart(userMessage: string): Promise<string>;
    sessionEnd(conversation: string, sessionId: string): Promise<void>;
    close(): void;
    private _defaultKey;
    private _defaultHmacKey;
    private _defaultSigningKey;
    private static _resolvePath;
}
//# sourceMappingURL=sdk.d.ts.map