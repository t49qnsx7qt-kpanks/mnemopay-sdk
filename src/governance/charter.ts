/**
 * Charter schema. Folded from praetor/packages/core/src/charter.ts (commit
 * 06a5aec) on 2026-05-06 as part of the FiscalGate + Article 12 governance
 * fold into MnemoPay SDK.
 *
 * A charter declares an agent mission's goal, allowed tools, and budget cap.
 * Pure module — no internal deps.
 */

export interface CharterBudget {
  maxUsd: number;
  approvalThresholdUsd: number;
  perToolMaxUsd?: number;
}

export type CharterRole =
  | "architect"
  | "developer"
  | "auditor"
  | "designer"
  | "marketer"
  | "coding"
  | "research"
  | "world-gen";

export interface CharterAgent {
  role: CharterRole;
  model?: string;
  skills?: string[];
}

export interface CharterStep {
  action: string;
  args?: Record<string, unknown>;
}

export interface Charter {
  name: string;
  goal: string;
  steps?: CharterStep[];
  sandbox?: { kind: "mock" | "e2b" | "firecracker-self-hosted" };
  plugins?: string[];
  budget: CharterBudget;
  agents: CharterAgent[];
  outputs: string[];
  compliance?: {
    article12?: boolean;
    auditLogPath?: string;
  };
}

export function validateCharter(c: unknown): Charter {
  if (!c || typeof c !== "object") {
    throw new Error("charter: not an object");
  }
  const ch = c as Partial<Charter>;
  if (!ch.name || typeof ch.name !== "string") throw new Error("charter.name required");
  if (!ch.goal || typeof ch.goal !== "string") throw new Error("charter.goal required");
  if (!ch.budget || typeof ch.budget.maxUsd !== "number") {
    throw new Error("charter.budget.maxUsd required");
  }
  if (!Array.isArray(ch.agents) || ch.agents.length === 0) {
    throw new Error("charter.agents must be a non-empty array");
  }
  if (!Array.isArray(ch.outputs)) throw new Error("charter.outputs must be an array");
  return ch as Charter;
}
