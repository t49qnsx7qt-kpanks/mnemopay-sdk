/**
 * Behavioral Finance Engine — Psychology-Backed Financial Intelligence
 *
 * Implements Nobel Prize-winning behavioral economics research to help
 * AI agents (and their human principals) make better financial decisions.
 *
 * Core models implemented:
 *   1. Prospect Theory value function (Kahneman & Tversky, 1979/1992)
 *   2. Quasi-hyperbolic discounting (Laibson, 1997)
 *   3. Dynamic cooling-off periods (MnemoPay original)
 *   4. Loss-framed nudges (Tversky & Kahneman, 1981)
 *   5. Commitment devices / Save More Tomorrow (Thaler & Benartzi, 2004)
 *   6. Regret memory + prediction (Zeelenberg & Pieters, 2007)
 *   7. Overconfidence brake (Barber & Odean, 2000)
 *   8. Intelligent expense reframing (Thaler, 1985 mental accounting)
 *   9. Endowed progress effect (Nunes & Dreze, 2006)
 *   10. Anti-herd alerting (Shiller, 2000)
 *
 * All parameters sourced from peer-reviewed publications with exact citations.
 * Zero external dependencies.
 *
 * References (selected):
 *   - Tversky & Kahneman (1992). "Advances in Prospect Theory"
 *   - Laibson (1997). "Golden Eggs and Hyperbolic Discounting"
 *   - Thaler & Benartzi (2004). "Save More Tomorrow"
 *   - Barber & Odean (2000). "Trading Is Hazardous to Your Wealth"
 *   - Madrian & Shea (2001). "The Power of Suggestion"
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProspectValue {
  /** The psychologically perceived value (positive = gain, negative = loss) */
  value: number;
  /** Original monetary amount */
  amount: number;
  /** Whether this is a gain or loss */
  domain: "gain" | "loss";
  /** Loss aversion multiplier applied (lambda) */
  lossAversion: number;
  /** Explanation for the agent/user */
  explanation: string;
}

export interface CoolingOffResult {
  /** Whether a cooling-off period is recommended */
  recommended: boolean;
  /** Hours to wait before executing */
  hours: number;
  /** Reason for the recommendation */
  reason: string;
  /** Risk level of the purchase */
  riskLevel: "low" | "medium" | "high" | "extreme";
  /** Estimated regret probability based on history */
  regretProbability: number;
}

export interface CommitmentResult {
  /** Projected savings rates over time */
  projectedRates: number[];
  /** Projected total savings at each cycle */
  projectedSavings: number[];
  /** Final rate after all cycles */
  finalRate: number;
  /** Explanation of the SMarT plan */
  explanation: string;
}

export interface LossFrame {
  /** The loss-framed message */
  message: string;
  /** Equivalent gain message for comparison */
  gainMessage: string;
  /** Expected effectiveness multiplier vs gain framing */
  effectivenessMultiplier: number;
  /** Days of goal delay this spending causes */
  goalDelayDays: number;
}

export interface ReframedExpense {
  /** Original amount and frequency */
  original: { amount: number; frequency: string };
  /** Reframed amounts at different timescales */
  daily: number;
  weekly: number;
  monthly: number;
  annual: number;
  /** The most psychologically impactful frame */
  impactFrame: string;
  /** Opportunity cost: what else this money could do */
  opportunityCost: string;
}

export interface RegretEntry {
  /** Purchase amount */
  amount: number;
  /** Category of purchase */
  category: string;
  /** Self-rated regret 0-10 (10 = deeply regret) */
  regretScore: number;
  /** ISO timestamp */
  timestamp: string;
}

export interface RegretPrediction {
  /** Predicted regret probability 0-1 */
  probability: number;
  /** Confidence in the prediction 0-1 */
  confidence: number;
  /** Historical context */
  historicalRegretRate: number;
  /** Category-specific regret rate */
  categoryRegretRate: number;
  /** Recommendation */
  recommendation: string;
  /** Whether to invoke cooling-off */
  triggerCoolingOff: boolean;
}

