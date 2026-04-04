/**
 * MnemoPay x x402 Trust Bridge
 *
 * Wraps x402 payment decisions with MnemoPay's memory and trust layer.
 * Agents learn which x402 endpoints deliver value and avoid bad actors.
 */

import type { MnemoPayLite } from '../../src/index.js';

export interface SellerEvaluation {
  shouldPay: boolean;
  reason: string;
  maxAmountUSD: number;
  trustScore: number;
  priorTransactions: number;
}

export interface PaymentRecord {
  seller: string;
  amountUSD: number;
  success: boolean;
  qualityScore: number;
  timestamp: string;
}

export class X402Bridge {
  constructor(private agent: MnemoPayLite) {}

  /**
   * Evaluate whether to pay a seller via x402.
   * Uses memory of past interactions + reputation score.
   */
  evaluateSeller(sellerUrl: string): SellerEvaluation {
    const memories = this.agent.recall(`x402 seller ${sellerUrl}`, 10);
    const profile = this.agent.profile();
    const reputation = profile.reputation;

    // Count positive vs negative experiences
    const positive = memories.filter(
      (m) => m.content.includes('delivered value') || m.content.includes('high quality'),
    );
    const negative = memories.filter(
      (m) =>
        m.content.includes('poor quality') ||
        m.content.includes('failed') ||
        m.content.includes('blocked'),
    );

    // No history — allow small test payment
    if (memories.length === 0) {
      return {
        shouldPay: true,
        reason: 'New seller. Allowing test payment.',
        maxAmountUSD: 0.5, // $0.50 max for unknown sellers
        trustScore: 0.5,
        priorTransactions: 0,
      };
    }

    // Blocked seller
    if (negative.length >= 3 || negative.length > positive.length) {
      return {
        shouldPay: false,
        reason: `Blocked: ${negative.length} negative interactions with this seller.`,
        maxAmountUSD: 0,
        trustScore: 0,
        priorTransactions: memories.length,
      };
    }

    // Calculate trust from history
    const trustRatio = positive.length / Math.max(1, positive.length + negative.length);
    const maxAmount = Math.min(trustRatio * reputation * 100, 50); // Cap at $50

    return {
      shouldPay: true,
      reason: `${positive.length}/${memories.length} positive interactions. Trust: ${(trustRatio * 100).toFixed(0)}%.`,
      maxAmountUSD: maxAmount,
      trustScore: trustRatio,
      priorTransactions: memories.length,
    };
  }

  /**
   * Record outcome of an x402 payment.
   * Triggers the MnemoPay feedback loop on success.
   */
  recordPayment(
    sellerUrl: string,
    amountUSD: number,
    success: boolean,
    responseData?: unknown,
  ): void {
    const quality = success ? this.assessQuality(responseData) : 0;
    const qualityLabel =
      quality >= 0.8 ? 'high quality' : quality >= 0.5 ? 'acceptable' : 'poor quality';
    const outcome = success ? 'delivered value' : 'failed';

    const content = `x402 seller ${sellerUrl}: ${outcome}, $${amountUSD.toFixed(2)} USDC, ${qualityLabel} (${quality.toFixed(2)})`;
    const importance = success ? 0.5 + quality * 0.4 : 0.85;

    this.agent.remember(content, importance, ['x402', outcome, sellerUrl]);

    // Trigger feedback loop for successful payments
    if (success && quality >= 0.5) {
      const tx = this.agent.charge(amountUSD, `x402 payment to ${sellerUrl}`);
      if (tx.id) {
        this.agent.settle(tx.id);
        // Settlement reinforces memories from last hour by +0.05
      }
    }
  }

  /**
   * Get best x402 sellers from memory, ranked by MnemoPay composite score.
   */
  bestSellers(limit: number = 5): Array<{ url: string; score: number }> {
    const memories = this.agent.recall('x402 seller delivered value high quality', limit * 2);
    const sellerScores = new Map<string, number[]>();

    for (const m of memories) {
      const match = m.content.match(/x402 seller (\S+):/);
      if (match && m.content.includes('delivered value')) {
        const url = match[1];
        const scores = sellerScores.get(url) || [];
        scores.push(m.score);
        sellerScores.set(url, scores);
      }
    }

    return Array.from(sellerScores.entries())
      .map(([url, scores]) => ({
        url,
        score: scores.reduce((a, b) => a + b, 0) / scores.length,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Get spending summary for budget management.
   */
  spendingSummary(): {
    totalSpent: number;
    transactionCount: number;
    uniqueSellers: number;
    avgPayment: number;
  } {
    const history = this.agent.history(100);
    const x402Txns = history.filter(
      (tx: { reason?: string }) => tx.reason && tx.reason.includes('x402'),
    );

    const sellers = new Set<string>();
    let total = 0;

    for (const tx of x402Txns) {
      total += tx.amount || 0;
      const match = tx.reason?.match(/to (\S+)/);
      if (match) sellers.add(match[1]);
    }

    return {
      totalSpent: total,
      transactionCount: x402Txns.length,
      uniqueSellers: sellers.size,
      avgPayment: x402Txns.length > 0 ? total / x402Txns.length : 0,
    };
  }

  /**
   * Assess response quality (heuristic).
   */
  private assessQuality(data: unknown): number {
    if (!data) return 0.3;
    if (typeof data === 'string') return data.length > 100 ? 0.7 : 0.5;
    if (typeof data === 'object') {
      const keys = Object.keys(data as Record<string, unknown>);
      if (keys.length > 5) return 0.8;
      if (keys.length > 0) return 0.6;
    }
    return 0.5;
  }
}
