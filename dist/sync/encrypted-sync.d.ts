import Database from 'better-sqlite3';
import { PlatformCrypto } from '../security/crypto';
import { PermissionGuard } from '../security/permissions';
export interface SyncManifest {
    agentId: string;
    deviceId: string;
    tables: string[];
    cursor: number;
    recordCount: number;
    checksum: string;
}
export interface SyncPacket {
    manifest: SyncManifest;
    blobs: Array<{
        id: string;
        table: string;
        encryptedPayload: string;
    }>;
    signature: string;
}
export declare class EncryptedSync {
    private readonly db;
    private readonly crypto;
    private readonly guard;
    private readonly agentId;
    private readonly deviceId;
    private readonly embedText;
    constructor(db: Database.Database, crypto: PlatformCrypto, guard: PermissionGuard, agentId: string, deviceId: string, embedText: (text: string) => Promise<Float32Array>);
    buildPushPacket(tables?: string[]): Promise<SyncPacket>;
    applyPullPacket(packet: SyncPacket): Promise<{
        merged: number;
        skipped: number;
    }>;
    markSynced(recordIds: string[]): void;
    getSyncStatus(): {
        pendingPush: number;
        lastSync: number | null;
    };
}
//# sourceMappingURL=encrypted-sync.d.ts.map