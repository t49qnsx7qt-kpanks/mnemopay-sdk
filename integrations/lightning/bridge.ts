/**
 * MnemoPay x Lightning Bridge
 *
 * Wraps Lightning payment operations with MnemoPay's memory and trust layer.
 * Use this when building agents that pay via Lightning and need to remember
 * which endpoints delivered value.
 *
 * Usage:
 *   import { LightningBridge } from '@mnemopay/sdk/integrations/lightning';
 *   const bridge = new LightningBridge(mnemoPayInstance);
 *   const result = await bridge.payAndRemember('https://api.example.com/data', 100);
 */

import type { MnemoPayLite } from '../../src/index.js';

export interface L402Endpoint {
  url: string;
  costSats: number;
  latencyMs: number;
  quality: number; // 0-1 rating
  lastUsed: string;
}

export interface PaymentDecision {
  shouldPay: boolean;
  reason: string;
  maxAmount: number;
  priorExperience: string | null;
}

export class LightningBridge {
  constructor(private agent: MnemoPayLite) {}

  /**
   * Check trust before making a Lightning payment.
   * Recalls prior interactions with the endpoint and returns a decision.
   */
  async evaluateEndpoint(url: string): Promise<PaymentDecision> {
    const memories = this.agent.recall(`L402 endpoint ${url}`, 5);
    const profile = this.agent.profile();
    const reputation = profile.reputation;

    // No prior experience — allow small test payment
    if (memories.length === 0) {
      return {
        shouldPay: true,
        reason: 'No prior interactions. Allowing small test payment.',
        maxAmount: Math.min(100, 500 * reputation), // 100 sats or rep-gated
        priorExperience: null,
      };
    }

    // Check for negative memories (fraud, poor quality)
    const negativeMemories = memories.filter(
      (m) =>
        m.content.includes('fraud') ||
        m.content.includes('blocked') ||
        m.content.includes('poor quality') ||
        m.content.includes('failed'),
    );

    if (negativeMemories.length > 0) {
      return {
        shouldPay: false,
        reason: `Blocked: ${negativeMemories.length} negative prior interactions.`,
        maxAmount: 0,
        priorExperience: negativeMemories[0].content,
      };
    }

    // Positive history — allow higher amounts
    const maxAmount = Math.min(500 * reputation * 100, 50000); // up to 50K sats
    return {
      shouldPay: true,
      reason: `${memories.length} positive prior interactions. Trust established.`,
      maxAmount,
      priorExperience: memories[0].content,
    };
  }

  /**
   * Record the outcome of a Lightning payment for future recall.
   */
  recordPayment(
    url: string,
    costSats: number,
    latencyMs: number,
    quality: number,
    success: boolean,
  ): void {
    const status = success ? 'successful' : 'failed';
    const qualityLabel =
      quality >= 0.8 ? 'high quality' : quality >= 0.5 ? 'acceptable quality' : 'poor quality';

    const content = `L402 endpoint ${url}: ${status} payment of ${costSats} sats, ${latencyMs}ms latency, ${qualityLabel} (${quality.toFixed(2)})`;

    // Auto-importance: successful high-quality = high importance
    const importance = success ? Math.min(0.5 + quality * 0.4, 0.95) : 0.85; // failures are important to remember

    this.agent.remember(content, importance, ['l402', 'lightning', status]);

    // Create escrow for successful payments to trigger the feedback loop
    if (success && quality >= 0.5) {
      const tx = this.agent.charge(costSats / 100000, `Lightning payment to ${url}`);
      if (tx.id) {
        this.agent.settle(tx.id);
        // Settlement reinforces memories from the last hour by +0.05
      }
    }
  }

  /**
   * Get the best endpoints from memory, ranked by MnemoPay's scoring.
   */
  bestEndpoints(limit: number = 5): string[] {
    const memories = this.agent.recall('L402 endpoint successful high quality', limit);
    return memories
      .filter((m) => m.content.includes('successful'))
      .map((m) => {
        const match = m.content.match(/L402 endpoint (\S+):/);
        return match ? match[1] : '';
      })
      .filter(Boolean);
  }

  /**
   * Get fraud stats for Lightning payment patterns.
   */
  paymentStats(): {
    totalPayments: number;
    successRate: number;
    avgQuality: number;
    blockedEndpoints: string[];
  } {
    const allMemories = this.agent.recall('L402 endpoint', 50);
    const successful = allMemories.filter((m) => m.content.includes('successful'));
    const failed = allMemories.filter((m) => m.content.includes('failed'));
    const blocked = allMemories.filter(
      (m) => m.content.includes('blocked') || m.content.includes('fraud'),
    );

    const total = successful.length + failed.length;

    return {
      totalPayments: total,
      successRate: total > 0 ? successful.length / total : 0,
      avgQuality: 0, // would need to parse from memory content
      blockedEndpoints: blocked
        .map((m) => {
          const match = m.content.match(/endpoint (\S+)/);
          return match ? match[1] : '';
        })
        .filter(Boolean),
    };
  }
}
