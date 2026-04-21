/**
 * AgentOps-Bench composite scorer.
 *
 * Composite = geometric mean of (memory, payments, identity, integrity).
 * Geometric mean is used on purpose — a zero on any pillar means the system
 * cannot ship, so the composite score must be zero. Arithmetic means reward
 * specialists, which is the opposite of what AgentOps-Bench tries to measure.
 *
 * Secondary tiebreaker (for the leaderboard): arithmetic mean of the four.
 */

export type Pillar = "memory" | "payments" | "identity" | "integrity";

export interface PillarScores {
  memory: number;
  payments: number;
  identity: number;
  integrity: number;
}

export interface AgentOpsScore extends PillarScores {
  composite: number;
  arithmeticMean: number;
  /** True iff any pillar is exactly zero. Composite is 0 in this case. */
  collapsed: boolean;
  /** Which pillar collapsed the score, if any. */
  collapsedBy: Pillar | null;
}

const PILLARS: readonly Pillar[] = ["memory", "payments", "identity", "integrity"] as const;

function validate(scores: PillarScores): void {
  for (const p of PILLARS) {
    const v = scores[p];
    if (typeof v !== "number" || Number.isNaN(v)) {
      throw new Error(`AgentOps: pillar "${p}" is not a number (got ${v})`);
    }
    if (v < 0 || v > 1) {
      throw new Error(`AgentOps: pillar "${p}" must be in [0, 1] (got ${v})`);
    }
  }
}

export function scoreAgentOps(scores: PillarScores): AgentOpsScore {
  validate(scores);

  let collapsedBy: Pillar | null = null;
  for (const p of PILLARS) {
    if (scores[p] === 0) {
      collapsedBy = p;
      break;
    }
  }

  const composite = collapsedBy
    ? 0
    : Math.pow(
        scores.memory * scores.payments * scores.identity * scores.integrity,
        1 / 4,
      );

  const arithmeticMean =
    (scores.memory + scores.payments + scores.identity + scores.integrity) / 4;

  return {
    ...scores,
    composite,
    arithmeticMean,
    collapsed: collapsedBy !== null,
    collapsedBy,
  };
}

/**
 * Compare two AgentOpsScores for leaderboard ordering. Returns a negative
 * number if `a` is better, positive if `b` is better, zero if tied.
 * Primary: composite (higher better). Secondary: arithmetic mean.
 */
export function compareAgentOps(a: AgentOpsScore, b: AgentOpsScore): number {
  if (a.composite !== b.composite) return b.composite - a.composite;
  return b.arithmeticMean - a.arithmeticMean;
}

/**
 * Format a score for human display. `precision` is number of decimals (default 3).
 */
export function formatAgentOps(score: AgentOpsScore, precision = 3): string {
  const fmt = (v: number): string => v.toFixed(precision);
  const lines = [
    `AgentOps composite: ${fmt(score.composite)}${score.collapsed ? `  (collapsed by ${score.collapsedBy})` : ""}`,
    `  memory:    ${fmt(score.memory)}`,
    `  payments:  ${fmt(score.payments)}`,
    `  identity:  ${fmt(score.identity)}`,
    `  integrity: ${fmt(score.integrity)}`,
    `  arith mean: ${fmt(score.arithmeticMean)}`,
  ];
  return lines.join("\n");
}
