---
title: "Teaching your MCP server to say 402: wiring x402 to MnemoPay for agent-native billing"
published: false
tags: [mcp, agents, payments, nodejs, typescript]
canonical_url: https://getbizsuite.com/blog/x402-mcp-server-402
---

your tool-use API has one endpoint that burns $0.02 in LLM tokens per call and you're serving it for free. agents are looping it. you keep telling yourself you'll "add Stripe later." here's how to turn that endpoint into $0.05 billed per call without writing a single Stripe webhook, without an OAuth flow, and without making the calling agent click a Checkout link it cannot click.

## why x402 fits agents and Stripe Checkout doesn't

a human can click a hosted Stripe Checkout link, type a card, and come back. an agent in a tool-use loop cannot. there is no human in that loop on a 200ms budget. Checkout is designed for a session a human owns, with cookies and a redirect lifecycle. that's fine, it just isn't this lifecycle.

x402 is the other shape. a server returns HTTP 402 with a JSON body that says "you owe X to Y in asset Z, here's the resource id." the client (the agent or its runtime) pays out of band, attaches a receipt header, and retries. the whole exchange is machine-readable and machine-payable. Coinbase published the original draft (search "coinbase x402"); a handful of MCP and agent frameworks have started picking it up. MnemoPay already speaks it on the settlement side, which is the part this post is about.

## the flow in one diagram

```
Client (agent)                    Server (your MCP tool)             MnemoPay
     |                                     |                              |
     | GET /tools/expensive                |                              |
     |------------------------------------>|                              |
     |                                     | (no X-Payment header)        |
     |   402 Payment Required              |                              |
     |   { price, asset, receiver, id }    |                              |
     |<------------------------------------|                              |
     |                                     |                              |
     | mp.charge(price, "tool:expensive")                                  |
     |-------------------------------------------------------------------->|
     |                              tx.id, status="pending"                |
     |<--------------------------------------------------------------------|
     |                                                                    |
     | mp.settle(tx.id, receiverId)                                        |
     |-------------------------------------------------------------------->|
     |                              tx.status="completed"                  |
     |<--------------------------------------------------------------------|
     |                                     |                              |
     | GET /tools/expensive                |                              |
     | X-Payment: <tx.id>                  |                              |
     |------------------------------------>|                              |
     |                                     | verify tx via mp.history     |
     |                                     |----------------------------->|
     |                                     |       tx (completed)         |
     |                                     |<-----------------------------|
     |             200 OK + payload        |                              |
     |<------------------------------------|                              |
```

## server middleware: Node + Express + MnemoPay

real, copy-pasteable. assumes the server runs its own MnemoPay agent that acts as the merchant of record. the `receiverId` you pin server-side is your merchant agent id; the client never gets to choose it.

```ts
// server.ts
import express from "express";
import { MnemoPayLite } from "@mnemopay/sdk";

const app = express();
const merchant = await MnemoPayLite.quick("merchant-acme-tools");
const RECEIVER_ID = merchant.agentId;

function x402(priceCents: number) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const chargeId = req.header("X-Payment");

    if (!chargeId) {
      return res.status(402).json({
        x402Version: 1,
        accepts: [{
          scheme: "mnemopay",
          asset: "USD",
          amount: priceCents / 100,
          receiver: RECEIVER_ID,
          resource: req.originalUrl,
        }],
      });
    }

    const history = await merchant.history(200);
    const tx = history.find(t => t.id === chargeId);
    if (!tx) return res.status(402).json({ error: "unknown charge" });
    if (tx.status !== "completed") return res.status(402).json({ error: `charge ${tx.status}` });
    if (tx.amount < priceCents / 100) return res.status(402).json({ error: "underpaid" });

    (req as any).payment = tx;
    return next();
  };
}

app.get("/tools/expensive", x402(5), async (_req, res) => {
  res.json({ result: "the expensive thing", cost: "$0.05" });
});

app.listen(3000);
```

