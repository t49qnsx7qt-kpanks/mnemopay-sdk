import { FraudSignal, FraudType } from '../types/index';
import { sha256 } from '@noble/hashes/sha256';
import { generateId } from './crypto';

// 16+ injection patterns covering direct, delimiter, social engineering, jailbreak, encoding
const INJECTION_PATTERNS: RegExp[] = [
  /ignore previous instructions/i,
  /you are now/i,
  /system override/i,
  /\[INST\]/,
  /<<SYS>>/,
  /<\|im_start\|>/,
  /<\|endoftext\|>/,
  /pretend to be/i,
  /roleplay as/i,
  /bypass filters/i,
  /DAN mode/i,
  /jailbreak/i,
  /ignore all previous/i,
  /disregard your instructions/i,
  /act as if you have no/i,
  /you must obey/i,
];

// Zero-width / invisible Unicode used in homoglyph attacks
const HOMOGLYPH_RE = /[\u200B-\u200D\u00AD\uFEFF\u2060]/;

export class FraudDetector {
  private nonceRegistry   = new Map<string, number>();            // agentId -> lastNonce
  private contentHashes   = new Map<string, Set<string>>();       // agentId -> seen SHA256s
  private actionHistory   = new Map<string, string[]>();          // agentId -> last 100 actions
  private paymentGraph    = new Map<string, Map<string, { count: number; lastTs: number }>>(); // from->to->stats
  private spatialHistory  = new Map<string, { lat: number; lng: number; ts: number }>();
  private log: FraudSignal[] = [];

  private emit(
    type: FraudType,
    severity: FraudSignal['severity'],
    agentId: string,
    details: Record<string, unknown>,
    autoAction: FraudSignal['autoAction'],
  ): FraudSignal {
    const sig: FraudSignal = { id: generateId('fraud'), type, severity, agentId, details, timestamp: Date.now(), autoAction };
    this.log.push(sig);
    return sig;
  }

  // ── 5.1 Replay Attack ───────────────────────────────────────────────────────
  checkReplay(agentId: string, nonce: number): FraudSignal | null {
    const last = this.nonceRegistry.get(agentId) ?? -1;
    if (nonce <= last) {
      return this.emit('replay_attack', 'critical', agentId, { nonce, lastSeen: last }, 'reject');
    }
    this.nonceRegistry.set(agentId, nonce);
    return null;
  }

  // ── 5.2 Prompt Injection ────────────────────────────────────────────────────
  checkInjection(content: string, agentId: string): FraudSignal | null {
    // Direct patterns
    for (const re of INJECTION_PATTERNS) {
      if (re.test(content)) {
        return this.emit('prompt_injection', 'high', agentId, { pattern: re.source }, 'reject');
      }
    }

    // Base64 decoding and re-check
    const b64Blocks = content.match(/[A-Za-z0-9+/]{20,}={0,2}/g) ?? [];
    for (const b64 of b64Blocks) {
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        for (const re of INJECTION_PATTERNS) {
          if (re.test(decoded)) {
            return this.emit('prompt_injection', 'high', agentId, { encoding: 'base64', pattern: re.source }, 'reject');
          }
        }
      } catch { /* not valid base64 */ }
    }

    // Hex encoding check
    const hexBlocks = content.match(/(?:0x)?[0-9a-fA-F]{20,}/g) ?? [];
    for (const hex of hexBlocks) {
      try {
        const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
        if (clean.length % 2 !== 0) continue;
        const decoded = Buffer.from(clean, 'hex').toString('utf8');
        for (const re of INJECTION_PATTERNS) {
          if (re.test(decoded)) {
            return this.emit('prompt_injection', 'high', agentId, { encoding: 'hex' }, 'reject');
          }
        }
      } catch { /* not valid hex */ }
    }

    // Unicode homoglyph smuggling
    if (HOMOGLYPH_RE.test(content)) {
      return this.emit('prompt_injection', 'medium', agentId, { encoding: 'unicode_homoglyph' }, 'reject');
    }

