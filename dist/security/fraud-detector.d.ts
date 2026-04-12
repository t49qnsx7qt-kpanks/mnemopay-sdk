import { FraudSignal } from '../types/index';
export declare class FraudDetector {
    private nonceRegistry;
    private contentHashes;
    private actionHistory;
    private paymentGraph;
    private spatialHistory;
    private log;
    private emit;
    checkReplay(agentId: string, nonce: number): FraudSignal | null;
    checkInjection(content: string, agentId: string): FraudSignal | null;
    checkPoisoning(content: string, agentId: string, importance: number): {
        signal: FraudSignal | null;
        clampedImportance: number;
    };
    checkSpatialSpoofing(agentId: string, accuracy: number, timestamp: number, confidence: number, isRooted: boolean): FraudSignal | null;
    checkVelocity(agentId: string, lat: number, lng: number, ts: number): FraudSignal | null;
    checkCollusion(fromAgent: string, toAgent: string): FraudSignal | null;
    recordAction(agentId: string, action: string): void;
    getLog(): FraudSignal[];
    clearLog(): void;
}
//# sourceMappingURL=fraud-detector.d.ts.map