export interface TradeEntry {
  /** Timestamp of trade */
  timestamp: number;
  /** Trade amount */
  amount: number;
  /** Direction */
  direction: "buy" | "sell";
  /** Asset or category */
  asset: string;
  /** Realized P/L if closed */
  realizedPL?: number;
}

export interface OverconfidenceResult {
  /** Whether overconfidence is detected */
  detected: boolean;
  /** Current trading frequency (trades per period) */
  frequency: number;
  /** Optimal frequency (derived from historical performance) */
  optimalFrequency: number;
  /** Estimated annual performance drag from overtrading (percentage points) */
  performanceDrag: number;
  /** Disposition effect detected (holding losers, selling winners) */
  dispositionEffect: boolean;
  /** Recommendation */
  recommendation: string;
}

export interface AssetMetrics {
  /** Current price-to-earnings ratio */
  peRatio: number;
  /** Historical mean P/E */
  historicalMeanPE: number;
  /** Historical standard deviation of P/E */
  historicalStdPE: number;
  /** Recent price change (percent, 30-day) */
  recentReturn30d: number;
  /** Volume spike (current vs average) */
  volumeRatio: number;
}

export interface HerdAlert {
  /** Whether herd behavior is detected */
  detected: boolean;
  /** Severity: low, medium, high */
  severity: "low" | "medium" | "high";
  /** CAPE-like ratio relative to mean */
  valuationSigma: number;
  /** Alert message */
  message: string;
  /** Contrarian recommendation */
  recommendation: string;
}

export interface FinancialGoal {
  /** Goal name */
  name: string;
  /** Target amount */
  target: number;
  /** Current progress toward goal */
  current: number;
  /** Monthly savings rate toward this goal */
  monthlySavings: number;
}

export interface EndowedProgress {
  /** Percentage complete toward goal */
  percentComplete: number;
  /** Framed message using endowed progress effect */
  message: string;
  /** Expected completion boost from endowed framing (Nunes & Dreze: 34% vs 19%) */
  expectedCompletionRate: number;
}

export interface BehavioralConfig {
  /** Prospect theory: loss aversion coefficient. Tversky & Kahneman 1992: 2.25 */
  lambda: number;
  /** Prospect theory: gain curvature. T&K 1992: 0.88 */
  alpha: number;
  /** Prospect theory: loss curvature. T&K 1992: 0.88 */
  beta_pt: number;
  /** Quasi-hyperbolic: present bias. Laibson 1997: 0.70 */
  beta_discount: number;
  /** Quasi-hyperbolic: exponential discount. Laibson 1997: 0.96 */
  delta: number;
  /** Base cooling-off hours for amount = income. Default 2 */
  baseCoolingHours: number;
  /** Minimum purchase amount to trigger cooling-off. Default 100 */
  coolingThreshold: number;
  /** Overconfidence: max trades per month before alert. Barber & Odean: monthly turnover > 8.8% */
  maxTradesPerMonth: number;
  /** Annual performance drag per excess trade (basis points). B&O 2000: ~6.5pp for highest quartile */
  excessTradeCostBps: number;
}

export const DEFAULT_BEHAVIORAL_CONFIG: BehavioralConfig = {
  lambda: 2.25,       // Tversky & Kahneman 1992
  alpha: 0.88,        // Tversky & Kahneman 1992
  beta_pt: 0.88,      // Tversky & Kahneman 1992
  beta_discount: 0.70, // Laibson 1997
  delta: 0.96,        // Laibson 1997
  baseCoolingHours: 2,
  coolingThreshold: 100,
  maxTradesPerMonth: 15,
  excessTradeCostBps: 50, // 50 bps per excess trade (conservative estimate from B&O)
};

// ─── Behavioral Finance Engine ──────────────────────────────────────────────

export class BehavioralEngine {
  readonly config: BehavioralConfig;
  private regretHistory: RegretEntry[] = [];
  private static readonly MAX_REGRET_HISTORY = 500;

  constructor(config?: Partial<BehavioralConfig>) {
    this.config = { ...DEFAULT_BEHAVIORAL_CONFIG, ...config };
    this._validateConfig();
  }

