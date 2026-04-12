// ─── Memory Types ──────────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  content: string;
  embedding: Float32Array;
  metadata: MemoryMetadata;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  decayScore: number;
  integrity: string; // HMAC-SHA256 hex of content+metadata+id
}

export interface MemoryMetadata {
  source: 'conversation' | 'observation' | 'agent_action' | 'spatial_proof' | 'transaction';
  sessionId: string;
  agentId: string;
  tags: string[];
  importance: number; // 0-1
  spatial?: SpatialAnchor;
  ttl?: number; // ms
}

export interface MemoryQuery {
  text?: string;
  embedding?: Float32Array;
  tags?: string[];
  sessionId?: string;
  agentId?: string;
  minImportance?: number;
  spatial?: { lat: number; lng: number; radiusM: number };
  limit?: number;
  threshold?: number; // cosine similarity threshold 0-1
}

export interface MemoryRecallResult {
  memory: Memory;
  score: number;    // decay-adjusted composite score
  distance: number; // cosine distance (lower = more similar)
}

// ─── Payment Types ─────────────────────────────────────────────────────────────

export interface AgentWallet {
  agentId: string;
  balance: bigint;          // in USD cents (integer, no floats)
  currency: 'USD_CENTS';
  reputation: number;       // 0-100
  nonce: number;            // monotonic, prevents replay
  frozen: boolean;
  dailyLimit: bigint;
  dailySpent: bigint;
  lastResetDate: string;    // ISO date string YYYY-MM-DD
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
  memoriesAccessed: string[]; // memory IDs used during this transaction
  signature: string;          // Ed25519 hex signature
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
  timeout: number;  // Unix ms timestamp of expiry
  status: 'active' | 'released' | 'refunded' | 'disputed';
  createdAt: number;
}

// ─── GridStamp / Spatial Types ─────────────────────────────────────────────────

export interface SpatialAnchor {
  lat: number;
  lng: number;
  altitude?: number;
  accuracy: number;   // meters
  sceneHash: string;  // SHA-256 hex of scene descriptor
  gridCellId: string; // H3-style hex-encoded grid cell
  timestamp: number;
}

// Flat spatial proof — stored in SQLite, signed with Ed25519
export interface SpatialProof {
  id: string;
  agentId: string;
  h3Tile: string;          // toH3Tile(lat, lng, 9)
  lat: number;
  lng: number;
  accuracy: number;        // meters
  sceneHash: string;       // SHA-256 hex of sensor readings
  confidence: number;      // 0-1 scene recognition confidence
  timestamp: number;
  signature: string;       // Ed25519 hex over full payload
  deviceId: string;
  attestation?: string;    // iOS App Attest / Android Play Integrity JWT
  verified: boolean;
}

export interface SpatialProofResult {
  proof: SpatialProof;
  passed: boolean;         // score >= 0.75
  score: number;           // 0-1 composite score
  reason?: string;         // failure reason if !passed
}

// ─── Security Types ────────────────────────────────────────────────────────────

export type Permission =
  | 'memory:read' | 'memory:write' | 'memory:delete'
  | 'wallet:read' | 'wallet:send' | 'wallet:escrow'
  | 'spatial:prove' | 'spatial:verify'
  | 'sync:push' | 'sync:pull'
  | 'admin:freeze' | 'admin:audit';

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
  sessionKey: Uint8Array; // ephemeral
  createdAt: number;
  expiresAt: number;
}

export type FraudType =
  | 'velocity_spike'
  | 'memory_poisoning'
  | 'replay_attack'
  | 'spatial_spoofing'
  | 'privilege_escalation'
  | 'prompt_injection'
  | 'sybil_attack'
  | 'collusion_pattern';

export interface FraudSignal {
  id: string;
  type: FraudType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  agentId: string;
  details: Record<string, unknown>;
  timestamp: number;
  autoAction: 'log' | 'throttle' | 'reject' | 'freeze';
}

// ─── SDK Config ────────────────────────────────────────────────────────────────

export interface MnemoPayConfig {
  agentId: string;
  persistDir?: string;         // directory for SQLite DB; defaults to ~/.mnemopay/
  deviceId?: string;           // stable device identifier; auto-derived if omitted
  encryptionKey?: Uint8Array;  // 32 bytes AES-256-GCM key; derived from agentId if omitted
  hmacKey?: Uint8Array;        // 32 bytes HMAC-SHA256 key
  signingKey?: Uint8Array;     // 32 bytes Ed25519 seed
  embeddingModelPath?: string; // path to MiniLM ONNX model (optional — uses placeholder if omitted)
  embeddingDimensions?: number; // default 384
  syncEndpoint?: string;       // zero-knowledge cloud sync URL
  dailyLimitCents?: number;    // default 100_000 ($1000)
  memoryCapacity?: number;     // default 10_000 memories
  memoryHalfLifeDays?: number; // default 7 days
}