a couple of notes on the real SDK shape. `MnemoPayLite.quick(id)` is the in-memory mode used for examples; in production swap for `MnemoPay.create({ agentId, db, redis })`. transaction `status` is `"completed"` after settle, not `"settled"` (I checked the source so you don't have to). there is no `charge.verify()` helper at the moment, so the server walks `history()` and matches by id; if you're handling more than a few hundred charges per minute keep your own index keyed by tx id or use the storage adapter directly.

## client: handling the 402

```ts
// client.ts
import { MnemoPayLite } from "@mnemopay/sdk";

const mp = await MnemoPayLite.quick("agent-buyer-001");

async function callTool(url: string) {
  let res = await fetch(url);

  if (res.status === 402) {
    const body = await res.json();
    const offer = body.accepts[0];

    const tx = await mp.charge(offer.amount, `tool:${offer.resource}`);
    await mp.settle(tx.id, offer.receiver);

    try {
      res = await fetch(url, { headers: { "X-Payment": tx.id } });
    } catch (err) {
      // network blip on retry: same tx.id, server treats it as the same payment
      res = await fetch(url, { headers: { "X-Payment": tx.id } });
    }
  }

  if (!res.ok) throw new Error(`tool failed: ${res.status}`);
  return res.json();
}

console.log(await callTool("http://localhost:3000/tools/expensive"));
```

idempotency falls out of the design here. the `tx.id` is stable for the lifetime of the charge; retrying with the same header is safe because the server's check is "does this completed tx cover the price?" and not "is this the first time I've seen this header?"

## where the agent credit score saves your ass

the obvious abuse pattern: an attacker spins up agents that hit your 402 endpoint, charge, immediately refund, charge, refund. each round forces your server to do real work even if no money settles. you become a free LLM amplifier for them.

MnemoPay ships an agent credit score (`AgentCreditScore`, exported from `@mnemopay/sdk`, range 300-850, deterministic across the five usual components: payment history, utilization, age, diversity, fraud record). the cheap version is `merchant.reputation()` which returns a 0-1 score and a tier. check it before you even bother emitting a 402.

```ts
const rep = await merchant.reputation();
if (rep.score < 0.6) {
  return res.status(403).json({ error: "reputation too low, retry in 1h" });
}
```

a 403 with a long Retry-After is much cheaper than a 402 plus a verify step, and it shifts the spam cost back onto the attacker: they have to build reputation before you'll even quote them a price.

## "but the agent doesn't have money" — ephemeral agent wallets

the parent (the human end user, or the orchestrator running on their behalf) pre-funds the agent's MnemoPay balance with a daily cap. the agent inherits the parent's reputation on first use through MnemoPay's `remember` and `reinforce` primitives, which carry behavioral history across the link. when the daily cap is hit, the agent's charges start failing locally before they ever reach your 402 endpoint, which is exactly the failure mode you want: budget enforcement at the wallet, not at the merchant.

this is why the x402 receiver field matters. you pin it server-side, the parent funds against it, and neither side has to trust the agent's runtime to be honest about who it's paying.

## gotchas

- check `tx.status === "completed"`, not `"pending"`. a pending charge is a promise, not a payment. (the SDK uses `completed`, not `settled`. I keep typing `settled` and getting bitten.)
- pin the receiver server-side. never read it from the request body or a query param. an attacker who can rewrite the receiver gets your tool for free and routes payment to themselves.
- rate-limit the 402 response itself. emitting 402 is cheap but not free, and an unauthenticated 402 endpoint can be abused as a reflective amplifier. one 402 per ip per second is plenty.
- add an idempotency key. if your tool has side effects, key them on the `X-Payment` header, not on the request body, so a retry never doubles up.
- log the `chargeId` alongside every served response. when you're reconciling at the end of the month or a customer disputes a charge, that's the only id that links the HTTP transaction to the ledger entry.

## try it today

```
npm install @mnemopay/sdk
```

- npm: https://www.npmjs.com/package/@mnemopay/sdk (current: 1.4.0)
- repo: https://github.com/mnemopay/mnemopay-sdk
- python: `pip install mnemopay` (1.0.0b1)

if you want this running in your MCP server by Monday and you'd rather not debug the verify path yourself, grab a slot at cal.com/jerryomiagbo/discovery. I'm running a $997 AI audit this month for teams who already have an agent in production and need the boring infrastructure (billing, reputation, fraud, audit trail) wired up before their next round; if that's you, mention "x402" in the booking and I'll skip the discovery half.

the LLM tokens are real money. the calls are real value. the only thing missing is a price tag the agent can read.
