/**
 * Double-Entry Ledger for MnemoPay
 *
 * Every financial operation records two entries (debit + credit) that always
 * balance to zero. This is the accounting standard required by regulators,
 * bank partners, and auditors.
 *
 * Account types:
 *   - agent:{agentId}        → Agent wallet (available funds)
 *   - escrow:{agentId}       → Funds held in escrow pending settlement
 *   - platform:revenue       → Platform fee income
 *   - platform:float         → Funds in transit / settlement buffer
 *   - counterparty:{agentId} → Funds owed to/from counterparty agents
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type AccountType =
  | "agent"         // Agent's available balance
  | "escrow"        // Funds held pending settlement
  | "revenue"       // Platform fee revenue
  | "float"         // Settlement buffer
  | "counterparty"; // Inter-agent settlement

export type EntryDirection = "debit" | "credit";

export type Currency = "USD" | "USDC" | "BTC" | "EUR" | "NGN";

export interface LedgerEntry {
  id: string;
  /** Links debit+credit pair */
  txRef: string;
  /** Full account identifier (e.g., "agent:agent-123") */
  account: string;
  /** Account type for querying */
  accountType: AccountType;
  /** Debit amount (money going out of this account) */
  debit: number;
  /** Credit amount (money coming into this account) */
  credit: number;
  /** Currency code */
  currency: Currency;
  /** Human-readable description */
  description: string;
  /** Related MnemoPay transaction ID */
  relatedTxId?: string;
  /** Counterparty account for cross-referencing */
  counterAccount?: string;
  /** ISO timestamp */
  createdAt: string;
  /** Sequence number for ordering (monotonically increasing) */
  seq: number;
}

export interface AccountBalance {
  account: string;
  accountType: AccountType;
  currency: Currency;
  /** Total credits minus total debits */
  balance: number;
  /** Sum of all credits */
  totalCredits: number;
  /** Sum of all debits */
  totalDebits: number;
  /** Number of entries */
  entryCount: number;
}

export interface LedgerSummary {
  /** Total debits across all accounts (should equal totalCredits) */
  totalDebits: number;
  /** Total credits across all accounts (should equal totalCredits) */
  totalCredits: number;
  /** Must be zero if ledger is balanced */
  imbalance: number;
  /** Whether the ledger balances */
  balanced: boolean;
  /** Number of entries */
  entryCount: number;
  /** All account balances */
  accounts: AccountBalance[];
}

export interface TransferResult {
  entries: [LedgerEntry, LedgerEntry];
  txRef: string;
}

// ─── Ledger ─────────────────────────────────────────────────────────────────

export class Ledger {
  private entries: LedgerEntry[] = [];
  private seq = 0;

  constructor(existingEntries?: LedgerEntry[]) {
    if (existingEntries) {
      // Validate every entry on load — reject corrupted data
      this.entries = existingEntries.map(e => {
        const debit = Number(e.debit);
        const credit = Number(e.credit);
        if (!Number.isFinite(debit) || debit < 0) throw new Error(`Ledger entry ${e.id}: debit must be a non-negative finite number`);
        if (!Number.isFinite(credit) || credit < 0) throw new Error(`Ledger entry ${e.id}: credit must be a non-negative finite number`);
        if (!Number.isFinite(e.seq) || e.seq < 0) throw new Error(`Ledger entry ${e.id}: seq must be a non-negative number`);
        return { ...e, debit, credit };
      });
      this.seq = this.entries.length > 0
        ? Math.max(...this.entries.map(e => e.seq)) + 1
        : 0;
    }
  }

  // ── Core: Double-Entry Transfer ──────────────────────────────────────────

