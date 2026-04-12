import { FraudSignal } from '../types/index';
import { generateId } from './crypto';

type Category = 'general' | 'memory_write' | 'transaction' | 'spatial';

const LIMITS: Record<Category, { count: number; windowMs: number }> = {
  general:      { count: 60,  windowMs: 60_000 },
  memory_write: { count: 200, windowMs: 3_600_000 },
  transaction:  { count: 50,  windowMs: 3_600_000 },
  spatial:      { count: 30,  windowMs: 3_600_000 },
};

const BURST_MAX = 10;
const BURST_REFILL_PER_SEC = 1;

interface Window {
  timestamps: number[];
  burstTokens: number;
  lastRefill: number;
}

export class RateLimiter {
  // agentId -> category -> Window
  private state = new Map<string, Map<Category, Window>>();

  private getWindow(agentId: string, cat: Category): Window {
    if (!this.state.has(agentId)) this.state.set(agentId, new Map());
    const agent = this.state.get(agentId)!;
    if (!agent.has(cat)) {
      agent.set(cat, { timestamps: [], burstTokens: BURST_MAX, lastRefill: Date.now() });
    }
    return agent.get(cat)!;
  }

  private refill(w: Window): void {
    const elapsed = (Date.now() - w.lastRefill) / 1000;
    w.burstTokens = Math.min(BURST_MAX, w.burstTokens + elapsed * BURST_REFILL_PER_SEC);
    w.lastRefill = Date.now();
  }

  // Returns true if allowed, false if blocked.
  // Emits velocity_spike signal when blocked.
  check(agentId: string, cat: Category): { allowed: boolean; signal: FraudSignal | null } {
    const limit = LIMITS[cat];
    const w = this.getWindow(agentId, cat);
    const now = Date.now();

    // Slide window
    w.timestamps = w.timestamps.filter(t => now - t < limit.windowMs);

    if (w.timestamps.length < limit.count) {
      w.timestamps.push(now);
      return { allowed: true, signal: null };
    }

    // Over limit — try burst token
    this.refill(w);
    if (w.burstTokens >= 1) {
      w.burstTokens -= 1;
      w.timestamps.push(now);
      return { allowed: true, signal: null };
    }

    const signal: FraudSignal = {
      id: generateId('rate'),
      type: 'velocity_spike',
      severity: 'medium',
      agentId,
      details: { category: cat, windowMs: limit.windowMs, count: w.timestamps.length },
      timestamp: now,
      autoAction: 'throttle',
    };
    return { allowed: false, signal };
  }

  reset(agentId: string): void {
    this.state.delete(agentId);
  }
}
