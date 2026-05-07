/**
 * Merkle-chained audit log. Folded from praetor/packages/core/src/audit.ts
 * (commit 06a5aec) on 2026-05-06 as part of the FiscalGate + Article 12
 * governance fold into MnemoPay SDK.
 *
 * Pure module — only depends on node:crypto.
 */

import { createHash } from "node:crypto";

export interface AuditEvent {
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

export type AuditListener = (event: AuditEvent, chainHash: string, index: number) => void;

export class MerkleAudit {
  private events: AuditEvent[] = [];
  private chain: string[] = [];
  private listeners: AuditListener[] = [];

  /** Subscribe to every record() call. Returns an unsubscribe function. */
  on(listener: AuditListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  record(type: string, data: Record<string, unknown>) {
    const ev: AuditEvent = { ts: new Date().toISOString(), type, data };
    this.events.push(ev);
    const prev = this.chain[this.chain.length - 1] ?? "";
    const next = createHash("sha256").update(prev + JSON.stringify(ev)).digest("hex");
    this.chain.push(next);
    for (const l of this.listeners) {
      try { l(ev, next, this.events.length - 1); } catch { /* listener errors are not chain-breaking */ }
    }
  }

  finalize(): string {
    return this.chain[this.chain.length - 1] ?? createHash("sha256").update("").digest("hex");
  }

  getEvents(): readonly AuditEvent[] {
    return this.events;
  }

  getChain(): readonly string[] {
    return this.chain;
  }

  /** Verify the chain by re-hashing every event from the genesis. */
  verify(): boolean {
    let prev = "";
    for (let i = 0; i < this.events.length; i++) {
      const expected = createHash("sha256").update(prev + JSON.stringify(this.events[i])).digest("hex");
      if (expected !== this.chain[i]) return false;
      prev = expected;
    }
    return true;
  }

  toJSON() {
    return { events: this.events, chain: this.chain };
  }

  static fromJSON(j: { events: AuditEvent[]; chain: string[] }): MerkleAudit {
    const a = new MerkleAudit();
    a.events = j.events.slice();
    a.chain = j.chain.slice();
    return a;
  }
}