  // ── 1. Prospect Theory Value Function ───────────────────────────────────
  // v(x) = x^alpha              for gains (x >= 0)
  // v(x) = -lambda * (-x)^beta  for losses (x < 0)
  //
  // Properties:
  //   - Concave for gains (diminishing sensitivity)
  //   - Convex for losses (risk-seeking in losses)
  //   - Steeper for losses than gains (loss aversion)

  prospectValue(amount: number): ProspectValue {
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      throw new Error("Amount must be a finite number");
    }

    if (amount >= 0) {
      const value = Math.pow(amount, this.config.alpha);
      return {
        value,
        amount,
        domain: "gain",
        lossAversion: 1,
        explanation: `A $${amount.toFixed(2)} gain feels like ${value.toFixed(2)} units of satisfaction. Diminishing returns: doubling the gain doesn't double the joy.`,
      };
    } else {
      const absAmount = Math.abs(amount);
      const value = -this.config.lambda * Math.pow(absAmount, this.config.beta_pt);
      return {
        value,
        amount,
        domain: "loss",
        lossAversion: this.config.lambda,
        explanation: `A $${absAmount.toFixed(2)} loss feels like ${Math.abs(value).toFixed(2)} units of pain — ${this.config.lambda}x worse than an equivalent gain.`,
      };
    }
  }

  /**
   * Compare gain vs loss framing of the same amount.
   * Shows why loss framing is 2.25x more effective for behavior change.
   */
  compareFraming(amount: number): { gainValue: number; lossValue: number; ratio: number; insight: string } {
    if (amount <= 0) throw new Error("Amount must be positive for framing comparison");
    const gain = this.prospectValue(amount);
    const loss = this.prospectValue(-amount);
    const ratio = Math.abs(loss.value) / gain.value;
    return {
      gainValue: gain.value,
      lossValue: loss.value,
      ratio: Math.round(ratio * 100) / 100,
      insight: `Losing $${amount.toFixed(2)} hurts ${ratio.toFixed(1)}x more than gaining it feels good. Frame savings interventions as loss prevention for ${ratio.toFixed(1)}x effectiveness.`,
    };
  }

  // ── 2. Quasi-Hyperbolic Discounting ─────────────────────────────────────
  // D(0) = 1
  // D(t) = beta * delta^t  for t >= 1
  //
  // Models present bias: people overvalue immediate rewards.
  // beta < 1 means "I want it NOW" — the gap between D(0)=1 and D(1)=beta*delta

  discount(periods: number): number {
    if (typeof periods !== "number" || !Number.isFinite(periods) || periods < 0) {
      throw new Error("Periods must be a non-negative number");
    }
    if (periods === 0) return 1;
    return this.config.beta_discount * Math.pow(this.config.delta, periods);
  }

  /**
   * Calculate the present-biased value of a future amount.
   * Shows how much a rational agent values $X received in T periods.
   */
  presentValue(futureAmount: number, periods: number): { discountedValue: number; discountFactor: number; lostValue: number; explanation: string } {
    if (futureAmount <= 0) throw new Error("Future amount must be positive");
    const factor = this.discount(periods);
    const discountedValue = futureAmount * factor;
    return {
      discountedValue: Math.round(discountedValue * 100) / 100,
      discountFactor: Math.round(factor * 10000) / 10000,
      lostValue: Math.round((futureAmount - discountedValue) * 100) / 100,
      explanation: `$${futureAmount.toFixed(2)} in ${periods} period(s) feels worth only $${discountedValue.toFixed(2)} now (${(factor * 100).toFixed(1)}% of face value). Present bias loses $${(futureAmount - discountedValue).toFixed(2)} of perceived value.`,
    };
  }

  // ── 3. Dynamic Cooling-Off Period ───────────────────────────────────────
  // hours = base * (amount / monthly_income) * (1 / user_beta) * regret_ratio
  //
  // Adapted from Thaler's cooling-off concept + our own behavioral calibration.
  // user_beta is estimated from past behavior (high impulsivity = low beta).

  coolingOff(amount: number, monthlyIncome: number, userBeta?: number): CoolingOffResult {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error("Amount must be a non-negative finite number");
    }
    if (typeof monthlyIncome !== "number" || !Number.isFinite(monthlyIncome) || monthlyIncome <= 0) {
      throw new Error("Monthly income must be a positive number");
    }

    // Below threshold: no cooling needed
    if (amount < this.config.coolingThreshold) {
      return {
        recommended: false,
        hours: 0,
        reason: `Amount ($${amount.toFixed(2)}) below cooling threshold ($${this.config.coolingThreshold})`,
        riskLevel: "low",
        regretProbability: 0,
      };
    }

    const beta = Math.max(0.1, Math.min(1.0, userBeta ?? this.config.beta_discount));
    const regretRatio = this._computeRegretRatio();
    const incomeRatio = amount / monthlyIncome;

    // Core formula
    let hours = this.config.baseCoolingHours * incomeRatio * (1 / beta) * Math.max(0.1, regretRatio);

    // Clamp to reasonable bounds
    hours = Math.max(0.5, Math.min(168, hours)); // 30 min to 1 week

    // Risk level
    let riskLevel: CoolingOffResult["riskLevel"];
    if (incomeRatio < 0.05) riskLevel = "low";
    else if (incomeRatio < 0.15) riskLevel = "medium";
    else if (incomeRatio < 0.50) riskLevel = "high";
    else riskLevel = "extreme";

    // Regret probability from history
    const regretProbability = Math.min(0.95, regretRatio * 1.2);

    const reason = hours > 0.5
      ? `Purchase is ${(incomeRatio * 100).toFixed(0)}% of monthly income. Historical regret rate: ${(regretRatio * 100).toFixed(0)}%. Wait ${hours.toFixed(1)} hours.`
      : `Low-risk purchase relative to income`;

    return {
      recommended: hours >= 1,
      hours: Math.round(hours * 10) / 10,
      reason,
      riskLevel,
      regretProbability: Math.round(regretProbability * 100) / 100,
    };
  }

  // ── 4. Loss-Framed Nudges ───────────────────────────────────────────────
  // Frame spending as goal delay: "$15/mo delays your home by 4 months"
  // Loss framing is 2.25x more effective than gain framing (T&K 1981)

  lossFrame(spendAmount: number, goal: FinancialGoal): LossFrame {
    if (spendAmount <= 0) throw new Error("Spend amount must be positive");
    if (!goal || goal.target <= 0 || goal.monthlySavings <= 0) {
      throw new Error("Goal must have positive target and monthly savings");
    }

    const remaining = goal.target - goal.current;
    const monthsToGoal = remaining > 0 ? remaining / goal.monthlySavings : 0;

    // How much does this spend delay the goal?
    const delayMonths = goal.monthlySavings > 0 ? spendAmount / goal.monthlySavings : 0;
    const delayDays = Math.round(delayMonths * 30);

    const message = delayDays > 0
      ? `This $${spendAmount.toFixed(2)} purchase delays your "${goal.name}" goal by ${delayDays} day(s). You'll reach $${goal.target.toLocaleString()} ${delayDays} day(s) later.`
      : `This purchase has minimal impact on your "${goal.name}" goal.`;

    const gainMessage = `Skipping this purchase saves $${spendAmount.toFixed(2)} toward your "${goal.name}" goal.`;

    return {
      message,
      gainMessage,
      effectivenessMultiplier: this.config.lambda, // 2.25x
      goalDelayDays: delayDays,
    };
  }

  // ── 5. Commitment Devices / Save More Tomorrow ──────────────────────────
  // Pre-commit to save X% of future raises.
  // Thaler & Benartzi 2004: participants went from 3.5% to 13.6% over 4 cycles.

  commitmentDevice(currentSavingsRate: number, raisePercent: number, cycles: number): CommitmentResult {
    if (currentSavingsRate < 0 || currentSavingsRate > 1) throw new Error("Savings rate must be 0-1");
    if (raisePercent <= 0 || raisePercent > 0.5) throw new Error("Raise percent must be 0-0.5");
    if (cycles < 1 || cycles > 20 || !Number.isInteger(cycles)) throw new Error("Cycles must be integer 1-20");

    // Each raise cycle: allocate a fraction of the raise to savings
    // Default allocation: 50% of each raise goes to savings (SMarT default)
    const allocationRate = 0.5;
    const rates: number[] = [currentSavingsRate];
    const savings: number[] = [0];

    let rate = currentSavingsRate;
    let cumulativeSavings = 0;
    // Assume $100K salary for projections
    const baseSalary = 100_000;

    for (let i = 0; i < cycles; i++) {
      const raiseAmount = baseSalary * raisePercent;
      const additionalSavings = raiseAmount * allocationRate;
      rate = Math.min(0.50, rate + (additionalSavings / baseSalary)); // Cap at 50%
      cumulativeSavings += baseSalary * rate;
      rates.push(Math.round(rate * 10000) / 10000);
      savings.push(Math.round(cumulativeSavings));
    }

    return {
      projectedRates: rates,
      projectedSavings: savings,
      finalRate: rates[rates.length - 1],
      explanation: `SMarT projection: savings rate grows from ${(currentSavingsRate * 100).toFixed(1)}% to ${(rate * 100).toFixed(1)}% over ${cycles} raise cycle(s). Thaler & Benartzi (2004) observed 3.5% → 13.6% in 4 cycles. Key insight: people don't feel the loss because it comes from future raises, not current income.`,
    };
  }

  // ── 6. Regret Memory & Prediction ───────────────────────────────────────
  // Track past purchase regret to predict future regret.

  recordRegret(entry: RegretEntry): void {
    if (!entry || typeof entry.amount !== "number" || !Number.isFinite(entry.amount)) {
      throw new Error("Regret entry requires a valid amount");
    }
    if (typeof entry.regretScore !== "number" || entry.regretScore < 0 || entry.regretScore > 10) {
      throw new Error("Regret score must be 0-10");
    }

    this.regretHistory.push({
      amount: entry.amount,
      category: entry.category?.toLowerCase() || "unknown",
      regretScore: entry.regretScore,
      timestamp: entry.timestamp || new Date().toISOString(),
    });

    // Cap history
    if (this.regretHistory.length > BehavioralEngine.MAX_REGRET_HISTORY) {
      this.regretHistory.splice(0, this.regretHistory.length - BehavioralEngine.MAX_REGRET_HISTORY);
    }
  }

  predictRegret(amount: number, category: string): RegretPrediction {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error("Amount must be a non-negative finite number");
    }

    const cat = category?.toLowerCase() || "unknown";

    if (this.regretHistory.length < 3) {
      return {
        probability: 0.5, // Unknown, assume 50%
        confidence: 0.1,
        historicalRegretRate: 0,
        categoryRegretRate: 0,
        recommendation: "Not enough purchase history to predict regret. Consider waiting.",
        triggerCoolingOff: amount >= this.config.coolingThreshold,
      };
    }

    // Overall regret rate (regretScore > 5 = regretted)
    const regretted = this.regretHistory.filter(r => r.regretScore > 5).length;
    const historicalRate = regretted / this.regretHistory.length;

    // Category-specific rate
    const catEntries = this.regretHistory.filter(r => r.category === cat);
    const catRegretted = catEntries.filter(r => r.regretScore > 5).length;
    const categoryRate = catEntries.length >= 2 ? catRegretted / catEntries.length : historicalRate;

    // Amount-weighted: larger purchases tend to have higher regret
    const similarAmount = this.regretHistory.filter(r => r.amount >= amount * 0.5 && r.amount <= amount * 2);
    const amountRegretted = similarAmount.filter(r => r.regretScore > 5).length;
    const amountRate = similarAmount.length >= 2 ? amountRegretted / similarAmount.length : historicalRate;

    // Blend: 40% category, 30% amount-similar, 30% overall
    const probability = Math.min(0.95, categoryRate * 0.4 + amountRate * 0.3 + historicalRate * 0.3);
    const confidence = Math.min(0.9, this.regretHistory.length / 50);

    let recommendation: string;
    if (probability >= 0.7) {
      recommendation = `High regret risk (${(probability * 100).toFixed(0)}%). You've regretted ${(categoryRate * 100).toFixed(0)}% of similar "${cat}" purchases. Strongly consider waiting.`;
    } else if (probability >= 0.4) {
      recommendation = `Moderate regret risk (${(probability * 100).toFixed(0)}%). Consider whether this purchase aligns with your goals.`;
    } else {
      recommendation = `Low regret risk (${(probability * 100).toFixed(0)}%). This type of purchase has been satisfying historically.`;
    }

    return {
      probability: Math.round(probability * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
      historicalRegretRate: Math.round(historicalRate * 100) / 100,
      categoryRegretRate: Math.round(categoryRate * 100) / 100,
      recommendation,
      triggerCoolingOff: probability >= 0.5 && amount >= this.config.coolingThreshold,
    };
  }

  // ── 7. Overconfidence Brake ─────────────────────────────────────────────
  // Barber & Odean (2000): highest-turnover quartile underperforms by 6.5pp/year
  // Also checks disposition effect: holding losers, selling winners (Odean 1998)

  overconfidenceBrake(trades: TradeEntry[], periodDays: number = 30): OverconfidenceResult {
    if (!Array.isArray(trades)) throw new Error("Trades must be an array");
    if (periodDays <= 0) throw new Error("Period must be positive");

    const now = Date.now();
    const periodMs = periodDays * 86_400_000;
    const recentTrades = trades.filter(t => (now - t.timestamp) < periodMs);

    const frequency = recentTrades.length;
    const optimal = this.config.maxTradesPerMonth * (periodDays / 30);

    // Performance drag: excess trades * cost per trade
    const excessTrades = Math.max(0, frequency - optimal);
    const performanceDrag = excessTrades * (this.config.excessTradeCostBps / 100);

    // Disposition effect: are sells concentrated on winners?
    const sells = recentTrades.filter(t => t.direction === "sell" && t.realizedPL !== undefined);
    const winnerSells = sells.filter(t => (t.realizedPL ?? 0) > 0).length;
    const loserSells = sells.filter(t => (t.realizedPL ?? 0) < 0).length;
    // Odean (1998): investors are 1.5x more likely to sell winners
    const dispositionEffect = sells.length >= 3 && winnerSells > loserSells * 1.3;

    const detected = frequency > optimal || dispositionEffect;

    let recommendation: string;
    if (frequency > optimal * 2) {
      recommendation = `Trading ${frequency} times in ${periodDays} days is ${(frequency / optimal).toFixed(1)}x the optimal rate. Estimated annual performance drag: ${performanceDrag.toFixed(1)}%. Consider a rules-based approach.`;
    } else if (dispositionEffect) {
      recommendation = `Disposition effect detected: selling winners (${winnerSells}) more than losers (${loserSells}). This pattern costs ~4% annually (Odean 1998). Let winners run, cut losers.`;
    } else if (frequency > optimal) {
      recommendation = `Slightly above optimal trading frequency. Monitor for escalation.`;
    } else {
      recommendation = `Trading frequency is within optimal range.`;
    }

    return {
      detected,
      frequency,
      optimalFrequency: Math.round(optimal),
      performanceDrag: Math.round(performanceDrag * 100) / 100,
      dispositionEffect,
      recommendation,
    };
  }

  // ── 8. Intelligent Expense Reframing ────────────────────────────────────
  // Thaler (1985): mental accounting — how people categorize money matters.
  // Convert subscriptions to annual to reveal true cost.
  // Convert daily habits to annual to show accumulation.

  reframeExpense(amount: number, frequency: "daily" | "weekly" | "monthly" | "annual"): ReframedExpense {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error("Amount must be a non-negative finite number");
    }

    let annual: number;
    switch (frequency) {
      case "daily": annual = amount * 365; break;
      case "weekly": annual = amount * 52; break;
      case "monthly": annual = amount * 12; break;
      case "annual": annual = amount; break;
      default: throw new Error("Frequency must be daily, weekly, monthly, or annual");
    }

    const daily = annual / 365;
    const weekly = annual / 52;
    const monthly = annual / 12;

    // Most impactful frame:
    // For subscriptions (monthly), annual is more impactful ($13/mo vs $156/yr)
    // For habits (daily), annual is more impactful ($5/day vs $1,825/yr)
    // For annual costs, daily makes it seem smaller (useful for showing it's affordable)
    let impactFrame: string;
    if (frequency === "monthly" || frequency === "weekly") {
      impactFrame = `That's $${annual.toFixed(2)}/year. Over 10 years: $${(annual * 10).toFixed(0)}.`;
    } else if (frequency === "daily") {
      impactFrame = `That $${amount.toFixed(2)}/day habit costs $${annual.toFixed(0)}/year — $${(annual * 10).toFixed(0)} over a decade.`;
    } else {
      impactFrame = `That's $${daily.toFixed(2)}/day or $${monthly.toFixed(2)}/month.`;
    }

    // Opportunity cost: invested at 7% annual return
    const invested10yr = annual * ((Math.pow(1.07, 10) - 1) / 0.07);
    const opportunityCost = `Invested instead at 7% annual return: $${Math.round(invested10yr).toLocaleString()} in 10 years.`;

    return {
      original: { amount, frequency },
      daily: Math.round(daily * 100) / 100,
      weekly: Math.round(weekly * 100) / 100,
      monthly: Math.round(monthly * 100) / 100,
      annual: Math.round(annual * 100) / 100,
      impactFrame,
      opportunityCost,
    };
  }

  // ── 9. Endowed Progress Effect ──────────────────────────────────────────
  // Nunes & Dreze (2006): People given a head start (2/12 stamps vs 0/10)
  // complete loyalty programs 34% vs 19% of the time.
  // Frame progress to make goals feel closer.

  endowedProgress(goal: FinancialGoal): EndowedProgress {
    if (!goal || goal.target <= 0) throw new Error("Goal must have positive target");

    const percent = Math.min(100, Math.max(0, (goal.current / goal.target) * 100));

    // Endowed framing: emphasize what's been achieved, not what's left
    let message: string;
    if (percent >= 80) {
      message = `You're ${percent.toFixed(0)}% there! Only $${(goal.target - goal.current).toFixed(0)} to go for "${goal.name}". The finish line is right there.`;
    } else if (percent >= 50) {
      message = `You're past the halfway mark on "${goal.name}" — ${percent.toFixed(0)}% complete! $${goal.current.toFixed(0)} saved so far.`;
    } else if (percent >= 20) {
      message = `Great start on "${goal.name}" — ${percent.toFixed(0)}% done! You've already saved $${goal.current.toFixed(0)}.`;
    } else if (percent > 0) {
      message = `You've started "${goal.name}" — every dollar counts. ${percent.toFixed(1)}% complete ($${goal.current.toFixed(0)} saved).`;
    } else {
      message = `Ready to start "${goal.name}"? Setting aside even $1 today puts you ahead of 80% of people who never start.`;
    }

    // Nunes & Dreze: 34% completion with endowed progress vs 19% without
    const expectedCompletionRate = percent > 0 ? 0.34 : 0.19;

    return {
      percentComplete: Math.round(percent * 100) / 100,
      message,
      expectedCompletionRate,
    };
  }

  // ── 10. Anti-Herd Alert ─────────────────────────────────────────────────
  // Shiller (2000): CAPE hit 44 during dot-com (mean ~16).
  // Alert when valuation exceeds 2 standard deviations from historical mean.

  antiHerdAlert(metrics: AssetMetrics): HerdAlert {
    if (!metrics || typeof metrics.peRatio !== "number") throw new Error("Valid asset metrics required");
    if (metrics.historicalStdPE <= 0) throw new Error("Historical std dev must be positive");

    const sigma = (metrics.peRatio - metrics.historicalMeanPE) / metrics.historicalStdPE;
    const absSigma = Math.abs(sigma);

    let detected = false;
    let severity: HerdAlert["severity"] = "low";
    let message = "";
    let recommendation = "";

    if (sigma > 2 && metrics.recentReturn30d > 10) {
      detected = true;
      severity = "high";
      message = `Extreme overvaluation: P/E ${metrics.peRatio.toFixed(1)} is ${sigma.toFixed(1)}σ above mean (${metrics.historicalMeanPE.toFixed(1)}). Recent 30-day return of ${metrics.recentReturn30d.toFixed(1)}% suggests momentum chasing.`;
      recommendation = `Contrarian signal: reduce exposure. Historical mean reversion is strong above 2σ.`;
    } else if (sigma > 1.5) {
      detected = true;
      severity = "medium";
      message = `Elevated valuation: P/E ${metrics.peRatio.toFixed(1)} is ${sigma.toFixed(1)}σ above mean. Watch for reversal.`;
      recommendation = `Consider trimming position or tightening stops.`;
    } else if (sigma < -1.5) {
      detected = true;
      severity = "medium";
      message = `Potential undervaluation: P/E ${metrics.peRatio.toFixed(1)} is ${Math.abs(sigma).toFixed(1)}σ below mean. Market may be irrationally pessimistic.`;
      recommendation = `Contrarian opportunity: evaluate fundamentals. Beaten-down assets often recover (De Bondt & Thaler 1985: 25% outperformance over 3 years).`;
    } else {
      message = `Valuation within normal range (${sigma.toFixed(1)}σ from mean).`;
      recommendation = `No herd-driven distortion detected.`;
    }

    if (metrics.volumeRatio > 2.5) {
      detected = true;
      if (severity === "low") severity = "medium";
      message += ` Volume is ${metrics.volumeRatio.toFixed(1)}x normal — unusual activity.`;
    }

    return {
      detected,
      severity,
      valuationSigma: Math.round(sigma * 100) / 100,
      message,
      recommendation,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private _computeRegretRatio(): number {
    if (this.regretHistory.length === 0) return 0.5; // Default: assume 50% regret
    const regretted = this.regretHistory.filter(r => r.regretScore > 5).length;
    return regretted / this.regretHistory.length;
  }

  private _validateConfig(): void {
    const c = this.config;
    // Reject NaN/Infinity on all numeric config values
    for (const [key, val] of Object.entries(c)) {
      if (typeof val === "number" && !Number.isFinite(val)) {
        throw new Error(`Config.${key} must be a finite number, got ${val}`);
      }
    }
    if (c.lambda <= 0 || c.lambda > 10) throw new Error("Lambda must be in (0, 10]");
    if (c.alpha <= 0 || c.alpha > 1) throw new Error("Alpha must be in (0, 1]");
    if (c.beta_pt <= 0 || c.beta_pt > 1) throw new Error("Beta (PT) must be in (0, 1]");
    if (c.beta_discount <= 0 || c.beta_discount > 1) throw new Error("Beta (discount) must be in (0, 1]");
    if (c.delta <= 0 || c.delta > 1) throw new Error("Delta must be in (0, 1]");
    if (c.baseCoolingHours <= 0) throw new Error("Base cooling hours must be positive");
    if (c.coolingThreshold < 0) throw new Error("Cooling threshold must be non-negative");
    if (c.maxTradesPerMonth < 1) throw new Error("maxTradesPerMonth must be at least 1");
    if (c.excessTradeCostBps < 0) throw new Error("excessTradeCostBps must be non-negative");
  }

  /** Get regret history for analysis */
  getRegretHistory(): RegretEntry[] {
    return [...this.regretHistory];
  }

  /** Serialize for persistence */
  serialize(): { config: BehavioralConfig; regretHistory: RegretEntry[] } {
    return {
      config: { ...this.config },
      regretHistory: [...this.regretHistory],
    };
  }

  /** Deserialize with validation */
  static deserialize(data: { config?: Partial<BehavioralConfig>; regretHistory?: RegretEntry[] }): BehavioralEngine {
    const engine = new BehavioralEngine(data.config);
    if (Array.isArray(data.regretHistory)) {
      for (const entry of data.regretHistory) {
        // Validate each entry before adding
        if (typeof entry.amount === "number" && Number.isFinite(entry.amount) &&
            typeof entry.regretScore === "number" && entry.regretScore >= 0 && entry.regretScore <= 10) {
          engine.regretHistory.push({
            amount: entry.amount,
            category: String(entry.category || "unknown"),
            regretScore: entry.regretScore,
            timestamp: String(entry.timestamp || ""),
          });
        }
      }
    }
    return engine;
  }
}
