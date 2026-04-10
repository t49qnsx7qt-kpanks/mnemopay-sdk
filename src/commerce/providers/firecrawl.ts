/**
 * Firecrawl Commerce Provider
 *
 * Uses Firecrawl API to search and scrape ANY merchant website for products.
 * This is the most flexible provider — works with any online store.
 *
 * Search: Firecrawl's search endpoint finds product pages matching a query.
 * Product details: Firecrawl scrapes the product page and extracts structured data.
 * Purchase: Returns the product URL for manual or Playwright-based checkout.
 *
 * Env: FIRECRAWL_API_KEY
 */

import type { CommerceProvider, ProductResult, SearchOptions } from "../../commerce.js";

export interface FirecrawlConfig {
  apiKey: string;
  baseUrl?: string;
}

export class FirecrawlProvider implements CommerceProvider {
  readonly name = "firecrawl";
  private apiKey: string;
  private baseUrl: string;

  constructor(config: FirecrawlConfig) {
    if (!config.apiKey) throw new Error("Firecrawl API key is required");
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "https://api.firecrawl.dev/v1";
  }

  async search(query: string, options?: SearchOptions): Promise<ProductResult[]> {
    const limit = options?.limit ?? 10;
    const searchQuery = this.buildSearchQuery(query, options);

    const res = await fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query: searchQuery,
        limit,
        scrapeOptions: {
          formats: ["extract"],
          extract: {
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                price: { type: "number" },
                currency: { type: "string" },
                merchant: { type: "string" },
                category: { type: "string" },
                rating: { type: "number" },
                reviewCount: { type: "number" },
                imageUrl: { type: "string" },
                inStock: { type: "boolean" },
                freeShipping: { type: "boolean" },
                deliveryDays: { type: "number" },
              },
              required: ["title", "price"],
            },
          },
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "unknown error");
      throw new Error(`Firecrawl search failed (${res.status}): ${err}`);
    }

    const data = await res.json() as any;
    const results: ProductResult[] = [];

    for (const item of data.data || []) {
      const extracted = item.extract || {};
      const price = this.parsePrice(extracted.price);
      if (price === null) continue; // skip items with no parseable price

      // Apply price filters
      if (options?.minPrice && price < options.minPrice) continue;
      if (options?.maxPrice && price > options.maxPrice) continue;
      if (options?.freeShippingOnly && !extracted.freeShipping) continue;

      const domain = this.extractDomain(item.url || "");
      results.push({
        productId: this.hashUrl(item.url || `firecrawl-${results.length}`),
        title: extracted.title || item.title || "Unknown Product",
        price,
        currency: extracted.currency || "USD",
        url: item.url || "",
        imageUrl: extracted.imageUrl,
        merchant: extracted.merchant || domain || "Unknown",
        merchantDomain: domain,
        category: extracted.category || options?.category,
        rating: extracted.rating,
        reviewCount: extracted.reviewCount,
        deliveryDays: extracted.deliveryDays,
        freeShipping: extracted.freeShipping ?? false,
        raw: extracted,
      });
    }

    // Sort results
    if (options?.sortBy) {
      results.sort((a, b) => {
        switch (options.sortBy) {
          case "price_asc": return a.price - b.price;
          case "price_desc": return b.price - a.price;
          case "rating": return (b.rating ?? 0) - (a.rating ?? 0);
          default: return 0; // relevance — keep Firecrawl's order
        }
      });
    }

    return results;
  }

  async getProduct(productId: string): Promise<ProductResult | null> {
    // productId is a hash — we need the URL. Check if it looks like a URL.
    const url = this.isUrl(productId) ? productId : null;
    if (!url) return null;

    const res = await fetch(`${this.baseUrl}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ["extract"],
        extract: {
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              price: { type: "number" },
              currency: { type: "string" },
              merchant: { type: "string" },
              category: { type: "string" },
              rating: { type: "number" },
              reviewCount: { type: "number" },
              imageUrl: { type: "string" },
              inStock: { type: "boolean" },
              freeShipping: { type: "boolean" },
              deliveryDays: { type: "number" },
            },
            required: ["title", "price"],
          },
        },
      }),
    });

    if (!res.ok) return null;

    const data = await res.json() as any;
    const extracted = data.data?.extract || {};
    const price = this.parsePrice(extracted.price);
    if (price === null) return null;

    const domain = this.extractDomain(url);
    return {
      productId: this.hashUrl(url),
      title: extracted.title || "Unknown Product",
      price,
      currency: extracted.currency || "USD",
      url,
      imageUrl: extracted.imageUrl,
      merchant: extracted.merchant || domain || "Unknown",
      merchantDomain: domain,
      category: extracted.category,
      rating: extracted.rating,
      reviewCount: extracted.reviewCount,
      deliveryDays: extracted.deliveryDays,
      freeShipping: extracted.freeShipping ?? false,
      raw: extracted,
    };
  }

  async executePurchase(product: ProductResult, deliveryInstructions?: string): Promise<{
    externalOrderId: string;
    status: string;
    trackingUrl?: string;
  }> {
    // Firecrawl can't execute purchases directly — it's a scraping tool.
    // Return the product URL so the caller (or Playwright) can complete checkout.
    return {
      externalOrderId: `fc_order_${Date.now()}_${product.productId.slice(0, 8)}`,
      status: "checkout_required",
      trackingUrl: product.url,
    };
  }

  async checkStatus(externalOrderId: string): Promise<{
    status: string;
    trackingNumber?: string;
    trackingUrl?: string;
    deliveredAt?: string;
  }> {
    // Firecrawl orders require manual tracking — scraping order status pages
    // would need the user's session cookies which we don't have.
    return {
      status: "manual_tracking_required",
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private buildSearchQuery(query: string, options?: SearchOptions): string {
    let q = `buy ${query}`;
    if (options?.maxPrice) q += ` under $${options.maxPrice}`;
    if (options?.category) q += ` ${options.category}`;
    if (options?.freeShippingOnly) q += " free shipping";
    return q;
  }

  private parsePrice(value: unknown): number | null {
    if (typeof value === "number" && value > 0) return value;
    if (typeof value === "string") {
      const cleaned = value.replace(/[^0-9.]/g, "");
      const num = parseFloat(cleaned);
      if (!isNaN(num) && num > 0) return num;
    }
    return null;
  }

  private extractDomain(url: string): string | undefined {
    try {
      return new URL(url).hostname.replace("www.", "");
    } catch {
      return undefined;
    }
  }

  private hashUrl(url: string): string {
    // SHA-256 truncated for deterministic product ID — same URL = same ID, collision-resistant
    const { createHash } = require("crypto");
    return `fc_${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
  }

  private isUrl(s: string): boolean {
    try {
      new URL(s);
      return true;
    } catch {
      return false;
    }
  }
}
