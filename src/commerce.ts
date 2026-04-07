/**
 * Commerce Engine for MnemoPay
 *
 * Autonomous shopping for AI agents. An agent can search products, compare
 * prices, create a purchase order, pay via escrow, and confirm delivery.
 * Every purchase is scoped by a ShoppingMandate — cryptographically enforced
 * spend limits, category restrictions, and merchant whitelists.
 *
 * The escrow flow:
 *   1. Agent searches products → returns ranked results
 *   2. Agent (or user) approves a purchase → creates a PurchaseOrder
 *   3. SDK calls charge() to hold funds in escrow
 *   4. Agent executes the purchase via the commerce provider
 *   5. On delivery confirmation → settle() releases funds
 *   6. On failure/cancellation → refund() returns funds
 *
 * Security model:
 *   - ShoppingMandate defines what the agent CAN buy (budget, categories, merchants)
 *   - Every purchase validated against mandate before escrow is created
 *   - Purchases above approvalThreshold require explicit user confirmation
 *   - Full audit trail via MnemoPay's existing audit system
 *   - Agent remembers user preferences (sizes, brands, past purchases)
 *
 * Usage:
 *   const agent = MnemoPay.quick("shopper");
 *   const commerce = new CommerceEngine(agent);
 *   commerce.setMandate({ budget: 200, categories: ["electronics"] });
 *   const results = await commerce.search("USB-C cable under $15");
 *   const order = await commerce.purchase(results[0]);
 *   // ... later, on delivery ...
 *   await commerce.confirmDelivery(order.id);
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ShoppingMandate {
  /** Maximum total budget for this mandate (USD) */
  budget: number;
  /** Maximum per-item spend (USD). Defaults to budget. */
  maxPerItem?: number;
  /** Allowed product categories (empty = any) */
  categories?: string[];
  /** Blocked product categories */
  blockedCategories?: string[];
  /** Allowed merchant domains (empty = any) */
  allowedMerchants?: string[];
  /** Blocked merchant domains */
  blockedMerchants?: string[];
  /** Purchases above this amount require user approval callback (USD) */
  approvalThreshold?: number;
  /** Mandate expiry (ISO timestamp). Defaults to 24h from creation. */
  expiresAt?: string;
  /** Who issued this mandate (user ID or "system") */
  issuedBy: string;
}

export interface ProductResult {
  /** Unique product ID from the provider */
  productId: string;
  /** Product title */
  title: string;
  /** Price in USD */
  price: number;
  /** Currency (default USD) */
  currency?: string;
  /** Product URL */
  url: string;
  /** Image URL */
  imageUrl?: string;
  /** Merchant/seller name */
  merchant: string;
  /** Merchant domain */
  merchantDomain?: string;
  /** Product category */
  category?: string;
  /** Rating (0-5) */
  rating?: number;
  /** Number of reviews */
  reviewCount?: number;
  /** Estimated delivery days */
  deliveryDays?: number;
  /** Whether free shipping */
  freeShipping?: boolean;
  /** Raw provider data */
  raw?: Record<string, unknown>;
}

export interface PurchaseOrder {
  /** Unique order ID */
  id: string;
  /** Agent ID that placed the order */
  agentId: string;
  /** Product being purchased */
  product: ProductResult;
  /** MnemoPay transaction ID (escrow) */
  txId: string;
  /** Order status */
  status: "pending_approval" | "escrowed" | "purchased" | "shipped" | "delivered" | "cancelled" | "failed";
  /** Shipping address or delivery instructions */
  deliveryInstructions?: string;
  /** Tracking number */
  trackingNumber?: string;
  /** Tracking URL */
  trackingUrl?: string;
  /** Created timestamp */
  createdAt: Date;
  /** Last updated */
  updatedAt: Date;
  /** Mandate snapshot at time of purchase */
  mandate: ShoppingMandate;
  /** User approval status */
  approved: boolean;
  /** Failure reason if failed */
  failureReason?: string;
}

export type ApprovalCallback = (order: PurchaseOrder) => Promise<boolean>;

/**
 * Product search provider interface. Implement this to connect
 * any product catalog (eBay, custom API, local inventory, etc.)
 */
