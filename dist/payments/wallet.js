"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletEngine = void 0;
const crypto_1 = require("../security/crypto");
const permissions_1 = require("../security/permissions");
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS wallets (
    agent_id        TEXT    PRIMARY KEY,
    balance         INTEGER NOT NULL DEFAULT 0,
    currency        TEXT    NOT NULL DEFAULT 'USD_CENTS',
    reputation      INTEGER NOT NULL DEFAULT 50,
    nonce           INTEGER NOT NULL DEFAULT 0,
    frozen          INTEGER NOT NULL DEFAULT 0,
    daily_limit     INTEGER NOT NULL DEFAULT 100000,
    daily_spent     INTEGER NOT NULL DEFAULT 0,
    last_reset_date TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id               TEXT    PRIMARY KEY,
    from_agent       TEXT    NOT NULL,
    to_agent         TEXT    NOT NULL,
    amount           INTEGER NOT NULL,
    currency         TEXT    NOT NULL,
    type             TEXT    NOT NULL,
    status           TEXT    NOT NULL,
    escrow_id        TEXT,
    memories_accessed TEXT,
    signature        BLOB    NOT NULL,
    nonce            INTEGER NOT NULL,
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS escrows (
    id          TEXT    PRIMARY KEY,
    buyer_agent TEXT    NOT NULL,
    seller_agent TEXT   NOT NULL,
    amount      INTEGER NOT NULL,
    conditions  TEXT    NOT NULL,
    timeout     INTEGER NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'active',
    created_at  INTEGER NOT NULL
  );
`;
class WalletEngine {
    db;
    crypto;
    guard;
    rateLimiter;
    fraud;
    agentId;
    dailyLimitCents;
    constructor(db, crypto, guard, rateLimiter, fraud, agentId, dailyLimitCents) {
        this.db = db;
        this.crypto = crypto;
        this.guard = guard;
        this.rateLimiter = rateLimiter;
        this.fraud = fraud;
        this.agentId = agentId;
        this.dailyLimitCents = dailyLimitCents;
    }
    static initSchema(db) {
        db.exec(SCHEMA);
    }
    today() {
        return new Date().toISOString().slice(0, 10);
    }
    // Auto-create wallet if first time seeing agentId
    ensureWallet(agentId) {
        const exists = this.db.prepare(`SELECT agent_id FROM wallets WHERE agent_id = ?`).get(agentId);
        if (!exists) {
            this.db.prepare(`
        INSERT INTO wallets (agent_id, balance, currency, reputation, nonce, frozen, daily_limit, daily_spent, last_reset_date)
        VALUES (?, 0, 'USD_CENTS', 50, 0, 0, ?, 0, ?)
      `).run(agentId, Number(this.dailyLimitCents), this.today());
        }
    }
    resetDailyIfNeeded(agentId) {
        const today = this.today();
        const wallet = this.db.prepare(`SELECT last_reset_date FROM wallets WHERE agent_id = ?`).get(agentId);
        if (wallet?.last_reset_date !== today) {
            this.db.prepare(`UPDATE wallets SET daily_spent = 0, last_reset_date = ? WHERE agent_id = ?`)
                .run(today, agentId);
        }
    }
    getWallet(agentId) {
        this.guard.enforce('wallet:read');
        const id = agentId ?? this.agentId;
        this.ensureWallet(id);
        const row = this.db.prepare(`SELECT * FROM wallets WHERE agent_id = ?`).get(id);
        return {
            agentId: row.agent_id,
            balance: BigInt(row.balance),
            currency: 'USD_CENTS',
            reputation: row.reputation,
            nonce: row.nonce,
            frozen: row.frozen === 1,
            dailyLimit: BigInt(row.daily_limit),
            dailySpent: BigInt(row.daily_spent),
            lastResetDate: row.last_reset_date,
        };
    }
    // ── send — 10-step atomic transfer ──────────────────────────────────────────
    async send(toAgent, amount, memoriesAccessed = []) {
        this.guard.enforce('wallet:send');
        // 1. Validate
        if (amount <= 0n)
            throw new permissions_1.SecurityError('INVALID_AMOUNT', 'Amount must be positive');
        if (toAgent === this.agentId)
            throw new permissions_1.SecurityError('SELF_TRANSFER', 'Cannot send to self');
        const { allowed } = this.rateLimiter.check(this.agentId, 'transaction');
        if (!allowed)
            throw new permissions_1.SecurityError('RATE_LIMITED', 'Transaction rate limit exceeded');
        this.ensureWallet(this.agentId);
        this.ensureWallet(toAgent);
        this.resetDailyIfNeeded(this.agentId);
        const txId = (0, crypto_1.generateId)('tx');
        const now = Date.now();
        return this.db.transaction(async () => {
            // 3. Row-level lock via IMMEDIATE
            const sender = this.db.prepare(`SELECT * FROM wallets WHERE agent_id = ?`).get(this.agentId);
            // 4. Pre-flight checks
            if (sender.frozen)
                throw new permissions_1.SecurityError('WALLET_FROZEN', 'Sender wallet is frozen');
            if (BigInt(sender.balance) < amount)
                throw new permissions_1.SecurityError('INSUFFICIENT_BALANCE', 'Insufficient balance');
            const dailyRemaining = BigInt(sender.daily_limit) - BigInt(sender.daily_spent);
            if (amount > dailyRemaining)
                throw new permissions_1.SecurityError('DAILY_LIMIT_EXCEEDED', `Daily limit exceeded. Remaining: ${dailyRemaining} cents`);
            // 5. Increment nonce
            const nonce = sender.nonce + 1;
            this.db.prepare(`UPDATE wallets SET nonce = ? WHERE agent_id = ?`).run(nonce, this.agentId);
            // 6. Replay check
            const replaySig = this.fraud.checkReplay(this.agentId, nonce);
            if (replaySig)
                throw new permissions_1.SecurityError('REPLAY_DETECTED', 'Replay attack detected');
            // 7. Sign transaction data
            const txData = Buffer.from(JSON.stringify({ txId, from: this.agentId, to: toAgent, amount: amount.toString(), nonce, now }));
            const signature = await this.crypto.sign(txData);
            // 7b. Collusion check
            const collusionSig = this.fraud.checkCollusion(this.agentId, toAgent);
            if (collusionSig?.autoAction === 'freeze') {
                this.db.prepare(`UPDATE wallets SET frozen = 1 WHERE agent_id IN (?, ?)`).run(this.agentId, toAgent);
                throw new permissions_1.SecurityError('COLLUSION_DETECTED', 'Circular payment pattern detected — wallets frozen');
            }
            // 8. Atomic debit/credit
            this.db.prepare(`UPDATE wallets SET balance = balance - ?, daily_spent = daily_spent + ? WHERE agent_id = ?`)
                .run(Number(amount), Number(amount), this.agentId);
            this.db.prepare(`UPDATE wallets SET balance = balance + ? WHERE agent_id = ?`)
                .run(Number(amount), toAgent);
            // 9. Record transaction
            this.db.prepare(`
        INSERT INTO transactions (id, from_agent, to_agent, amount, currency, type, status, memories_accessed, signature, nonce, created_at)
        VALUES (?, ?, ?, ?, 'USD_CENTS', 'payment', 'settled', ?, ?, ?, ?)
      `).run(txId, this.agentId, toAgent, Number(amount), JSON.stringify(memoriesAccessed), signature, nonce, now);
            this.fraud.recordAction(this.agentId, `send:${toAgent}:${amount}`);
            return {
                id: txId, fromAgent: this.agentId, toAgent, amount, currency: 'USD_CENTS',
                type: 'payment', status: 'settled',
                memoriesAccessed, signature: Buffer.from(signature).toString('hex'),
                nonce, createdAt: now,
            };
        })();
    }
    // ── createEscrow ─────────────────────────────────────────────────────────────
    async createEscrow(sellerAgent, amount, conditions, timeoutMs = 86_400_000) {
        this.guard.enforce('wallet:escrow');
        if (amount <= 0n)
            throw new permissions_1.SecurityError('INVALID_AMOUNT', 'Escrow amount must be positive');
        this.ensureWallet(this.agentId);
        this.resetDailyIfNeeded(this.agentId);
        const escrowId = (0, crypto_1.generateId)('escrow');
        const now = Date.now();
        const timeout = now + timeoutMs;
        const fullConditions = conditions.map(c => ({ ...c, met: false }));
        this.db.transaction(() => {
            const sender = this.db.prepare(`SELECT * FROM wallets WHERE agent_id = ?`).get(this.agentId);
            if (sender.frozen)
                throw new permissions_1.SecurityError('WALLET_FROZEN', 'Wallet is frozen');
            if (BigInt(sender.balance) < amount)
                throw new permissions_1.SecurityError('INSUFFICIENT_BALANCE', 'Insufficient balance for escrow');
            this.db.prepare(`UPDATE wallets SET balance = balance - ? WHERE agent_id = ?`)
                .run(Number(amount), this.agentId);
            this.db.prepare(`
        INSERT INTO escrows (id, buyer_agent, seller_agent, amount, conditions, timeout, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(escrowId, this.agentId, sellerAgent, Number(amount), JSON.stringify(fullConditions), timeout, now);
            this.db.prepare(`
        INSERT INTO transactions (id, from_agent, to_agent, amount, currency, type, status, escrow_id, memories_accessed, signature, nonce, created_at)
        VALUES (?, ?, ?, ?, 'USD_CENTS', 'escrow_lock', 'escrowed', ?, '[]', '', 0, ?)
      `).run((0, crypto_1.generateId)('tx'), this.agentId, sellerAgent, Number(amount), escrowId, now);
        })();
        return {
            id: escrowId, buyerAgent: this.agentId, sellerAgent,
            amount, conditions: fullConditions,
            timeout, status: 'active', createdAt: now,
        };
    }
    // ── settle — the atomic operation tying memory + payment + reputation ────────
    async settle(escrowId, memoriesAccessed = []) {
        const escrowRow = this.db.prepare(`SELECT * FROM escrows WHERE id = ?`).get(escrowId);
        if (!escrowRow)
            throw new permissions_1.SecurityError('NOT_FOUND', `Escrow ${escrowId} not found`);
        if (escrowRow.status !== 'active')
            throw new permissions_1.SecurityError('INVALID_STATUS', `Escrow is ${escrowRow.status}`);
        if (Date.now() > escrowRow.timeout) {
            this.db.prepare(`UPDATE escrows SET status = 'refunded' WHERE id = ?`).run(escrowId);
            this.db.prepare(`UPDATE wallets SET balance = balance + ? WHERE agent_id = ?`)
                .run(escrowRow.amount, escrowRow.buyer_agent);
            throw new permissions_1.SecurityError('ESCROW_EXPIRED', 'Escrow has timed out and been refunded');
        }
        const conditions = JSON.parse(escrowRow.conditions);
        const unmet = conditions.filter(c => !c.met);
        if (unmet.length > 0)
            throw new permissions_1.SecurityError('CONDITIONS_NOT_MET', `Unmet conditions: ${unmet.map(c => c.type).join(', ')}`);
        const txId = (0, crypto_1.generateId)('tx');
        const now = Date.now();
        const amount = BigInt(escrowRow.amount);
        const txData = Buffer.from(JSON.stringify({ txId, escrowId, from: escrowRow.buyer_agent, to: escrowRow.seller_agent, amount: amount.toString(), now }));
        const signature = await this.crypto.sign(txData);
        // Atomic: credit seller + boost reputation + close escrow
        this.db.transaction(() => {
            this.db.prepare(`UPDATE wallets SET balance = balance + ?, reputation = MIN(100, reputation + 1) WHERE agent_id = ?`)
                .run(Number(amount), escrowRow.seller_agent);
            this.db.prepare(`UPDATE escrows SET status = 'released' WHERE id = ?`).run(escrowId);
            this.db.prepare(`
        INSERT INTO transactions (id, from_agent, to_agent, amount, currency, type, status, escrow_id, memories_accessed, signature, nonce, created_at)
        VALUES (?, ?, ?, ?, 'USD_CENTS', 'escrow_release', 'settled', ?, ?, ?, 0, ?)
      `).run(txId, escrowRow.buyer_agent, escrowRow.seller_agent, Number(amount), escrowId, JSON.stringify(memoriesAccessed), signature, now);
        })();
        this.fraud.recordAction(escrowRow.seller_agent, `settle:${escrowId}`);
        return {
            id: txId, fromAgent: escrowRow.buyer_agent, toAgent: escrowRow.seller_agent,
            amount, currency: 'USD_CENTS', type: 'escrow_release', status: 'settled',
            escrowId, memoriesAccessed,
            signature: Buffer.from(signature).toString('hex'),
            nonce: 0, createdAt: now,
        };
    }
    // Mark an escrow condition as met
    markConditionMet(escrowId, conditionType) {
        const row = this.db.prepare(`SELECT conditions FROM escrows WHERE id = ?`).get(escrowId);
        if (!row)
            throw new permissions_1.SecurityError('NOT_FOUND', `Escrow ${escrowId} not found`);
        const conditions = JSON.parse(row.conditions);
        const idx = conditions.findIndex(c => c.type === conditionType);
        if (idx !== -1) {
            conditions[idx].met = true;
            this.db.prepare(`UPDATE escrows SET conditions = ? WHERE id = ?`).run(JSON.stringify(conditions), escrowId);
        }
    }
    freezeWallet(agentId) {
        this.guard.enforce('admin:freeze');
        this.db.prepare(`UPDATE wallets SET frozen = 1 WHERE agent_id = ?`).run(agentId);
    }
    getTransactionHistory(limit = 50) {
        this.guard.enforce('wallet:read');
        const rows = this.db.prepare(`
      SELECT * FROM transactions WHERE from_agent = ? OR to_agent = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(this.agentId, this.agentId, limit);
        return rows.map(r => ({
            id: r.id, fromAgent: r.from_agent, toAgent: r.to_agent,
            amount: BigInt(r.amount), currency: 'USD_CENTS',
            type: r.type, status: r.status, escrowId: r.escrow_id ?? undefined,
            memoriesAccessed: JSON.parse(r.memories_accessed ?? '[]'),
            signature: Buffer.from(r.signature).toString('hex'),
            nonce: r.nonce, createdAt: r.created_at,
        }));
    }
}
exports.WalletEngine = WalletEngine;
//# sourceMappingURL=wallet.js.map