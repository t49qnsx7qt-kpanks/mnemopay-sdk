# MCP Hive Founding-100 ("Project Ignite") application — MnemoPay

**Status:** DRAFT — pending Jeremiah's review and submit. Submission target: by end of week 2026-05-10 (before May 11 launch).
**Submission method:** mcp-hive.com/register (primary) + email `info@mcp-hive.com` (mirror, more direct contact).
**From:** Jeremiah Omiagbo, jeremiah@getbizsuite.com (J&B Enterprise LLC)

---

## Why we're applying

MCP Hive's published model — "AI applications pay per request, providers earn per response" — has a billing-shaped hole. The site doesn't name a payment infrastructure partner. Every founding provider on the platform will need to:

1. Charge per-call (often sub-cent)
2. Refuse abusive callers
3. Produce verifiable receipts
4. Eventually defend their billing under EU AI Act Article 12 retention obligations

That is exactly what `@mnemopay/sdk` (npm) provides. We'd like to be the payments + reputation layer the founding-100 default to.

---

## What MnemoPay brings to the founding-100

- **Sub-cent payments via Lightning rail.** Stripe and Paystack can't economically settle a $0.002 charge. Lightning can. MnemoPay routes automatically.
- **Three-rail interface (Stripe / Paystack / Lightning) behind one API.** `agent.charge(amount, reason)` — two lines of code in any MCP tool handler.
- **Agent Credit Score (300–850).** Rate-limit and gate abusive callers without writing custom rate-limit code. New callers start at 650 (the "fair" tier) and earn up.
- **Cryptographic receipts every user can audit.** No "trust me" billing — every transaction has a Merkle-chained, signed receipt the caller can verify independently.
- **Article 12 audit bundle export.** EU AI Act enforcement starts August 2, 2026. MnemoPay produces tamper-evident audit bundles out of the box. Founding providers using us inherit compliance posture.
- **Apache-2.0 open source.** No vendor lock-in. SDK and MCP server both Apache 2.0.

## What we'd commit to as a Founding-100 partner

If accepted into Project Ignite, MnemoPay would deliver, within 30 days of MCP Hive launch (May 11):

1. **Public quickstart:** `mnemopay.com/mcp-hive` — copy-paste integration snippet for any MCP Hive provider to add billing + reputation in two lines.
2. **Sub-cent demo MCP server:** `embed-doc.mnemopay.com` — live MCP server priced at $0.002/call via Lightning, free for the first 10K calls per month, demonstrating the economic model.
3. **Free MnemoPay billing for the first 10 MCP Hive providers** who integrate (subject to 90 days written notice on any future fee). Already a public commitment in our README.
4. **Joint launch content:** a co-byline blog post on the day MCP Hive launches, walking through the MnemoPay + MCP Hive integration. We bring the technical credibility; you bring the distribution.
5. **Continuous Article 12 audit bundle support** for any MCP Hive provider who needs to satisfy EU AI Act enforcement when it lands August 2.

## What we're asking for

- A Founding-100 slot.
- A line in MCP Hive's launch announcement naming MnemoPay as a payments + reputation infrastructure partner, with a link to our quickstart.
- Permission to identify ourselves publicly as an MCP Hive Founding Provider in our marketing.

## About us

J&B Enterprise LLC (Texas, est. December 2025). Solo-founder operation, multiple agent infrastructure products: MnemoPay (this), GridStamp (proof-of-presence for embodied agents), BizSuite (managed AI plugins for SMBs). MnemoPay v1.4.2 on npm, v1.0.0b3 on PyPI, MCP server registered with Smithery. 672+ tests passing. Apache 2.0.

We're building from Texas, not Silicon Valley. We dogfood our own stack. The first MnemoPay charge in production was MnemoPay charging itself for an internal tool call.

## Contact

- Jeremiah Omiagbo — jeremiah@getbizsuite.com — +1 (214) 428-3608
- npm: https://www.npmjs.com/package/@mnemopay/sdk
- GitHub: https://github.com/mnemopay/mnemopay-sdk
- Site: https://mnemopay.com
- MCP server: https://mnemopay-mcp.fly.dev/

We'd be glad to hop on a 20-minute call any time before May 11.

---

## Email version (shorter, for info@mcp-hive.com)

> **Subject:** Founding-100 application — MnemoPay (payments + reputation for MCP servers)
>
> Hi MCP Hive team,
>
> I run MnemoPay — Apache-2.0 SDK that gives any MCP server sub-cent payments (Lightning), a cross-platform agent credit score (300–850), cryptographic receipts, and EU AI Act-ready audit bundles. v1.4.2 on npm, 672+ tests, MCP-native.
>
> Looking at the MCP Hive launch model, the billing layer is the missing primitive your founding providers will need. We'd like to apply for one of the founding-100 slots and commit to:
>
> 1. A public `mnemopay.com/mcp-hive` quickstart by launch day
> 2. A live sub-cent demo MCP server on Lightning
> 3. Free MnemoPay billing for the first 10 MCP Hive providers who integrate
> 4. Co-byline launch content on May 11
>
> Happy to share the longer pitch + answer questions on a 20-min call.
>
> — Jeremiah Omiagbo
> J&B Enterprise LLC · jeremiah@getbizsuite.com · +1 (214) 428-3608
> https://mnemopay.com · https://github.com/mnemopay/mnemopay-sdk

---

**Open questions for Jeremiah before submitting:**

1. The "Free MnemoPay billing for the first 10 MCP Hive providers" commitment — is the existing 10-MCP-server promo in the README transferable here, or do we extend it (i.e., 10 *general* + 10 *MCP-Hive-specific*)? Recommend extending: the goodwill and distribution lock-in are worth the marginal Lightning cost.
2. Is `embed-doc.mnemopay.com` a domain we own / can stand up by May 11, or should the demo live at `mnemopay.com/demo/mcp-hive`? Either works; second is faster to ship.
3. Do you want me to draft the joint co-byline blog post pre-emptively (so it's ready if/when accepted)?