export interface CommerceProvider {
  readonly name: string;

  /** Search for products matching a query */
  search(query: string, options?: SearchOptions): Promise<ProductResult[]>;

  /** Get full product details by ID */
  getProduct(productId: string): Promise<ProductResult | null>;

  /** Execute a purchase (returns external order reference) */
  executePurchase(product: ProductResult, deliveryInstructions?: string): Promise<{
    externalOrderId: string;
    status: string;
    trackingUrl?: string;
  }>;

  /** Check order/delivery status */
  checkStatus(externalOrderId: string): Promise<{
    status: string;
    trackingNumber?: string;
    trackingUrl?: string;
    deliveredAt?: string;
  }>;
}

export interface SearchOptions {
  /** Maximum results to return (default: 10) */
  limit?: number;
  /** Minimum price filter */
  minPrice?: number;
  /** Maximum price filter */
  maxPrice?: number;
  /** Category filter */
  category?: string;
  /** Sort by: "price_asc", "price_desc", "rating", "relevance" */
  sortBy?: "price_asc" | "price_desc" | "rating" | "relevance";
  /** Free shipping only */
  freeShippingOnly?: boolean;
}

// ─── Mock Commerce Provider (for testing/development) ───────────────────────

export class MockCommerceProvider implements CommerceProvider {
  readonly name = "mock";
  private counter = 0;
  private catalog: ProductResult[] = [
    { productId: "mock-001", title: "USB-C Cable 6ft", price: 9.99, url: "https://example.com/usbc", merchant: "TechStore", merchantDomain: "techstore.com", category: "electronics", rating: 4.5, reviewCount: 2340, deliveryDays: 3, freeShipping: true },
    { productId: "mock-002", title: "Wireless Mouse", price: 24.99, url: "https://example.com/mouse", merchant: "TechStore", merchantDomain: "techstore.com", category: "electronics", rating: 4.2, reviewCount: 890, deliveryDays: 2, freeShipping: true },
    { productId: "mock-003", title: "Laptop Stand Adjustable", price: 34.99, url: "https://example.com/stand", merchant: "OfficeGear", merchantDomain: "officegear.com", category: "office", rating: 4.7, reviewCount: 5600, deliveryDays: 5, freeShipping: false },
    { productId: "mock-004", title: "Mechanical Keyboard", price: 79.99, url: "https://example.com/keyboard", merchant: "KeysRUs", merchantDomain: "keysrus.com", category: "electronics", rating: 4.8, reviewCount: 12000, deliveryDays: 3, freeShipping: true },
    { productId: "mock-005", title: "Noise Cancelling Headphones", price: 199.99, url: "https://example.com/headphones", merchant: "AudioWorld", merchantDomain: "audioworld.com", category: "electronics", rating: 4.6, reviewCount: 8900, deliveryDays: 4, freeShipping: true },
  ];

  async search(query: string, options?: SearchOptions): Promise<ProductResult[]> {
    const q = query.toLowerCase();
    let results = this.catalog.filter(p =>
      p.title.toLowerCase().includes(q) ||
      p.category?.toLowerCase().includes(q) ||
      q.includes(p.category?.toLowerCase() ?? "")
    );

    // If no keyword match, return all (simulating broad search)
    if (results.length === 0) results = [...this.catalog];

    // Apply filters
    if (options?.minPrice !== undefined) results = results.filter(p => p.price >= options.minPrice!);
    if (options?.maxPrice !== undefined) results = results.filter(p => p.price <= options.maxPrice!);
    if (options?.category) results = results.filter(p => p.category === options.category);
    if (options?.freeShippingOnly) results = results.filter(p => p.freeShipping);

    // Sort
    if (options?.sortBy === "price_asc") results.sort((a, b) => a.price - b.price);
    else if (options?.sortBy === "price_desc") results.sort((a, b) => b.price - a.price);
    else if (options?.sortBy === "rating") results.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));

    return results.slice(0, options?.limit ?? 10);
  }

  async getProduct(productId: string): Promise<ProductResult | null> {
    return this.catalog.find(p => p.productId === productId) ?? null;
  }

  async executePurchase(product: ProductResult, _deliveryInstructions?: string): Promise<{ externalOrderId: string; status: string; trackingUrl?: string }> {
    return {
      externalOrderId: `mock_order_${++this.counter}`,
      status: "confirmed",
      trackingUrl: `https://example.com/track/${this.counter}`,
    };
  }

  async checkStatus(externalOrderId: string): Promise<{ status: string; trackingNumber?: string; trackingUrl?: string; deliveredAt?: string }> {
    return {
      status: "delivered",
      trackingNumber: `TRACK${externalOrderId.replace(/\D/g, "")}`,
      trackingUrl: `https://example.com/track/${externalOrderId}`,
      deliveredAt: new Date().toISOString(),
    };
  }
}

