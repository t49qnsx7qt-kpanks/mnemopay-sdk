# Linux Foundation reply — Christina Harter + Matt White

Reply to Christina Harter's 2026-04-??? loop-in email (see thread for date).
Christina's note was light ("apologies for delay, looping in Matt") — no
specific question asked yet. This reply matches that light-touch energy:
thanks her briefly, welcomes Matt, gives him just enough to react to.

Tone: cordial and a little understated. Not a deck, not a sales pitch.
Not pushy, not thirsty.

Recipients
- To: Christina Harter (reply in thread — address comes from her reply)
- Cc: Matt White (matt.white@linuxfoundation.org)

Subject — reply in-thread so mail clients keep it grouped with issue #5.

---

## Draft body

Hi Christina, and nice to meet you, Matt —

No apology needed, Christina — appreciate you looping Matt in. Totally get
the timing, foundation inboxes can't be easy this year.

Matt, happy to give you the shape of it in writing so you've got something
to look at whenever's convenient, and we can go deeper (or skip the call
entirely) depending on what's useful.

Quick recap of the proposal in issue #5, updated since Jerry's original
note: MnemoPay is a small open-source toolkit for agent builders. Original
framing was "MCP server for memory, micropayments, and trust scoring" —
that's still true, but the shape has filled out. It's now a TypeScript SDK
(and a Python port) with an MCP server on top, covering persistent memory
with Merkle-chained integrity, an identity registry that ties each agent to
a legal entity, a small payments layer, and a behavioral credit score
(300–850, modeled loosely on consumer FICO but built from behavioral
signals instead of financial ones). Apache 2.0 throughout. Live on npm as
@mnemopay/sdk, and the MCP server shows up in Smithery, ClawHub, and
mcpservers.org.

The reason it felt like an AAIF fit when I filed the proposal: none of the
primitives depend on a vendor. Everything runs in the caller's process,
works behind any model, and already has live integrations with CrewAI,
LangGraph, Mastra, AutoGen, ElizaOS, Goose, Hermes, and the OpenAI Agents
SDK. Neutrality gets more important as this stuff starts acting like
infrastructure, and I'd rather it sit under a foundation than under a
company — mine included.

Where we are on proof: 672 tests across the recall engine, credit scoring,
behavioral finance, Merkle integrity, anomaly detection. An independent
legal review in April closed out the P0s and most P1s. There's a live
playground at https://mnemopay-playground.fly.dev if it's easier to poke
at `remember` / `recall` without installing anything. And the Agent Credit
Score piece is probably the part most AAIF-relevant folks would want to
look at first — happy to send that spec as a single doc if useful.

Whatever's easiest on your side is fine by me — a 30-min technical call,
written back-and-forth in the issue thread, or just a nudge on what AAIF
process I should be following (architecture template, review cadence,
anything I missed). No rush on timing; your calendar is the anchor.

Also — still hanging around the AAIF Discord whenever it's the right
channel for something smaller.

Thanks again,

Jerry
Founder, MnemoPay (J&B Enterprise LLC · Dallas, TX)
jeremiah@getbizsuite.com
Repo: github.com/mnemopay/mnemopay-sdk
Proposal: github.com/aaif/project-proposals/issues/5

---

## Before sending

- Reply in-thread. Don't rewrite the subject.
- Cc Matt using matt.white@linuxfoundation.org.
- No attachments — links only.
- Last line of Jerry's original ("Sent from my iPhonekhbhhv") can be
  ignored; typo in the original, not relevant to the reply.
