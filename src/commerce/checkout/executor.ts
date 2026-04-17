/**
 * Checkout Executor — orchestrates the full purchase flow
 *
 * Coordinates between:
 *   - CommerceProvider (finds the product)
 *   - CheckoutStrategy (completes the purchase on the merchant site)
 *   - BuyerProfile (shipping + payment info)
 *   - MnemoPay (escrow, approval, settlement)
 *
 * Usage:
 *   const executor = new CheckoutExecutor({ profile, screenshotDir });
 *   const result = await executor.checkout(productUrl);
 *
 * The executor does NOT require a live browser — it creates one on demand
 * via dynamic import of playwright. If playwright is not installed,
 * executePurchase() returns checkout_required with the URL.
 */

import type { BuyerProfile } from "./profile.js";
import { validateProfile } from "./profile.js";
import { ShopifyCheckoutStrategy } from "./strategies/shopify.js";
import { GenericCheckoutStrategy } from "./strategies/generic.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CheckoutResult {
  success: boolean;
  orderId?: string;
  confirmationUrl?: string;
  totalCharged?: number;
  failureReason?: string;
  steps: string[];
  elapsedMs: number;
  screenshots?: string[];
}

export interface CheckoutContext {
  /** Playwright page instance */
  page: any;
  /** Product URL to purchase */
  productUrl: string;
  /** Log a step (stored in result) */
  log: (msg: string) => void;
  /** Take a screenshot (if screenshotDir configured) */
  screenshot: (name: string) => Promise<void>;
}

export interface CheckoutStrategy {
  readonly name: string;
  /** Return true if this strategy can handle the given URL */
  canHandle(url: string): boolean;
  /** Execute the full checkout flow */
  execute(ctx: CheckoutContext, profile: BuyerProfile): Promise<CheckoutResult>;
}

export interface CheckoutExecutorConfig {
  /** Buyer profile with shipping + payment info */
  profile: BuyerProfile;
  /** Directory to save screenshots (optional, for debugging) */
  screenshotDir?: string;
  /** Custom strategies (prepended to default list) */
  strategies?: CheckoutStrategy[];
  /** Navigation timeout in ms (default: 30000) */
  timeout?: number;
  /** Headless mode (default: true) */
  headless?: boolean;
  /** User-agent override */
  userAgent?: string;
}

// ── Executor ───────────────────────────────────────────────────────────────

export class CheckoutExecutor {
  private profile: BuyerProfile;
  private screenshotDir?: string;
  private strategies: CheckoutStrategy[];
  private timeout: number;
  private headless: boolean;
  private userAgent: string;

  constructor(config: CheckoutExecutorConfig) {
    // Validate profile
    const errors = validateProfile(config.profile);
    if (errors.length > 0) {
      throw new Error(`Invalid buyer profile: ${errors.join(", ")}`);
    }

    this.profile = config.profile;
    this.screenshotDir = config.screenshotDir;
    this.timeout = config.timeout ?? 30_000;
    this.headless = config.headless ?? true;
    this.userAgent = config.userAgent ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    // Strategy chain: custom strategies first, then Shopify, then generic fallback
    this.strategies = [
      ...(config.strategies ?? []),
      new ShopifyCheckoutStrategy(),
      new GenericCheckoutStrategy(),
    ];
  }

  /**
   * Execute a full checkout for the given product URL.
   *
   * Flow:
   *   1. Launch browser
   *   2. Select best checkout strategy for the URL
   *   3. Execute checkout steps
   *   4. Return result with order ID, screenshots, timing
   */
  async checkout(productUrl: string): Promise<CheckoutResult> {
    // Input validation
    if (!productUrl || typeof productUrl !== "string") {
      return { success: false, failureReason: "Invalid product URL", steps: [], elapsedMs: 0 };
    }

    // URL sanitization — only allow http/https
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(productUrl);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return { success: false, failureReason: "Only HTTP/HTTPS URLs are supported", steps: [], elapsedMs: 0 };
      }
    } catch {
      return { success: false, failureReason: "Malformed URL", steps: [], elapsedMs: 0 };
    }

    // Find matching strategy
    const strategy = this.strategies.find(s => s.canHandle(productUrl));
    if (!strategy) {
      return { success: false, failureReason: "No checkout strategy can handle this URL", steps: [], elapsedMs: 0 };
    }

    // Dynamic import — playwright is optional
    let playwright: any;
    try {
      playwright = await import("playwright");
    } catch {
      return { success: false, failureReason: "Playwright not installed. Run: npm install playwright", steps: [], elapsedMs: 0 };
    }

    const browser = await playwright.chromium.launch({
      headless: this.headless,
    });

    const screenshots: string[] = [];
    const logs: string[] = [];

    try {
      const context = await browser.newContext({
        userAgent: this.userAgent,
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
      });

      // Block unnecessary resources for speed
      await context.route("**/*.{png,jpg,jpeg,gif,svg,mp4,webm,woff,woff2,ttf}", (route: any) => route.abort());

      const page = await context.newPage();
      page.setDefaultTimeout(this.timeout);

      const ctx: CheckoutContext = {
        page,
        productUrl,
        log: (msg: string) => {
          logs.push(`[${strategy.name}] ${msg}`);
        },
        screenshot: async (name: string) => {
          if (this.screenshotDir) {
            const safeName = name.replace(/[\/\\\.]+/g, "_");
            const path = `${this.screenshotDir}/${safeName}.png`;
            await page.screenshot({ path, fullPage: false }).catch(() => {});
            screenshots.push(path);
          }
        },
      };

      // Global timeout: 3x the page timeout to cover entire checkout flow
      const globalTimeout = this.timeout * 3;
      const result = await Promise.race([
        strategy.execute(ctx, this.profile),
        new Promise<CheckoutResult>((_, reject) =>
          setTimeout(() => reject(new Error(`Checkout timed out after ${globalTimeout}ms`)), globalTimeout)
        ),
      ]);
      result.screenshots = screenshots;

      // Log summary
      if (result.success) {
        logs.push(`Checkout completed: order ${result.orderId} in ${result.elapsedMs}ms`);
      } else {
        logs.push(`Checkout failed: ${result.failureReason}`);
      }

      return result;
    } finally {
      await browser.close();
    }
  }

  /**
   * Test connectivity to a merchant site without purchasing.
   * Returns the detected strategy name and page title.
   */
  async probe(url: string): Promise<{ strategy: string; title: string; canCheckout: boolean }> {
    let playwright: any;
    try {
      playwright = await import("playwright");
    } catch {
      return { strategy: "none", title: "", canCheckout: false };
    }

    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      const title = await page.title();
      const strategy = this.strategies.find(s => s.canHandle(url));
      return {
        strategy: strategy?.name ?? "none",
        title,
        canCheckout: !!strategy,
      };
    } finally {
      await browser.close();
    }
  }
}