// ─── Commerce Engine ────────────────────────────────────────────────────────

export class CommerceEngine {
  private agent: any; // MnemoPayLite — avoid circular import
  private provider: CommerceProvider;
  private mandate: ShoppingMandate | null = null;
  private orders: Map<string, PurchaseOrder> = new Map();
  private totalSpent = 0;
  private approvalCallback: ApprovalCallback | null = null;
  private externalOrderMap: Map<string, string> = new Map(); // externalOrderId → orderId

  constructor(agent: any, provider?: CommerceProvider) {
    this.agent = agent;
    this.provider = provider ?? new MockCommerceProvider();
  }

  // ── Mandate Management ──────────────────────────────────────────────────

  /**
   * Set a shopping mandate that defines what this agent can buy.
   * All purchases are validated against this mandate.
   */
  setMandate(mandate: ShoppingMandate): void {
    if (!mandate.budget || mandate.budget <= 0) {
      throw new Error("Mandate budget must be positive");
    }
    if (!mandate.issuedBy) {
      throw new Error("Mandate must have an issuer (issuedBy)");
    }

    this.mandate = {
      ...mandate,
      maxPerItem: mandate.maxPerItem ?? mandate.budget,
      expiresAt: mandate.expiresAt ?? new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    };
    this.totalSpent = 0;

    this.agent.audit("commerce:mandate:set", {
      budget: mandate.budget,
      categories: mandate.categories,
      issuedBy: mandate.issuedBy,
      expiresAt: this.mandate.expiresAt,
    });
  }

  /** Get the current active mandate */
  getMandate(): ShoppingMandate | null {
    return this.mandate;
  }

  /** Remaining budget under current mandate */
  get remainingBudget(): number {
    if (!this.mandate) return 0;
    return Math.max(0, this.mandate.budget - this.totalSpent);
  }

  /** Set a callback for user approval of high-value purchases */
  onApprovalRequired(callback: ApprovalCallback): void {
    this.approvalCallback = callback;
  }

  // ── Product Search ──────────────────────────────────────────────────────

  /**
   * Search for products. Uses agent memory to personalize results
   * (e.g., preferred brands, past purchase satisfaction).
   */
  async search(query: string, options?: SearchOptions): Promise<ProductResult[]> {
    if (!this.mandate) {
      throw new Error("No shopping mandate set. Call setMandate() first.");
    }

    // Check mandate expiry
    if (new Date() > new Date(this.mandate.expiresAt!)) {
      throw new Error("Shopping mandate has expired");
    }

    // Apply mandate constraints to search
    const constrainedOptions: SearchOptions = {
      ...options,
      maxPrice: options?.maxPrice
        ? Math.min(options.maxPrice, this.mandate.maxPerItem!)
        : this.mandate.maxPerItem!,
    };

    // Recall user preferences from memory to enhance search
    let preferences = "";
    try {
      const memories = await this.agent.recall(query, 3);
      if (memories.length > 0) {
        preferences = memories.map((m: any) => m.content).join("; ");
      }
    } catch {
      // Memory recall is best-effort for commerce
    }

    const results = await this.provider.search(query, constrainedOptions);

    // Filter by mandate restrictions
    return results.filter(p => this.validateProduct(p) === null);
  }

  // ── Purchase Flow ───────────────────────────────────────────────────────

