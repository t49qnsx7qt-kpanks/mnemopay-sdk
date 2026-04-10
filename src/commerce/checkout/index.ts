/**
 * Checkout module — autonomous purchase completion
 */

export { CheckoutExecutor } from "./executor.js";
export type { CheckoutResult, CheckoutContext, CheckoutStrategy, CheckoutExecutorConfig } from "./executor.js";
export { ShopifyCheckoutStrategy } from "./strategies/shopify.js";
export { GenericCheckoutStrategy } from "./strategies/generic.js";
export type { BuyerProfile } from "./profile.js";
export { loadProfileFromEnv, validateProfile } from "./profile.js";
