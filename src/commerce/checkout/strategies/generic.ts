/**
 * Generic E-Commerce Checkout Strategy
 *
 * Handles checkout on non-Shopify sites using common DOM patterns.
 * Works with WooCommerce, Magento, custom stores, and most e-commerce platforms.
 *
 * Strategy: progressive form detection — find visible input fields by common
 * names/labels/placeholders, fill them, then find the next action button.
 *
 * This is inherently less reliable than platform-specific strategies because
 * every store has different DOM structure. Expected success rate: 40-60%.
 */

import type { BuyerProfile } from "../profile.js";
import type { CheckoutResult, CheckoutStrategy, CheckoutContext } from "../executor.js";

export class GenericCheckoutStrategy implements CheckoutStrategy {
  readonly name = "generic";

  canHandle(_url: string): boolean {
    // Generic strategy is the fallback — handles anything
    return true;
  }

  async execute(ctx: CheckoutContext, profile: BuyerProfile): Promise<CheckoutResult> {
    const { page, log, screenshot } = ctx;
    const startTime = Date.now();
    const steps: string[] = [];

    try {
      // Step 1: Navigate
      log("Navigating to product page...");
      await page.goto(ctx.productUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      steps.push("navigated");
      await screenshot("01-product-page");

      // Step 2: Add to cart
      log("Adding to cart...");
      const added = await this.addToCart(page);
      if (!added) return this.fail("Could not find Add to Cart button", steps, startTime);
      steps.push("added_to_cart");
      await page.waitForTimeout(2000);
      await screenshot("02-cart");

      // Step 3: Go to checkout
      log("Going to checkout...");
      const atCheckout = await this.goToCheckout(page);
      if (!atCheckout) return this.fail("Could not reach checkout", steps, startTime);
      steps.push("at_checkout");
      await screenshot("03-checkout");

      // Step 4: Fill all visible form fields
      log("Filling checkout form...");
      const filled = await this.fillCheckoutForm(page, profile);
      steps.push(`filled_${filled}_fields`);
      await screenshot("04-form-filled");

      if (filled < 3) {
        return this.fail(`Only filled ${filled} fields — checkout form not recognized`, steps, startTime);
      }

      // Step 5: Find and click place order / submit
      log("Submitting order...");
      const submitted = await this.submitOrder(page);
      if (!submitted) return this.fail("Could not find submit/place order button", steps, startTime);
      steps.push("submitted");
      await page.waitForTimeout(5000);
      await screenshot("05-submitted");

      // Step 6: Check for confirmation
      const confirmation = await this.checkConfirmation(page);
      steps.push(confirmation.success ? "confirmed" : "unconfirmed");
      await screenshot("06-result");

      return {
        success: confirmation.success,
        orderId: confirmation.orderId,
        confirmationUrl: page.url(),
        totalCharged: confirmation.total,
        failureReason: confirmation.success ? undefined : "Could not confirm order completion",
        steps,
        elapsedMs: Date.now() - startTime,
      };
    } catch (err: any) {
      await screenshot("error-state");
      return this.fail(err.message, steps, startTime);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async addToCart(page: any): Promise<boolean> {
    const selectors = [
      'button:has-text("Add to Cart")',
      'button:has-text("Add to cart")',
      'button:has-text("Add to Bag")',
      'button:has-text("Buy Now")',
      'button:has-text("Buy now")',
      'input[type="submit"][value*="Add to Cart" i]',
      'input[type="submit"][value*="Buy" i]',
      '#add-to-cart',
      '.add-to-cart',
      '[data-action="add-to-cart"]',
      'button.single_add_to_cart_button', // WooCommerce
      '#product-addtocart-button', // Magento
    ];

    for (const sel of selectors) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.click();
          return true;
        }
      } catch { /* try next */ }
    }
    return false;
  }

