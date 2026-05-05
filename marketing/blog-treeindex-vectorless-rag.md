# vectorless RAG, in 500 lines of typescript

i shipped TreeIndexKnowledgeBase to `@kpanks/knowledge` this week. it's a
native-typescript port of [VectifyAI's PageIndex](https://github.com/VectifyAI/PageIndex)
(MIT, python). the pitch is the same: no embeddings, no chunking, no vector
DB, no similarity search. the agent walks the document's heading tree like
a human reading the regulation, picking which section to descend into at
every level.

PageIndex hit 98.7% on FinanceBench. classic vector RAG lands 30-50%. the
gap is that real long documents — 10-Ks, EU regulations, internal SOPs —
have a structure that vector chunking destroys.

## the part nobody mentions

the praetor doctrine is "every native tool, third-party libs only as
fallback." so even though PageIndex is great, taking a hard dependency
on the python package would have meant a python sidecar in every charter
that wanted to use it. that's not a wedge. that's a tax.

the algorithm is small enough to port. ~500 lines including doc comments
and tests. zero deps beyond node 20. ships behind the same interface as
the bigram + mnemopay-recall backends, so any charter can A/B between
them without rewriting prompts.

## the api surface

```ts
import {
  TreeIndexKnowledgeBase,
  makeKeywordTreeIndexLlm,
} from "@kpanks/knowledge";

const kb = new TreeIndexKnowledgeBase(makeKeywordTreeIndexLlm());

await kb.ingest([
  { id: "eu-ai-act", text: regulationMarkdown, source: "Regulation 2024/1689" },
]);

const [hit] = await kb.query("how long must logs be kept under the AI Act?", 1);

console.log(hit.chunk.metadata.title);   // "12.2 — Retention period"
console.log(hit.chunk.metadata.trail);
// [ "eu-ai-act", "EU AI Act", "Article 12 — Record-keeping", "12.2 — Retention period" ]
console.log(hit.chunk.text);
// the whole 12.2 subsection, with descendants if the section has nested rules
```

`makeKeywordTreeIndexLlm` is a deterministic stop-word-aware chooser, useful
as a default and as a test fixture. for production you swap in an anthropic
or openai adapter via the `TreeIndexLlm` interface — one method, takes a
question + the current trail + a list of pickable child sections, returns
the chosen index. ~30 lines of adapter code, no SDK lock-in.

## the demo

i wrote a runnable example that ingests an actual EU AI Act excerpt
(Articles 12, 13, 14, 15, 17 — record-keeping, transparency, human
oversight, cybersecurity, quality management) and asks five compliance
questions. with the deterministic chooser, all five route correctly:

```
Q: how long must logs be kept under the AI Act?
Section: 12.1 — Logging requirements

Q: what information must instructions for use contain?
Section: 13.2 — Required information

Q: what does human oversight require operators to be able to do?
Section: 14.4 — Oversight measures

Q: what does Article 15 require about cybersecurity?
Section: 15.4 — Cybersecurity

Q: does the AI Act require a quality management system?
Section: Article 17 — Quality management system
```

the agent didn't just retrieve text — it returned the trail it took to
get there. that's the part that matters for compliance: an auditor can
see why the agent answered the way it did. vector RAG can't do that.
chunks have no parent.

## tradeoffs (honest version)

vector RAG is not dead. tree walking is the right shape for **long
structured documents with a real heading hierarchy**. that's a real
slice of the world (regulations, financial filings, SOPs, internal
policies, technical manuals). it's not the whole world.

- **cost:** a tree walk is N LLM calls, one per level descended. plan on
  100-500× the cost of a single embedding lookup. use it when "agent
  reads a 100-page doc and answers correctly" matters more than
  per-query latency.
- **scale:** great for 1-100 documents per agent. for 10K+ docs you
  still want vector preselection, then tree-walk inside the top-K hits.
- **unstructured input:** scraped HTML with no heading hierarchy
  degrades to "the whole doc is one giant section." don't use it there.
- **freshness:** ingestion is just markdown parsing. re-ingesting a
  changed regulation is a single function call — no embedding job,
  no vector store reindex.

## what shipped

| | |
|---|---|
| package | `@kpanks/knowledge` |
| repo | [github.com/mnemopay/praetor](https://github.com/mnemopay/praetor) |
| commit | `3d01614` |
| tests | 36 passing (knowledge package), 591 across the workspace |
| license | Apache-2.0 |
| inspiration | PageIndex (MIT) — VectifyAI |

both the in-memory bigram backend and the mnemopay-recall backend stay
in the box. picking the right backend per charter is now a real choice
instead of a forced one.

## what's next

- mnemopay MCP tools `ingest_document` + `recall_from_doc` so any
  agent on the MCP bus can use tree-walk recall over its own uploaded
  docs without writing any praetor code.
- a tree-vs-vector benchmark over a FinanceBench-equivalent set so we
  publish our numbers, not someone else's.
- a real anthropic adapter for the chooser so the demo runs end-to-end
  with a sonnet 4.6 that actually reads the section.

if you've got a doc-heavy agent use case — compliance review, contract
QA, internal-policy lookups — try it. one ingest call, one query. let
me know what breaks.

— jeremiah
[mnemopay.com](https://mnemopay.com) · [praetor on github](https://github.com/mnemopay/praetor)
