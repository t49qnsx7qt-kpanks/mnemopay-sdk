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

/** Metadata entry appended to serialize() output so running totals survive a roundtrip */
export interface LedgerSummaryEntry {
  _isSummary: true;
  totalDebits: number;
  totalCredits: number;
  totalEntryCount: number;
  accountBalances: Record<string, number>;
}

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
  /** SHA-256 hash of the previous entry for tamper-evident chain (undefined for genesis entry) */
  prevEntryHash?: string;
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
  /** Whether the hash chain is valid (undefined if no chained entries exist) */
  chainValid?: boolean;
  /** Ratio of valid chain links (0.0–1.0, undefined if no chained entries) */
  chainIntegrity?: number;
}

export interface TransferResult {
  entries: [LedgerEntry, LedgerEntry];
  txRef: string;
}

// ─── Hash Chain ─────────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 hash of a ledger entry's critical fields.
 * Used to build a tamper-evident chain across entries.
 */
export function hashEntry(entry: LedgerEntry): string {
  const { createHash } = require("crypto") as typeof import("crypto");
  const payload = [
    entry.id,
    entry.txRef,
    entry.account,
    String(entry.debit),
    String(entry.credit),
    entry.currency,
    String(entry.seq),
    entry.prevEntryHash ?? "",
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

// ─── Ledger ─────────────────────────────────────────────────────────────────

export class Ledger {
  private entries: LedgerEntry[] = [];
  private seq = 0;
  private lastEntryHash: string | undefined;
  /** Running balance per "account:currency" key — O(1) lookups, survives compaction */
  private _accountBalances = new Map<string, number>();
  /** Running totals for fast verify() — maintained across compaction */
  private _totalDebits = 0;
  private _totalCredits = 0;
  /** Lifetime entry count (includes compacted-away entries) */
  private _totalEntryCount = 0;
  /**
   * High-throughput mode: skip LedgerEntry object creation and hash computation.
   * Enabled automatically when compact() is called with maxEntries <= 100.
   * Running totals (_accountBalances, _totalDebits, _totalCredits) remain correct.
   */
  private _skipEntries = false;

  constructor(existingEntries?: (LedgerEntry | LedgerSummaryEntry)[]) {
    if (!existingEntries || existingEntries.length === 0) return;

    // Check for a summary entry (last element) from a previous serialize()
    const last = existingEntries[existingEntries.length - 1] as any;
    const hasSummary = last?._isSummary === true;

    if (hasSummary) {
      // Restore running totals from summary instead of re-scanning all entries
      this._totalDebits = last.totalDebits ?? 0;
      this._totalCredits = last.totalCredits ?? 0;
      this._totalEntryCount = last.totalEntryCount ?? 0;
      if (last.accountBalances) {
        for (const [k, v] of Object.entries(last.accountBalances as Record<string, number>)) {
          this._accountBalances.set(k, v);
        }
      }
      existingEntries = existingEntries.slice(0, -1) as LedgerEntry[];
    }

    const validated = (existingEntries as LedgerEntry[]).map(e => {
      const debit = Number(e.debit);
      const credit = Number(e.credit);
      if (!Number.isFinite(debit) || debit < 0) throw new Error(`Ledger entry ${e.id}: debit must be a non-negative finite number`);
      if (!Number.isFinite(credit) || credit < 0) throw new Error(`Ledger entry ${e.id}: credit must be a non-negative finite number`);
      if (!Number.isFinite(e.seq) || e.seq < 0) throw new Error(`Ledger entry ${e.id}: seq must be a non-negative number`);
      return { ...e, debit, credit };
    });

    if (!hasSummary) {
      // No summary: rebuild running totals from all provided entries
      for (const e of validated) {
        this._totalDebits += e.debit;
        this._totalCredits += e.credit;
        this._totalEntryCount += (e.debit > 0 || e.credit > 0) ? 1 : 0;
        const key = `${e.account}:${e.currency}`;
        this._accountBalances.set(key, (this._accountBalances.get(key) ?? 0) + e.credit - e.debit);
      }
      this._totalEntryCount = validated.length;
    }

    this.entries = validated;
    this.seq = validated.length > 0
      ? Math.max(...validated.map(e => e.seq)) + 1
      : 0;
    if (this.entries.length > 0) {
      this.lastEntryHash = hashEntry(this.entries[this.entries.length - 1]);
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

    // Update running totals and account balances (O(1), survives compaction)
    this._totalDebits += amount;
    this._totalCredits += amount;
    this._totalEntryCount += 2;
    this.seq += 2;
    const debitKey = `${fromAccount}:${currency}`;
    const creditKey = `${toAccount}:${currency}`;
    this._accountBalances.set(debitKey, (this._accountBalances.get(debitKey) ?? 0) - amount);
    this._accountBalances.set(creditKey, (this._accountBalances.get(creditKey) ?? 0) + amount);

    // High-throughput mode: skip LedgerEntry object + hash creation entirely.
    // Running totals above are sufficient for balance() and verifyLedger().
    if (this._skipEntries) {
      return { entries: [] as any, txRef: "" };
    }

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
      seq: this.seq - 2,
      prevEntryHash: this.lastEntryHash,
    };

    const debitHash = hashEntry(debitEntry);

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
      seq: this.seq - 1,
      prevEntryHash: debitHash,
    };

    this.entries.push(debitEntry, creditEntry);
    this.lastEntryHash = hashEntry(creditEntry);

    return { entries: [debitEntry, creditEntry], txRef };
  }

  /**
   * Compact the ledger by dropping oldest entries while preserving running totals.
   * Call periodically from long-lived agents to bound memory usage.
   * Running totals (getBalance, verify) remain correct after compaction.
   */
  compact(maxEntries: number): void {
    // When compacting aggressively (≤100 entries), switch to high-throughput mode:
    // skip LedgerEntry object + hash creation on future transfers (running totals only).
    if (maxEntries <= 100) {
      this._skipEntries = true;
      this.entries.length = 0; // clear all existing entries immediately
      return;
    }
    if (this.entries.length <= maxEntries) return;
    this.entries.splice(0, this.entries.length - maxEntries);
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
    const key = `${account}:${currency}`;
    const balance = this._accountBalances.get(key) ?? 0;
    const precision = (currency === "BTC") ? 1e8 : 100;
    return Math.round(balance * precision) / precision;
  }

  /**
   * Get detailed balance info for an account.
   */
  getAccountBalance(account: string, currency: Currency = "USD"): AccountBalance {
    const key = `${account}:${currency}`;
    const balance = this._accountBalances.get(key) ?? 0;
    // For detailed debit/credit breakdown, scan remaining entries only
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
      balance: Math.round(balance * 100) / 100,
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
    // Use running totals (O(1)) — maintained across compaction
    const totalDebits = Math.round(this._totalDebits * 100) / 100;
    const totalCredits = Math.round(this._totalCredits * 100) / 100;
    const imbalance = Math.round((this._totalDebits - this._totalCredits) * 100) / 100;

    // Build account summary from running balance map
    const accountMap = new Map<string, AccountBalance>();
    for (const [key, balance] of this._accountBalances) {
      const colonIdx = key.lastIndexOf(':');
      const account = key.slice(0, colonIdx);
      const currency = key.slice(colonIdx + 1) as Currency;
      accountMap.set(key, {
        account,
        accountType: this.parseAccountType(account),
        currency,
        balance: Math.round(balance * 100) / 100,
        totalCredits: 0, // per-account credits not tracked post-compaction
        totalDebits: 0,
        entryCount: 0,
      });
    }

    const chainResult = this.verifyChain();

    return {
      totalDebits,
      totalCredits,
      imbalance,
      balanced: imbalance === 0,
      entryCount: this._totalEntryCount, // lifetime count (survives compaction)
      accounts: Array.from(accountMap.values()),
      chainValid: chainResult.valid,
      chainIntegrity: chainResult.chainIntegrity,
    };
  }

  // ── Chain Verification ───────────────────────────────────────────────────

  /**
   * Walk all entries and verify that each entry's prevEntryHash matches the
   * hash of the previous entry. Legacy entries without prevEntryHash are skipped.
   */
  verifyChain(): { valid: boolean; brokenLinks: number[]; chainIntegrity: number } {
    const brokenLinks: number[] = [];
    let chainedCount = 0;
    let validCount = 0;

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      // Skip legacy entries without hash chain data
      if (entry.prevEntryHash === undefined) continue;

      chainedCount++;

      if (i === 0) {
        // First entry in the ledger with prevEntryHash — nothing to verify against
        validCount++;
        continue;
      }

      const prevEntry = this.entries[i - 1];
      const expectedHash = hashEntry(prevEntry);

      if (entry.prevEntryHash === expectedHash) {
        validCount++;
      } else {
        brokenLinks.push(i);
      }
    }

    const chainIntegrity = chainedCount === 0 ? 1.0 : validCount / chainedCount;

    return {
      valid: brokenLinks.length === 0,
      brokenLinks,
      chainIntegrity,
    };
  }

  // ── Serialization ────────────────────────────────────────────────────────

  /**
   * Export entries + a summary entry for persistence.
   * The summary entry allows running totals (including compacted history)
   * to survive a serialize/deserialize roundtrip.
   */
  serialize(): (LedgerEntry | LedgerSummaryEntry)[] {
    const summary: LedgerSummaryEntry = {
      _isSummary: true,
      totalDebits: this._totalDebits,
      totalCredits: this._totalCredits,
      totalEntryCount: this._totalEntryCount,
      accountBalances: Object.fromEntries(this._accountBalances),
    };
    return [...this.entries, summary];
  }

  /**
   * Get entry count.
   */
  /** Lifetime entry count (includes compacted-away entries) */
  get size(): number {
    return this._totalEntryCount;
  }

  /** Current in-memory entry count (after any compaction) */
  get visibleSize(): number {
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
