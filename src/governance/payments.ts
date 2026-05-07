/**
 * FiscalGate payments adapter interface. Slimmed from
 * praetor/packages/payments/src/index.ts on 2026-05-06.
 *
 * This is the contract runMission expects. MnemoPay SDK ships only the
 * MockPayments implementation here — real-rail bindings (StripeRail,
 * PaystackRail, LightningRail) live in src/rails/ and can be wrapped with
 * a thin adapter on the caller side. We intentionally don't pull the
 * Praetor MnemoPayAdapter wrapper since this SDK *is* MnemoPay; users
 * compose their MnemoPay instance directly.
 */

export interface PaymentsAdapter {
  reserve: (usd: number) => Promise<{ holdId: string }>;
  settle: (holdId: string, usd: number) => Promise<void>;
  release: (holdId: string) => Promise<void>;
}

export class MockPayments implements PaymentsAdapter {
  private holds = new Map<string, number>();

  async reserve(usd: number) {
    const holdId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.holds.set(holdId, usd);
    return { holdId };
  }

  async settle(holdId: string) {
    this.holds.delete(holdId);
  }

  async release(holdId: string) {
    this.holds.delete(holdId);
  }

  /** Test helper: inspect outstanding holds. */
  getHolds(): ReadonlyMap<string, number> {
    return this.holds;
  }
}
