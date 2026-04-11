/**
 * LongMemEval data types — mirrors the HuggingFace dataset schema.
 * Reference: https://github.com/xiaowu0162/LongMemEval
 */

/** A single conversation turn in a session. */
export interface Turn {
  role: "human" | "assistant";
  content: string;
  /** Present only in oracle data for evidence turns. */
  has_answer?: boolean;
}

/** One evaluation instance from the LongMemEval dataset. */
export interface LongMemEvalInstance {
  question_id: string;
  question_type:
    | "single-session-user"
    | "single-session-assistant"
    | "single-session-preference"
    | "multi-session"
    | "temporal-reasoning"
    | "knowledge-update";
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  /** Each element is an array of Turn objects — one per session. */
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
}

/** The JSONL output format expected by LongMemEval evaluation. */
export interface Hypothesis {
  question_id: string;
  hypothesis: string;
}

/** Config for the benchmark run. */
export interface BenchmarkConfig {
  /** Path to the LongMemEval JSON data file. */
  dataFile: string;
  /** Output JSONL path for hypotheses. */
  outputFile: string;
  /** Number of memories to recall per query (default: 20). */
  recallLimit: number;
  /** Maximum questions to evaluate (0 = all). */
  maxQuestions: number;
  /** MnemoPay recall strategy. */
  recallStrategy: "score" | "vector" | "hybrid";
  /** Whether to run consolidation after ingestion. */
  consolidate: boolean;
  /** Anthropic model for answer generation. */
  model: string;
  /** Max concurrent ingestion workers. */
  concurrency: number;
  /** Resume from this question index (0-based). */
  resumeFrom: number;
}
