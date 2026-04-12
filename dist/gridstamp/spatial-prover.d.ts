import Database from 'better-sqlite3';
import { SpatialProof, SpatialProofResult, MnemoPayConfig } from '../types/index';
import { PlatformCrypto } from '../security/crypto';
import { PermissionGuard } from '../security/permissions';
import { RateLimiter } from '../security/rate-limiter';
import { FraudDetector } from '../security/fraud-detector';
export declare class SpatialProver {
    private readonly db;
    private readonly crypto;
    private readonly guard;
    private readonly rateLimiter;
    private readonly fraud;
    private readonly config;
    constructor(db: Database.Database, crypto: PlatformCrypto, guard: PermissionGuard, rateLimiter: RateLimiter, fraud: FraudDetector, config: MnemoPayConfig);
    static initSchema(db: Database.Database): void;
    prove(lat: number, lng: number, accuracy: number, // meters — must be ≤ 100m
    confidence: number, // 0-1 scene recognition confidence
    sensorReadings: Record<string, unknown>, deviceId: string, attestationToken?: string, // iOS App Attest / Android Play Integrity JWT
    isRooted?: boolean): Promise<SpatialProofResult>;
    verify(proofId: string, expectedH3Tile?: string): Promise<SpatialProofResult>;
    proveAndMarkEscrow(escrowId: string, conditionType: 'spatial_proof', markConditionFn: (escrowId: string, type: 'spatial_proof') => void, lat: number, lng: number, accuracy: number, confidence: number, sensorReadings: Record<string, unknown>, deviceId: string, expectedH3Tile?: string): Promise<SpatialProofResult>;
    getProof(proofId: string): SpatialProof | null;
    getProofHistory(limit?: number): SpatialProof[];
    private _rowToProof;
}
//# sourceMappingURL=spatial-prover.d.ts.map