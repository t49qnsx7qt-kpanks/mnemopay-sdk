/**
 * FiscalGate mission runtime. Folded from praetor/packages/core/src/runtime.ts
 * (commit 06a5aec) on 2026-05-06.
 *
 * runMission() is the FiscalGate primitive: every charter run reserves the
 * full budget up-front, runs the agent loop, and only settles the actual
 * spend at the end. Over-budget runs return status=halted with the budget
 * released. Errors return status=error with the budget released.
 */

import type { Charter } from "./charter.js";

export interface MissionResult {
  charterName: string;
  status: "ok" | "halted" | "error";
  spentUsd: number;
  outputs: string[];
  auditDigest: string;
  startedAt: string;
  finishedAt: string;
}

export interface MissionContext {
  charter: Charter;
  payments: {
    reserve: (usd: number) => Promise<{ holdId: string }>;
    settle: (holdId: string, usd: number) => Promise<void>;
    release?: (holdId: string) => Promise<void>;
  };
  agents: { run: (charter: Charter, signal?: AbortSignal) => Promise<{ outputs: string[]; spentUsd: number }> };
  audit: { record: (event: string, data: Record<string, unknown>) => void; finalize: () => string };
  signal?: AbortSignal;
}

export async function runMission(ctx: MissionContext): Promise<MissionResult> {
  const startedAt = new Date().toISOString();
  ctx.audit.record("mission.start", { charter: ctx.charter.name, budget: ctx.charter.budget });
  const hold = await ctx.payments.reserve(ctx.charter.budget.maxUsd);
  ctx.audit.record("budget.reserved", { holdId: hold.holdId, maxUsd: ctx.charter.budget.maxUsd });
  let result;
  if (ctx.signal?.aborted) throw new Error("Mission aborted");
  try {
    result = await ctx.agents.run(ctx.charter, ctx.signal);
  } catch (e) {
    ctx.audit.record("mission.error", { error: (e as Error).message });
    await ctx.payments.release?.(hold.holdId);
    return {
      charterName: ctx.charter.name,
      status: "error",
      spentUsd: 0,
      outputs: [],
      auditDigest: ctx.audit.finalize(),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  if (result.spentUsd > ctx.charter.budget.maxUsd) {
    ctx.audit.record("budget.exceeded", { spentUsd: result.spentUsd, maxUsd: ctx.charter.budget.maxUsd });
    await ctx.payments.release?.(hold.holdId);
    return {
      charterName: ctx.charter.name,
      status: "halted",
      spentUsd: result.spentUsd,
      outputs: result.outputs,
      auditDigest: ctx.audit.finalize(),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  await ctx.payments.settle(hold.holdId, result.spentUsd);
  ctx.audit.record("mission.complete", { outputs: result.outputs.length, spentUsd: result.spentUsd });
  return {
    charterName: ctx.charter.name,
    status: "ok",
    spentUsd: result.spentUsd,
    outputs: result.outputs,
    auditDigest: ctx.audit.finalize(),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