  /**
   * Record a double-entry transfer. Debits one account, credits another.
   * The ledger always balances: every debit has an equal credit.
   */
  transfer(
    fromAccount: string,
    toAccount: string,
    amount: number,
    currency: Currency,
    description: string,
    relatedTxId?: string,
  ): TransferResult {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ledger transfer amount must be a positive finite number");
    if (!fromAccount || !toAccount) throw new Error("Both fromAccount and toAccount are required");
    if (fromAccount === toAccount) throw new Error("Cannot transfer to the same account");

    const txRef = crypto.randomUUID();
    const now = new Date().toISOString();

    const debitEntry: LedgerEntry = {
      id: crypto.randomUUID(),
      txRef,
      account: fromAccount,
      accountType: this.parseAccountType(fromAccount),
      debit: amount,
      credit: 0,
      currency,
      description,
      relatedTxId,
      counterAccount: toAccount,
      createdAt: now,
      seq: this.seq++,
    };

    const creditEntry: LedgerEntry = {
      id: crypto.randomUUID(),
      txRef,
      account: toAccount,
      accountType: this.parseAccountType(toAccount),
      debit: 0,
      credit: amount,
      currency,
      description,
      relatedTxId,
      counterAccount: fromAccount,
      createdAt: now,
      seq: this.seq++,
    };

    this.entries.push(debitEntry, creditEntry);
    return { entries: [debitEntry, creditEntry], txRef };
  }

  // ── Payment Flow Methods ─────────────────────────────────────────────────

  /**
   * CHARGE: Move funds from agent's available balance into escrow.
   * Debit agent → Credit escrow
   */
  recordCharge(agentId: string, amount: number, txId: string, currency: Currency = "USD"): TransferResult {
    return this.transfer(
      `agent:${agentId}`,
      `escrow:${agentId}`,
      amount,
      currency,
      `Hold for pending charge`,
      txId,
    );
  }

  /**
   * SETTLE: Release escrow, deduct platform fee, credit counterparty.
   * Returns 2-3 transfer results (escrow→float, float→revenue for fee, float→counterparty for net).
   */
  recordSettlement(
    agentId: string,
    txId: string,
    grossAmount: number,
    feeAmount: number,
    netAmount: number,
    counterpartyId?: string,
    currency: Currency = "USD",
  ): TransferResult[] {
    const results: TransferResult[] = [];

    // 1. Escrow → Platform float (full gross amount)
    results.push(this.transfer(
      `escrow:${agentId}`,
      `platform:float`,
      grossAmount,
      currency,
      `Settlement release from escrow`,
      txId,
    ));

    // 2. Platform float → Platform revenue (fee portion)
    if (feeAmount > 0) {
      results.push(this.transfer(
        `platform:float`,
        `platform:revenue`,
        feeAmount,
        currency,
        `Platform fee (${((feeAmount / grossAmount) * 100).toFixed(1)}%)`,
        txId,
      ));
    }

    // 3. Platform float → Counterparty or back to agent (net amount)
    const destination = counterpartyId
      ? `counterparty:${counterpartyId}`
      : `agent:${agentId}`;
    results.push(this.transfer(
      `platform:float`,
      destination,
      netAmount,
      currency,
      `Net settlement payout`,
      txId,
    ));

    return results;
  }

  /**
   * REFUND: Reverse a completed transaction.
   * Credits back the agent, debits counterparty/revenue.
   */
  recordRefund(
    agentId: string,
    txId: string,
    netAmount: number,
    counterpartyId?: string,
    currency: Currency = "USD",
  ): TransferResult[] {
    const results: TransferResult[] = [];

    if (counterpartyId) {
      // Reverse: counterparty returns net to agent
      results.push(this.transfer(
        `counterparty:${counterpartyId}`,
        `agent:${agentId}`,
        netAmount,
        currency,
        `Refund — reversal of net settlement`,
        txId,
      ));
    } else {
      // No counterparty: reverse the float→agent payout from settlement
      results.push(this.transfer(
        `agent:${agentId}`,
        `platform:float`,
        netAmount,
        currency,
        `Refund — reversal of net settlement`,
        txId,
      ));
    }

    return results;
  }

  /**
   * CANCEL: Release escrow back to agent (charge was never settled).
   */
  recordCancellation(agentId: string, amount: number, txId: string, currency: Currency = "USD"): TransferResult {
    return this.transfer(
      `escrow:${agentId}`,
      `agent:${agentId}`,
      amount,
      currency,
      `Cancelled — escrow released`,
      txId,
    );
  }