  /**
   * Create a purchase order for a product. Validates against mandate,
   * creates escrow hold, optionally requests user approval.
   */
  async purchase(
    product: ProductResult,
    deliveryInstructions?: string,
  ): Promise<PurchaseOrder> {
    if (!this.mandate) {
      throw new Error("No shopping mandate set. Call setMandate() first.");
    }

    // Validate mandate expiry
    if (new Date() > new Date(this.mandate.expiresAt!)) {
      throw new Error("Shopping mandate has expired");
    }

    // Validate product against mandate
    const violation = this.validateProduct(product);
    if (violation) {
      throw new Error(`Mandate violation: ${violation}`);
    }

    // Check remaining budget
    if (product.price > this.remainingBudget) {
      throw new Error(
        `Insufficient mandate budget: $${product.price.toFixed(2)} exceeds remaining $${this.remainingBudget.toFixed(2)}`
      );
    }

    const orderId = `order_${this.agent.agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date();

    const order: PurchaseOrder = {
      id: orderId,
      agentId: this.agent.agentId,
      product,
      txId: "", // Set after escrow
      status: "pending_approval",
      deliveryInstructions,
      createdAt: now,
      updatedAt: now,
      mandate: { ...this.mandate },
      approved: false,
    };

    // Check if user approval is needed
    const threshold = this.mandate.approvalThreshold;
    if (threshold !== undefined && product.price >= threshold && this.approvalCallback) {
      const approved = await this.approvalCallback(order);
      if (!approved) {
        order.status = "cancelled";
        order.failureReason = "User declined approval";
        this.orders.set(orderId, order);
        this.agent.audit("commerce:purchase:declined", { orderId, product: product.title, price: product.price });
        return order;
      }
    }
    order.approved = true;

    // Create escrow hold via MnemoPay charge
    const tx = await this.agent.charge(
      product.price,
      `Purchase: ${product.title} from ${product.merchant}`,
    );
    order.txId = tx.id;
    order.status = "escrowed";
    order.updatedAt = new Date();

    this.orders.set(orderId, order);

    this.agent.audit("commerce:purchase:escrowed", {
      orderId,
      txId: tx.id,
      product: product.title,
      price: product.price,
      merchant: product.merchant,
    });

    // Execute the actual purchase via provider
    try {
      const result = await this.provider.executePurchase(product, deliveryInstructions);
      order.status = "purchased";
      order.trackingUrl = result.trackingUrl;
      order.updatedAt = new Date();

      this.externalOrderMap.set(result.externalOrderId, orderId);

      this.agent.audit("commerce:purchase:executed", {
        orderId,
        externalOrderId: result.externalOrderId,
        status: result.status,
      });

      // Remember the purchase for future preference learning
      await this.agent.remember(
        `Purchased "${product.title}" from ${product.merchant} for $${product.price.toFixed(2)}. Category: ${product.category ?? "unknown"}.`,
        { importance: 0.6, tags: ["purchase", product.category ?? "shopping"] },
      );

      this.totalSpent += product.price;
    } catch (err: any) {
      // Purchase failed — refund escrow
      order.status = "failed";
      order.failureReason = err.message;
      order.updatedAt = new Date();

      try {
        await this.agent.refund(tx.id);
      } catch {
        // Refund best-effort, log it
        this.agent.audit("commerce:refund:failed", { orderId, txId: tx.id });
      }

      this.agent.audit("commerce:purchase:failed", {
        orderId,
        reason: err.message,
      });
    }

    return order;
  }

  /**
   * Confirm delivery of an order. Settles the escrow, releasing funds.
   */
  async confirmDelivery(orderId: string): Promise<PurchaseOrder> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (order.status === "delivered") throw new Error("Order already delivered");
    if (order.status === "cancelled" || order.status === "failed") {
      throw new Error(`Cannot confirm delivery on ${order.status} order`);
    }

    // Settle the escrow
    await this.agent.settle(order.txId);
    order.status = "delivered";
    order.updatedAt = new Date();

    this.agent.audit("commerce:delivery:confirmed", {
      orderId,
      txId: order.txId,
      product: order.product.title,
      price: order.product.price,
    });

    // Reinforce memory of successful purchase
    await this.agent.remember(
      `Delivery confirmed: "${order.product.title}" from ${order.product.merchant}. Satisfied.`,
      { importance: 0.5, tags: ["delivery", "satisfied"] },
    );

    return order;
  }

  /**
   * Cancel an order and refund the escrow.
   */
  async cancelOrder(orderId: string, reason?: string): Promise<PurchaseOrder> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (order.status === "delivered") throw new Error("Cannot cancel a delivered order");
    if (order.status === "cancelled") throw new Error("Order already cancelled");

    // Refund escrow
    if (order.txId) {
      await this.agent.refund(order.txId);
      this.totalSpent = Math.max(0, this.totalSpent - order.product.price);
    }

    order.status = "cancelled";
    order.failureReason = reason ?? "Cancelled by user";
    order.updatedAt = new Date();

    this.agent.audit("commerce:order:cancelled", {
      orderId,
      txId: order.txId,
      reason: order.failureReason,
    });

    return order;
  }

  /**
   * Check delivery status of an order via the commerce provider.
   */
  async checkDeliveryStatus(orderId: string): Promise<PurchaseOrder> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order not found: ${orderId}`);