    return null;
  }

  // ── 5.3 Memory Poisoning ────────────────────────────────────────────────────
  checkPoisoning(
    content: string,
    agentId: string,
    importance: number,
  ): { signal: FraudSignal | null; clampedImportance: number } {
    let clampedImportance = importance;

    // Cap suspiciously high importance
    if (importance > 0.9) clampedImportance = 0.5;

    // Duplicate content fingerprint
    const hash = Buffer.from(sha256(Buffer.from(content, 'utf8'))).toString('hex');
    if (!this.contentHashes.has(agentId)) this.contentHashes.set(agentId, new Set());
    const hashes = this.contentHashes.get(agentId)!;
    if (hashes.has(hash)) {
      return {
        signal: this.emit('memory_poisoning', 'low', agentId, { reason: 'duplicate_content' }, 'log'),
        clampedImportance,
      };
    }
    hashes.add(hash);
    return { signal: null, clampedImportance };
  }

  // ── 5.4 Spatial Spoofing ────────────────────────────────────────────────────
  checkSpatialSpoofing(
    agentId: string,
    accuracy: number,
    timestamp: number,
    confidence: number,
    isRooted: boolean,
  ): FraudSignal | null {
    if (isRooted) {
      return this.emit('spatial_spoofing', 'critical', agentId, { reason: 'rooted_device' }, 'reject');
    }
    const ageMs = Date.now() - timestamp;
    if (ageMs > 5 * 60 * 1000 || timestamp > Date.now() + 5000) {
      return this.emit('spatial_spoofing', 'critical', agentId, { reason: 'stale_timestamp', ageMs }, 'reject');
    }
    if (accuracy > 100) {
      return this.emit('spatial_spoofing', 'high', agentId, { reason: 'poor_gps_accuracy', accuracy }, 'reject');
    }
    if (confidence < 0.6) {
      return this.emit('spatial_spoofing', 'medium', agentId, { reason: 'low_scene_confidence', confidence }, 'throttle');
    }
    return null;
  }

  // ── 5.4b Velocity Check ─────────────────────────────────────────────────────
  checkVelocity(agentId: string, lat: number, lng: number, ts: number): FraudSignal | null {
    const last = this.spatialHistory.get(agentId);
    this.spatialHistory.set(agentId, { lat, lng, ts });

    if (!last) return null;

    const dtSec = (ts - last.ts) / 1000;
    if (dtSec <= 0) return null;

    // Haversine distance in meters
    const R = 6_371_000;
    const dLat = ((lat - last.lat) * Math.PI) / 180;
    const dLng = ((lng - last.lng) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((last.lat * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    const distM = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    const speedMs = distM / dtSec;
    if (speedMs > 340) { // speed of sound
      return this.emit('spatial_spoofing', 'critical', agentId, { reason: 'impossible_velocity', speedMs, distM, dtSec }, 'reject');
    }
    return null;
  }

  // ── 5.5 Collusion Detection ─────────────────────────────────────────────────
  checkCollusion(fromAgent: string, toAgent: string): FraudSignal | null {
    if (!this.paymentGraph.has(fromAgent)) this.paymentGraph.set(fromAgent, new Map());
    const edges = this.paymentGraph.get(fromAgent)!;
    const edge = edges.get(toAgent) ?? { count: 0, lastTs: 0 };
    edge.count += 1;
    edge.lastTs = Date.now();
    edges.set(toAgent, edge);

    // Check reverse direction
    const reverse = this.paymentGraph.get(toAgent)?.get(fromAgent);
    if (edge.count >= 3 && reverse && reverse.count >= 3) {
      return this.emit('collusion_pattern', 'high', fromAgent, { toAgent, fwdCount: edge.count, revCount: reverse.count }, 'freeze');
    }
    return null;
  }

  // ── 5.6 Sybil Detection ─────────────────────────────────────────────────────
  recordAction(agentId: string, action: string): void {
    if (!this.actionHistory.has(agentId)) this.actionHistory.set(agentId, []);
    const hist = this.actionHistory.get(agentId)!;
    hist.push(action);
    if (hist.length > 100) hist.shift();
  }

  getLog(): FraudSignal[] { return [...this.log]; }
  clearLog(): void { this.log = []; }
}