  private async goToCheckout(page: any): Promise<boolean> {
    // Try checkout links/buttons
    const selectors = [
      'a:has-text("Checkout")',
      'a:has-text("Check out")',
      'a:has-text("Proceed to checkout")',
      'button:has-text("Checkout")',
      'button:has-text("Check out")',
      'button:has-text("Proceed to checkout")',
      'a[href*="/checkout"]',
      '.checkout-button',
      '.wc-proceed-to-checkout a', // WooCommerce
      '#top-cart-btn-checkout', // Magento
    ];

    for (const sel of selectors) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.click();
          await page.waitForTimeout(3000);
          return true;
        }
      } catch { /* try next */ }
    }

    // Try navigating to /checkout directly
    try {
      const base = page.url().split("/").slice(0, 3).join("/");
      await page.goto(`${base}/checkout`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      return true;
    } catch { /* continue */ }

    return false;
  }

  private async fillCheckoutForm(page: any, profile: BuyerProfile): Promise<number> {
    let filled = 0;
    const nameParts = profile.fullName.split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    // Field mapping: [possible selectors, value]
    const fields: [string[], string][] = [
      // Email
      [['input[name*="email" i]', 'input[type="email"]', '#email', '#billing_email'], profile.email],
      // First name
      [['input[name*="first" i][name*="name" i]', '#billing_first_name', 'input[placeholder*="First" i]'], firstName],
      // Last name
      [['input[name*="last" i][name*="name" i]', '#billing_last_name', 'input[placeholder*="Last" i]'], lastName],
      // Full name (if no first/last split)
      [['input[name="name"]', 'input[placeholder*="Full name" i]'], profile.fullName],
      // Phone
      [['input[type="tel"]', 'input[name*="phone" i]', '#billing_phone'], profile.phone || ""],
      // Address line 1
      [['input[name*="address" i][name*="1" i]', '#billing_address_1', 'input[placeholder*="Address" i]', 'input[name="street"]'], profile.shipping.line1],
      // Address line 2
      [['input[name*="address" i][name*="2" i]', '#billing_address_2'], profile.shipping.line2 || ""],
      // City
      [['input[name*="city" i]', '#billing_city', 'input[placeholder*="City" i]'], profile.shipping.city],
      // State/Province
      [['input[name*="state" i]', 'input[name*="province" i]', '#billing_state'], profile.shipping.state],
      // ZIP/Postal
      [['input[name*="zip" i]', 'input[name*="postal" i]', '#billing_postcode', 'input[placeholder*="ZIP" i]'], profile.shipping.zip],
    ];

    for (const [selectors, value] of fields) {
      if (!value) continue;
      for (const sel of selectors) {
        try {
          const field = await page.$(sel);
          if (field && await field.isVisible()) {
            await field.fill(value);
            filled++;
            break;
          }
        } catch { /* try next selector */ }
      }
    }

    // Country select
    try {
      const countrySelectors = ['select[name*="country" i]', '#billing_country'];
      for (const sel of countrySelectors) {
        const select = await page.$(sel);
        if (select && await select.isVisible()) {
          await select.selectOption(profile.shipping.country);
          filled++;
          break;
        }
      }
    } catch { /* continue */ }

    // State select (if it's a dropdown instead of text input)
    try {
      const stateSelectors = ['select[name*="state" i]', 'select[name*="province" i]', '#billing_state'];
      for (const sel of stateSelectors) {
        const select = await page.$(sel);
        if (select && await select.isVisible()) {
          const tag = await select.evaluate((e: any) => e.tagName.toLowerCase());
          if (tag === "select") {
            await select.selectOption(profile.shipping.state);
            filled++;
            break;
          }
        }
      }
    } catch { /* continue */ }

    return filled;
  }

  private async submitOrder(page: any): Promise<boolean> {
    const selectors = [
      'button:has-text("Place order")',
      'button:has-text("Place Order")',
      'button:has-text("Complete order")',
      'button:has-text("Submit order")',
      'button:has-text("Pay now")',
      'button:has-text("Confirm order")',
      'button:has-text("Buy now")',
      'input[type="submit"][value*="Place" i]',
      'input[type="submit"][value*="order" i]',
      '#place_order', // WooCommerce
      'button.checkout-submit', // Various
    ];

    for (const sel of selectors) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.click();
          return true;
        }
      } catch { /* try next */ }
    }
    return false;
  }

  private async checkConfirmation(page: any): Promise<{ success: boolean; orderId?: string; total?: number }> {
    const url = page.url().toLowerCase();
    const text = await page.textContent("body").catch(() => "");
    const lowerText = text.toLowerCase();

    // Check URL patterns
    const confirmUrls = ["thank", "confirmation", "success", "complete", "order-received"];
    const urlMatch = confirmUrls.some(p => url.includes(p));

    // Check page text patterns
    const confirmTexts = ["thank you", "order confirmed", "order received", "order number", "confirmation number", "your order"];
    const textMatch = confirmTexts.some(p => lowerText.includes(p));

    // Check for error patterns
    const errorTexts = ["error", "failed", "declined", "invalid", "please correct"];
    const hasError = errorTexts.some(p => lowerText.includes(p));

    if (hasError && !textMatch) {
      return { success: false };
    }

    let orderId: string | undefined;
    const orderMatch = text.match(/(?:order|confirmation)\s*(?:#|number|num|:)\s*(\w+)/i);
    if (orderMatch) orderId = orderMatch[1];

    return {
      success: urlMatch || textMatch,
      orderId,
    };
  }

  private fail(reason: string, steps: string[], startTime: number): CheckoutResult {
    return {
      success: false,
      failureReason: reason,
      steps,
      elapsedMs: Date.now() - startTime,
    };
  }
}