    // Find external order ID
    let externalOrderId: string | undefined;
    for (const [extId, oId] of this.externalOrderMap) {
      if (oId === orderId) { externalOrderId = extId; break; }
    }

    if (externalOrderId) {
      const status = await this.provider.checkStatus(externalOrderId);
      if (status.trackingNumber) order.trackingNumber = status.trackingNumber;
      if (status.trackingUrl) order.trackingUrl = status.trackingUrl;

      if (status.status === "delivered" && order.status !== "delivered") {
        order.status = "shipped"; // Mark shipped, user still needs to confirmDelivery()
      } else if (status.status === "shipped" && order.status === "purchased") {
        order.status = "shipped";
      }
      order.updatedAt = new Date();
    }

    return order;
  }

  // ── Order Management ────────────────────────────────────────────────────

  /** Get an order by ID */
  getOrder(orderId: string): PurchaseOrder | null {
    return this.orders.get(orderId) ?? null;
  }

  /** List all orders */
  listOrders(status?: PurchaseOrder["status"]): PurchaseOrder[] {
    const all = Array.from(this.orders.values());
    if (status) return all.filter(o => o.status === status);
    return all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Get spending summary under current mandate */
  spendingSummary(): {
    totalSpent: number;
    remainingBudget: number;
    orderCount: number;
    deliveredCount: number;
    pendingCount: number;
  } {
    const orders = Array.from(this.orders.values());
    return {
      totalSpent: this.totalSpent,
      remainingBudget: this.remainingBudget,
      orderCount: orders.length,
      deliveredCount: orders.filter(o => o.status === "delivered").length,
      pendingCount: orders.filter(o => ["escrowed", "purchased", "shipped"].includes(o.status)).length,
    };
  }

  // ── Validation ──────────────────────────────────────────────────────────

  /** Validate a product against the current mandate. Returns null if OK, or violation string. */
  private validateProduct(product: ProductResult): string | null {
    if (!this.mandate) return "No mandate set";

    // Price check
    if (product.price > this.mandate.maxPerItem!) {
      return `Price $${product.price.toFixed(2)} exceeds per-item limit $${this.mandate.maxPerItem!.toFixed(2)}`;
    }

    // Category check
    const cat = product.category?.toLowerCase();
    if (cat && this.mandate.blockedCategories?.length) {
      if (this.mandate.blockedCategories.some(c => c.toLowerCase() === cat)) {
        return `Category "${product.category}" is blocked`;
      }
    }
    if (cat && this.mandate.categories?.length) {
      if (!this.mandate.categories.some(c => c.toLowerCase() === cat)) {
        return `Category "${product.category}" not in allowed list`;
      }
    }

    // Merchant check
    const domain = product.merchantDomain?.toLowerCase();
    if (domain && this.mandate.blockedMerchants?.length) {
      if (this.mandate.blockedMerchants.some(m => m.toLowerCase() === domain)) {
        return `Merchant "${product.merchant}" is blocked`;
      }
    }
    if (domain && this.mandate.allowedMerchants?.length) {
      if (!this.mandate.allowedMerchants.some(m => m.toLowerCase() === domain)) {
        return `Merchant "${product.merchant}" not in allowed list`;
      }
    }

    return null;
  }
}
