/**
 * Shopify Storefront Commerce Provider
 *
 * Uses the Shopify Storefront API (GraphQL) to search products on any
 * Shopify store. Public Storefront Access Tokens allow read-only product
 * access without merchant credentials.
 *
 * Search: GraphQL products query with text filter.
 * Product details: GraphQL product by handle/ID.
 * Purchase: Creates a Storefront checkout (cart) with the product.
 *
 * Env: SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_TOKEN
 */

import type { CommerceProvider, ProductResult, SearchOptions } from "../../commerce.js";

export interface ShopifyConfig {
  /** Shopify store domain (e.g., "my-store.myshopify.com") */
  storeDomain: string;
  /** Storefront API access token */
  storefrontToken: string;
  /** API version (default: "2024-10") */
  apiVersion?: string;
}

export class ShopifyProvider implements CommerceProvider {
  readonly name = "shopify";
  private storeDomain: string;
  private storefrontToken: string;
  private apiVersion: string;

  constructor(config: ShopifyConfig) {
    if (!config.storeDomain) throw new Error("Shopify store domain is required");
    if (!config.storefrontToken) throw new Error("Shopify Storefront API token is required");
    this.storeDomain = config.storeDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.storefrontToken = config.storefrontToken;
    this.apiVersion = config.apiVersion || "2024-10";
  }

  private get endpoint(): string {
    return `https://${this.storeDomain}/api/${this.apiVersion}/graphql.json`;
  }

  private async gql(query: string, variables?: Record<string, unknown>): Promise<any> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": this.storefrontToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "unknown error");
      throw new Error(`Shopify API error (${res.status}): ${err}`);
    }

    const data = await res.json() as any;
    if (data.errors?.length) {
      throw new Error(`Shopify GraphQL error: ${data.errors[0].message}`);
    }
    return data.data;
  }

  async search(query: string, options?: SearchOptions): Promise<ProductResult[]> {
    const limit = Math.min(options?.limit ?? 10, 50);

    // Build Shopify search query with price filters
    let searchQuery = query;
    if (options?.minPrice) searchQuery += ` price:>=${options.minPrice}`;
    if (options?.maxPrice) searchQuery += ` price:<=${options.maxPrice}`;
    if (options?.category) searchQuery += ` product_type:${options.category}`;

    const sortKey = this.mapSortKey(options?.sortBy);

    const data = await this.gql(`
      query SearchProducts($query: String!, $first: Int!, $sortKey: ProductSortKeys, $reverse: Boolean) {
        products(first: $first, query: $query, sortKey: $sortKey, reverse: $reverse) {
          edges {
            node {
              id
              handle
              title
              productType
              vendor
              onlineStoreUrl
              featuredImage {
                url
              }
              priceRange {
                minVariantPrice {
                  amount
                  currencyCode
                }
              }
              variants(first: 1) {
                edges {
                  node {
                    id
                    price {
                      amount
                      currencyCode
                    }
                    availableForSale
                  }
                }
              }
            }
          }
        }
      }
    `, {
      query: searchQuery,
      first: limit,
      sortKey: sortKey.key,
      reverse: sortKey.reverse,
    });

    const results: ProductResult[] = [];
    for (const edge of data.products.edges) {
      const node = edge.node;
      const variant = node.variants.edges[0]?.node;
      if (!variant?.availableForSale || !variant?.price) continue;

      const price = parseFloat(variant.price.amount);
      if (options?.minPrice && price < options.minPrice) continue;
      if (options?.maxPrice && price > options.maxPrice) continue;

      results.push({
        productId: node.id,
        title: node.title,
        price,
        currency: variant.price.currencyCode || "USD",
        url: node.onlineStoreUrl || `https://${this.storeDomain}/products/${node.handle}`,
        imageUrl: node.featuredImage?.url,
        merchant: node.vendor || this.storeDomain,
        merchantDomain: this.storeDomain,
        category: node.productType || undefined,
        raw: { shopifyId: node.id, handle: node.handle, variantId: variant.id },
      });
    }

    return results;
  }

  async getProduct(productId: string): Promise<ProductResult | null> {
    // Accept both Shopify GID and handle
    const isGid = productId.startsWith("gid://");
    const query = isGid
      ? `query GetProduct($id: ID!) { product(id: $id) { ${this.productFields()} } }`
      : `query GetProduct($handle: String!) { productByHandle(handle: $handle) { ${this.productFields()} } }`;
    const variables = isGid ? { id: productId } : { handle: productId };

    const data = await this.gql(query, variables);
    const node = isGid ? data.product : data.productByHandle;
    if (!node) return null;

    const variant = node.variants.edges[0]?.node;
    if (!variant) return null;

    return {
      productId: node.id,
      title: node.title,
      price: parseFloat(variant.price.amount),
      currency: variant.price.currencyCode || "USD",
      url: node.onlineStoreUrl || `https://${this.storeDomain}/products/${node.handle}`,
      imageUrl: node.featuredImage?.url,
      merchant: node.vendor || this.storeDomain,
      merchantDomain: this.storeDomain,
      category: node.productType || undefined,
      raw: { shopifyId: node.id, handle: node.handle, variantId: variant.id },
    };
  }

  async executePurchase(product: ProductResult, deliveryInstructions?: string): Promise<{
    externalOrderId: string;
    status: string;
    trackingUrl?: string;
  }> {
    const variantId = (product.raw as any)?.variantId;
    if (!variantId) {
      return {
        externalOrderId: `shopify_noid_${Date.now()}`,
        status: "checkout_required",
        trackingUrl: product.url,
      };
    }

    // Create a Storefront cart
    const data = await this.gql(`
      mutation CreateCart($variantId: ID!) {
        cartCreate(input: {
          lines: [{ quantity: 1, merchandiseId: $variantId }]
          note: ${JSON.stringify(deliveryInstructions || "")}
        }) {
          cart {
            id
            checkoutUrl
          }
          userErrors {
            field
            message
          }
        }
      }
    `, { variantId });

    const cart = data.cartCreate?.cart;
    const errors = data.cartCreate?.userErrors;

    if (errors?.length) {
      throw new Error(`Shopify cart error: ${errors[0].message}`);
    }

    if (!cart) {
      return {
        externalOrderId: `shopify_fallback_${Date.now()}`,
        status: "checkout_required",
        trackingUrl: product.url,
      };
    }

    return {
      externalOrderId: cart.id,
      status: "cart_created",
      trackingUrl: cart.checkoutUrl,
    };
  }

  async checkStatus(externalOrderId: string): Promise<{
    status: string;
    trackingNumber?: string;
    trackingUrl?: string;
    deliveredAt?: string;
  }> {
    // Storefront API doesn't expose order tracking without customer auth.
    // Order status is tracked via the checkoutUrl email notification.
    return {
      status: "tracking_via_email",
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private productFields(): string {
    return `
      id
      handle
      title
      productType
      vendor
      onlineStoreUrl
      featuredImage { url }
      variants(first: 1) {
        edges {
          node {
            id
            price { amount currencyCode }
            availableForSale
          }
        }
      }
    `;
  }

  private mapSortKey(sortBy?: string): { key: string; reverse: boolean } {
    switch (sortBy) {
      case "price_asc": return { key: "PRICE", reverse: false };
      case "price_desc": return { key: "PRICE", reverse: true };
      case "rating": return { key: "BEST_SELLING", reverse: false };
      default: return { key: "RELEVANCE", reverse: false };
    }
  }
}
