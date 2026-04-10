/**
 * Buyer Profile — saved shipping + payment info for autonomous checkout.
 *
 * The profile is loaded from env vars or passed directly. Card details
 * are NEVER stored — only Stripe customer/PM IDs or tokenized references.
 */

export interface BuyerProfile {
  /** Full name on shipping/billing */
  fullName: string;
  /** Email for order confirmations */
  email: string;
  /** Phone number (some checkouts require it) */
  phone?: string;

  /** Shipping address */
  shipping: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    country: string; // ISO 2-letter (US, NG, GB, etc.)
  };

  /** Billing address (defaults to shipping if not set) */
  billing?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };

  /** Payment — tokenized card reference, NEVER raw card numbers */
  payment: {
    /** "stripe" | "paystack" | "card_token" */
    method: string;
    /** Stripe customer ID (cus_...) */
    customerId?: string;
    /** Stripe payment method ID (pm_...) */
    paymentMethodId?: string;
    /** Last 4 digits for verification prompts */
    last4?: string;
    /** Card brand for selector matching */
    brand?: string;
  };
}

/**
 * Load buyer profile from environment variables.
 * All MNEMOPAY_BUYER_* prefixed.
 */
export function loadProfileFromEnv(): BuyerProfile | null {
  const name = process.env.MNEMOPAY_BUYER_NAME;
  const email = process.env.MNEMOPAY_BUYER_EMAIL;
  const line1 = process.env.MNEMOPAY_BUYER_ADDRESS_LINE1;
  const city = process.env.MNEMOPAY_BUYER_ADDRESS_CITY;
  const state = process.env.MNEMOPAY_BUYER_ADDRESS_STATE;
  const zip = process.env.MNEMOPAY_BUYER_ADDRESS_ZIP;
  const country = process.env.MNEMOPAY_BUYER_ADDRESS_COUNTRY;

  if (!name || !email || !line1 || !city || !state || !zip || !country) {
    return null;
  }

  return {
    fullName: name,
    email,
    phone: process.env.MNEMOPAY_BUYER_PHONE,
    shipping: { line1, line2: process.env.MNEMOPAY_BUYER_ADDRESS_LINE2, city, state, zip, country },
    payment: {
      method: process.env.MNEMOPAY_BUYER_PAYMENT_METHOD || "stripe",
      customerId: process.env.MNEMOPAY_BUYER_STRIPE_CUSTOMER_ID,
      paymentMethodId: process.env.MNEMOPAY_BUYER_STRIPE_PM_ID,
      last4: process.env.MNEMOPAY_BUYER_CARD_LAST4,
      brand: process.env.MNEMOPAY_BUYER_CARD_BRAND,
    },
  };
}

/**
 * Validate a buyer profile has minimum required fields for checkout.
 */
export function validateProfile(profile: BuyerProfile): string[] {
  const errors: string[] = [];
  if (!profile.fullName || profile.fullName.trim().length < 2) errors.push("fullName required (min 2 chars)");
  if (!profile.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) errors.push("valid email required");
  if (!profile.shipping) errors.push("shipping address required");
  if (profile.shipping) {
    if (!profile.shipping.line1) errors.push("shipping.line1 required");
    if (!profile.shipping.city) errors.push("shipping.city required");
    if (!profile.shipping.state) errors.push("shipping.state required");
    if (!profile.shipping.zip) errors.push("shipping.zip required");
    if (!profile.shipping.country || !/^[A-Z]{2}$/.test(profile.shipping.country)) {
      errors.push("shipping.country must be uppercase 2-letter ISO code (e.g., US, NG, GB)");
    }
  }
  if (profile.payment && !profile.payment.method) {
    errors.push("payment.method required when payment is specified");
  }
  return errors;
}
