/**
 * EU AI Act Article 12 export bundle. Folded from
 * praetor/packages/core/src/article12.ts (commit 06a5aec) on 2026-05-06.
 *
 * Article 12 requires high-risk AI systems to keep automatically-generated logs
 * for ≥ 6 months. The bundle this writer emits is regulator-handable:
 *   - mission.json   — mission metadata (charter, status, digest, retention)
 *   - events.json    — every audit event in chain order
 *   - events.csv     — same data flattened for spreadsheet review
 *   - chain.txt      — Merkle digest sequence (one hash per line)
 *   - manifest.json  — checksums of every file + retention policy + bundle version
 *
 * Caller is responsible for actually writing these to disk or a zip — this module
 * just produces the file blobs deterministically so it can be tested in-memory.
 */

import { createHash } from "node:crypto";
import type { AuditEvent, MerkleAudit } from "./audit.js";
import type { MissionResult } from "./runtime.js";
import type { Charter } from "./charter.js";

export interface Article12BundleInput {
  charter: Charter;
  result: MissionResult;
  audit: MerkleAudit;
  /** Calendar months of retention. Defaults to 6 (Article 12 minimum). */
  retentionMonths?: number;
  /** Operator's own identifier — typically the company that deployed the agent. */
  operatorId?: string;
}

export interface Article12BundleFile {
  path: string;
  body: string;
  sha256: string;
}

export interface Article12Bundle {
  files: Article12BundleFile[];
  bundleSha256: string;
}

const BUNDLE_VERSION = "mnemopay-article12/1";

export function buildArticle12Bundle(input: Article12BundleInput): Article12Bundle {
  const retentionMonths = input.retentionMonths ?? 6;
  const operatorId = input.operatorId ?? "unknown";
  const events = input.audit.getEvents();
  const chain = input.audit.getChain();

  const mission = {
    bundleVersion: BUNDLE_VERSION,
    operatorId,
    charter: {
      name: input.charter.name,
      goal: input.charter.goal,
      budgetMaxUsd: input.charter.budget.maxUsd,
    },
    result: input.result,
    retention: {
      months: retentionMonths,
      startedAt: input.result.startedAt,
      retainUntil: addMonthsIso(input.result.startedAt, retentionMonths),
      legalBasis: "EU AI Act Article 12 — automatic logging requirement",
    },
    chainVerified: input.audit.verify(),
  };

  const missionJson = JSON.stringify(mission, null, 2);
  const eventsJson = JSON.stringify(events, null, 2);
  const eventsCsv = toCsv(events as AuditEvent[]);
  const chainTxt = chain.join("\n") + (chain.length ? "\n" : "");

  const files: Omit<Article12BundleFile, "sha256">[] = [
    { path: "mission.json", body: missionJson },
    { path: "events.json", body: eventsJson },
    { path: "events.csv", body: eventsCsv },
    { path: "chain.txt", body: chainTxt },
  ];

  const withChecksums: Article12BundleFile[] = files.map((f) => ({
    ...f,
    sha256: sha256(f.body),
  }));

  const manifest = {
    bundleVersion: BUNDLE_VERSION,
    generatedAt: new Date().toISOString(),
    retentionMonths,
    files: withChecksums.map(({ path, sha256: hash }) => ({ path, sha256: hash })),
    auditDigest: input.result.auditDigest,
  };
  const manifestBody = JSON.stringify(manifest, null, 2);
  withChecksums.push({ path: "manifest.json", body: manifestBody, sha256: sha256(manifestBody) });

  // Bundle digest = sha256 over the concatenation of (path|sha256) lines, deterministic order.
  const bundleSha = sha256(
    withChecksums
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => `${f.path}|${f.sha256}`)
      .join("\n")
  );

  return { files: withChecksums, bundleSha256: bundleSha };
}

function toCsv(events: AuditEvent[]): string {
  const header = "ts,type,data_json";
  const rows = events.map((e) => `${escape(e.ts)},${escape(e.type)},${escape(JSON.stringify(e.data))}`);
  return [header, ...rows].join("\n") + "\n";
}

function escape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function addMonthsIso(iso: string, months: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}