  /**
   * FUND: External funds coming into an agent's wallet (top-up, deposit).
   */
  recordFunding(agentId: string, amount: number, source: string, currency: Currency = "USD"): TransferResult {
    return this.transfer(
      `platform:float`,
      `agent:${agentId}`,
      amount,
      currency,
      `Wallet funding from ${source}`,
    );
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /**
   * Get balance for a specific account.
   * Balance = SUM(credits) - SUM(debits)
   */
  getBalance(account: string, currency: Currency = "USD"): number {
    let balance = 0;
    for (const entry of this.entries) {
      if (entry.account === account && entry.currency === currency) {
        balance += entry.credit - entry.debit;
      }
    }
    // Round to appropriate precision: 2 decimals for fiat, 8 for crypto
    const precision = (currency === "BTC") ? 1e8 : 100;
    return Math.round(balance * precision) / precision;
  }

  /**
   * Get detailed balance info for an account.
   */
  getAccountBalance(account: string, currency: Currency = "USD"): AccountBalance {
    let totalCredits = 0;
    let totalDebits = 0;
    let entryCount = 0;
    for (const entry of this.entries) {
      if (entry.account === account && entry.currency === currency) {
        totalCredits += entry.credit;
        totalDebits += entry.debit;
        entryCount++;
      }
    }
    return {
      account,
      accountType: this.parseAccountType(account),
      currency,
      balance: Math.round((totalCredits - totalDebits) * 100) / 100,
      totalCredits: Math.round(totalCredits * 100) / 100,
      totalDebits: Math.round(totalDebits * 100) / 100,
      entryCount,
    };
  }

  /**
   * Get all entries for a specific transaction.
   */
  getEntriesForTransaction(txId: string): LedgerEntry[] {
    return this.entries.filter(e => e.relatedTxId === txId);
  }

  /**
   * Get all entries for a specific account, optionally filtered by date range.
   */
  getAccountHistory(account: string, limit = 50, offset = 0): LedgerEntry[] {
    return this.entries
      .filter(e => e.account === account)
      .sort((a, b) => b.seq - a.seq)
      .slice(offset, offset + limit);
  }

  /**
   * Verify the entire ledger balances (total debits = total credits).
   */
  verify(): LedgerSummary {
    const accountMap = new Map<string, AccountBalance>();

    let totalDebits = 0;
    let totalCredits = 0;

    for (const entry of this.entries) {
      totalDebits += entry.debit;
      totalCredits += entry.credit;

      const key = `${entry.account}:${entry.currency}`;
      if (!accountMap.has(key)) {
        accountMap.set(key, {
          account: entry.account,
          accountType: entry.accountType,
          currency: entry.currency,
          balance: 0,
          totalCredits: 0,
          totalDebits: 0,
          entryCount: 0,
        });
      }
      const acct = accountMap.get(key)!;
      acct.totalCredits += entry.credit;
      acct.totalDebits += entry.debit;
      acct.balance = Math.round((acct.totalCredits - acct.totalDebits) * 100) / 100;
      acct.entryCount++;
    }

    const imbalance = Math.round((totalDebits - totalCredits) * 100) / 100;

    return {
      totalDebits: Math.round(totalDebits * 100) / 100,
      totalCredits: Math.round(totalCredits * 100) / 100,
      imbalance,
      balanced: imbalance === 0,
      entryCount: this.entries.length,
      accounts: Array.from(accountMap.values()),
    };
  }

  // ── Serialization ────────────────────────────────────────────────────────

  /**
   * Export all entries for persistence.
   */
  serialize(): LedgerEntry[] {
    return [...this.entries];
  }

  /**
   * Get entry count.
   */
  get size(): number {
    return this.entries.length;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private parseAccountType(account: string): AccountType {
    const prefix = account.split(":")[0];
    switch (prefix) {
      case "agent": return "agent";
      case "escrow": return "escrow";
      case "platform":
        return account.includes("revenue") ? "revenue" : "float";
      case "counterparty": return "counterparty";
      default: return "agent";
    }
  }
}
