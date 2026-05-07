/**
 * @mnemopay/sdk — governance module barrel.
 *
 * The governance module provides FiscalGate (charter-driven budget enforcement)
 * and Article 12 (EU AI Act audit bundle export) primitives. Folded from
 * praetor/packages/{core,payments} on 2026-05-06.
 *
 * Usage:
 *   import { runMission, validateCharter, MerkleAudit, buildArticle12Bundle, MockPayments } from "@mnemopay/sdk";
 */

export { MerkleAudit } from "./audit.js";
export type { AuditEvent, AuditListener } from "./audit.js";

export { validateCharter } from "./charter.js";
export type { Charter, CharterBudget, CharterAgent, CharterStep, CharterRole } from "./charter.js";

export { runMission } from "./runtime.js";
export type { MissionResult, MissionContext } from "./runtime.js";

export { buildArticle12Bundle } from "./article12.js";
export type { Article12Bundle, Article12BundleFile, Article12BundleInput } from "./article12.js";

export { MockPayments } from "./payments.js";
export type { PaymentsAdapter } from "./payments.js";
