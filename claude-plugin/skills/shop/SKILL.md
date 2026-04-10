---
name: shop
description: Search for products and make purchases using autonomous shopping with escrow. Use when the user wants to buy something, search for products, or manage orders.
---

# Shop

Use MnemoPay's commerce tools for autonomous shopping with escrow protection.

Available MCP tools:
- `shop_search` — search for products by query
- `shop_buy` — purchase a product (uses escrow for protection)
- `shop_orders` — list current orders and their status
- `shop_confirm_delivery` — confirm delivery and release escrow
- `shop_set_mandate` — set spending limits and approval thresholds

When the user wants to shop:
1. Use `shop_search` to find products matching "$ARGUMENTS"
2. Present options with prices
3. If the user confirms, use `shop_buy` to purchase
4. Explain the escrow protection (funds held until delivery confirmed)

For purchases above the mandate threshold, explain that approval is needed.
