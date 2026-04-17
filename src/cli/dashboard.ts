#!/usr/bin/env node
/**
 * npx @mnemopay/sdk dashboard
 *
 * Opens the MnemoPay dashboard in your default browser.
 * Manage agents, view transactions, update billing, and monitor fraud.
 */

import { execFile } from "child_process";
import os from "os";

const DASHBOARD_URL = "https://getbizsuite.com/mnemopay/dashboard.html";
const PRICING_URL = "https://getbizsuite.com/mnemopay/#pricing";
const PRO_URL = "https://buy.stripe.com/00w9AMe27c9pgT6gxtbo409";
const ENTERPRISE_URL = "https://buy.stripe.com/9B63co8HNehxcCQ5SPbo40a";

function openBrowser(url: string) {
  const platform = os.platform();

  if (platform === "win32") execFile("cmd", ["/c", "start", "", url], onErr);
  else if (platform === "darwin") execFile("open", [url], onErr);
  else execFile("xdg-open", [url], onErr);

  function onErr(err: Error | null) {
    if (err) console.log(`\n  Open this URL in your browser:\n  ${url}\n`);
  }
}

function main() {
  const arg = process.argv[2];

  console.log("\n  MnemoPay v0.8.0\n");

  if (arg === "subscribe" || arg === "pro") {
    console.log("  Opening Stripe Checkout for MnemoPay Pro ($49/mo)...\n");
    openBrowser(PRO_URL);
    console.log("  Pro includes:");
    console.log("    - File + SQLite persistence");
    console.log("    - Transaction analytics dashboard");
    console.log("    - Webhook notifications");
    console.log("    - Geo trust profiles");
    console.log("    - Priority email support");
    console.log("    - 1.5% platform fee (vs 1.9% on free)\n");
    return;
  }

  if (arg === "enterprise") {
    console.log("  Opening Stripe Checkout for MnemoPay Enterprise ($299/mo)...\n");
    openBrowser(ENTERPRISE_URL);
    console.log("  Enterprise includes:");
    console.log("    - ML fraud detection (Isolation Forest)");
    console.log("    - Custom payment rail integration");
    console.log("    - SLA guarantee");
    console.log("    - Dedicated support + SSO");
    console.log("    - 1.0% platform fee\n");
    return;
  }

  if (arg === "pricing") {
    console.log("  Opening pricing page...\n");
    openBrowser(PRICING_URL);
    return;
  }

  // Default: open dashboard
  console.log("  Opening dashboard...\n");
  openBrowser(DASHBOARD_URL);

  console.log("  Commands:");
  console.log("    npx @mnemopay/sdk dashboard          Open dashboard");
  console.log("    npx @mnemopay/sdk dashboard subscribe Subscribe to Pro ($49/mo)");
  console.log("    npx @mnemopay/sdk dashboard enterprise Subscribe to Enterprise ($299/mo)");
  console.log("    npx @mnemopay/sdk dashboard pricing   View pricing\n");

  console.log("  Current Plan: Starter (Free)");
  console.log("  Platform Fee: 1.9% per settled transaction");
  console.log("  Upgrade to Pro for 1.5% fee + persistence + analytics\n");
}

main();
