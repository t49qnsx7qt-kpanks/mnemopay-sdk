#!/usr/bin/env tsx
/**
 * Replay the retrieval + prompt assembly for ONE abstained question
 * where recall previously succeeded. Log the fully-rendered prompt that
 * would be sent to the generation model. Do not send it yet.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { MnemoPay } from "@mnemopay/sdk";
import type { LongMemEvalInstance, Turn } from "./types.js";

const TARGET_QID = process.argv[2] ?? "gpt4_76048e76";

const SYSTEM_PROMPT = `You are a helpful assistant with access to a user's conversation history. Your task is to answer questions about past conversations accurately and concisely.

Guidelines:
- Answer based ONLY on the provided conversation history context.
- If the context contains the answer, provide it directly and concisely.
- For temporal reasoning questions (e.g., "how many days between X and Y"), use the session dates provided in the context.
- For knowledge update questions, provide the MOST RECENT information from the context.
- For preference questions, reference the user's stated preferences from the context.
- If the question cannot be answered from the provided context, say so clearly — do NOT make up information.
- Keep answers concise. Do not explain your reasoning unless asked.`;

function formatSession(turns: Turn[], sessionId: string, date: string): string {
  const lines = [`[Session ${sessionId} — ${date}]`];
  for (const turn of turns) {
    const speaker = turn.role === "human" ? "User" : "Assistant";
    lines.push(`${speaker}: ${turn.content}`);
  }
  return lines.join("\n");
}

function chunkContent(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) return [content];
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > maxChars && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function main() {
  const dataset: LongMemEvalInstance[] = JSON.parse(
    readFileSync("data/longmemeval_s_cleaned.json", "utf-8")
  );
  const instance = dataset.find((d) => d.question_id === TARGET_QID);
  if (!instance) throw new Error(`Not found: ${TARGET_QID}`);

  const agentId = `probe-${instance.question_id}`;
  const agent = MnemoPay.quick(agentId, { recall: "hybrid" });

  console.log(`Ingesting ${instance.haystack_sessions.length} sessions...`);
  for (let i = 0; i < instance.haystack_sessions.length; i++) {
    const session = instance.haystack_sessions[i];
    const sessionId = instance.haystack_session_ids[i] ?? `session-${i}`;
    const date = instance.haystack_dates[i] ?? "unknown";
    const content = formatSession(session, sessionId, date);
    const chunks = chunkContent(content, 8000);
    for (const chunk of chunks) {
      await agent.remember(chunk, { tags: [`session:${sessionId}`, `date:${date}`] });
    }
  }

  console.log(`Recalling top 20 for: ${instance.question}`);
  const memories = await agent.recall(instance.question, 20);
  const context = memories.map((m) => m.content);

  const contextBlock = context.length > 0
    ? context.map((c, i) => `--- Retrieved Memory ${i + 1} ---\n${c}`).join("\n\n")
    : "(No relevant memories found)";

  const userPrompt = `Current date: ${instance.question_date}

Here are relevant excerpts from the user's conversation history:

${contextBlock}

Based on the above conversation history, please answer the following question:

${instance.question}`;

  const fullPrompt = `═══ SYSTEM ═══\n${SYSTEM_PROMPT}\n\n═══ USER ═══\n${userPrompt}`;

  writeFileSync("probe_prompt.txt", fullPrompt);
  console.log(`\nFull prompt (${fullPrompt.length} chars, ${context.length} memories retrieved):`);
  console.log(`Saved to probe_prompt.txt`);
  console.log(`Gold answer: ${JSON.stringify(instance.answer)}`);
  console.log(`Question type: ${instance.question_type}`);

  const goldLower = String(instance.answer).toLowerCase();
  const goldInPrompt = fullPrompt.toLowerCase().includes(goldLower);
  console.log(`Gold answer substring present in prompt: ${goldInPrompt}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
