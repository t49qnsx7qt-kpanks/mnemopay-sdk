export interface Memory {
    id: string;
    content: string;
    embedding: Float32Array;
    metadata: MemoryMetadata;
    createdAt: number;
    updatedAt: number;
    accessCount: number;
    decayScore: number;
    integrity: string;
}
export interface MemoryMetadata {
    source: 'conversation' | 'observation' | 'agent_action' | 'spatial_proof' | 'transaction';
    sessionId: string;
    agentId: string;
    tags: string[];
    importance: number;
    spatial?: SpatialAnchor;
    ttl?: number;
}
export interface MemoryQuery {
    text?: string;
    embedding?: Float32Array;
    tags?: string[];
    sessionId?: string;
    agentId?: string;
    minImportance?: number;
    spatial?: {
        lat: number;
        lng: number;
        radiusM: number;
    };
    limit?: number;
    threshold?: number;
}
export interface MemoryRecallResult {
    memory: Memory;
    score: number;
    distance: number;
}
export interface AgentWallet {
    agentId: string;
    balance: bigint;
    currency: 'USD_CENTS';
    reputation: number;
    nonce: number;
    frozen: boolean;
    dailyLimit: bigint;
    dailySpent: bigint;
    lastResetDate: string;
}
export interface Transaction {
    id: string;
    fromAgent: string;
    toAgent: string;
    amount: bigint;
    currency: 'USD_CENTS';
    type: 'payment' | 'escrow_lock' | 'escrow_release' | 'escrow_refund' | 'reward' | 'penalty';
    status: 'pending' | 'escrowed' | 'settled' | 'failed' | 'disputed' | 'refunded';
    escrowId?: string;
    memoriesAccessed: string[];
    signature: string;
    nonce: number;
    createdAt: number;
}
export type EscrowConditionType = 'memory_verified' | 'spatial_proof' | 'reputation_above' | 'manual_approval';
export interface EscrowCondition {
    type: EscrowConditionType;
    params: Record<string, unknown>;
    met: boolean;
}
export interface EscrowContract {
    id: string;
    buyerAgent: string;
    sellerAgent: string;
    amount: bigint;
    conditions: EscrowCondition[];
    timeout: number;
    status: 'active' | 'released' | 'refunded' | 'disputed';
    createdAt: number;
}
export interface SpatialAnchor {
    lat: number;
    lng: number;
    altitude?: number;
    accuracy: number;
    sceneHash: string;
    gridCellId: string;
    timestamp: number;
}
export interface SpatialProof {
    id: string;
    agentId: string;
    h3Tile: string;
    lat: number;
    lng: number;
    accuracy: number;
    sceneHash: string;
    confidence: number;
    timestamp: number;
    signature: string;
    deviceId: string;
    attestation?: string;
    verified: boolean;
}
export interface SpatialProofResult {
    proof: SpatialProof;
    passed: boolean;
    score: number;
    reason?: string;
}
export type Permission = 'memory:read' | 'memory:write' | 'memory:delete' | 'wallet:read' | 'wallet:send' | 'wallet:escrow' | 'spatial:prove' | 'spatial:verify' | 'sync:push' | 'sync:pull' | 'admin:freeze' | 'admin:audit';
export interface RateLimitConfig {
    generalPerMin: number;
    memoryWritesPerHour: number;
    transactionsPerHour: number;
    spatialProofsPerHour: number;
    burstAllowance: number;
}
export interface SecurityContext {
    agentId: string;
    permissions: Permission[];
    rateLimit: RateLimitConfig;
    sessionKey: Uint8Array;
    createdAt: number;
    expiresAt: number;
}
export type FraudType = 'velocity_spike' | 'memory_poisoning' | 'replay_attack' | 'spatial_spoofing' | 'privilege_escalation' | 'prompt_injection' | 'sybil_attack' | 'collusion_pattern';
export interface FraudSignal {
    id: string;
    type: FraudType;
    severity: 'low' | 'medium' | 'high' | 'critical';
    agentId: string;
    details: Record<string, unknown>;
    timestamp: number;
    autoAction: 'log' | 'throttle' | 'reject' | 'freeze';
}
export interface MnemoPayConfig {
    agentId: string;
    persistDir?: string;
    deviceId?: string;
    encryptionKey?: Uint8Array;
    hmacKey?: Uint8Array;
    signingKey?: Uint8Array;
    embeddingModelPath?: string;
    embeddingDimensions?: number;
    syncEndpoint?: string;
    dailyLimitCents?: number;
    memoryCapacity?: number;
    memoryHalfLifeDays?: number;
}
//# sourceMappingURL=index.d.ts.map