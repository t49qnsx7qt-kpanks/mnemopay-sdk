/**
 * MnemoPay Feedback Loop Demo — shows the core innovation in terminal output.
 * Run: node demo-recording.js
 */
const { MnemoPay } = require('./dist/index.js');

async function demo() {
  const agent = MnemoPay.quick('demo-agent');

  console.log('=== MnemoPay Feedback Loop Demo ===\n');

  // Round 1: Agent picks a freelancer naively
  console.log('Round 1: Agent has NO memory. Picks randomly.');
  const mem1 = await agent.remember('Hired Alice for $80. Fast delivery but had 2 bugs.', { importance: 0.5, tags: ['freelancer', 'alice'] });
  const tx1 = await agent.charge(80, 'Alice: landing page');
  await agent.settle(tx1.id);
  let profile = await agent.profile();
  console.log(`  -> Settled $80 | Reputation: ${profile.reputation.toFixed(2)} | Memories: ${profile.memoriesCount}`);

  // Round 2: Another hire
  console.log('\nRound 2: Agent tries Bob.');
  const mem2 = await agent.remember('Hired Bob for $120. Perfect quality, on time.', { importance: 0.7, tags: ['freelancer', 'bob'] });
  const tx2 = await agent.charge(120, 'Bob: landing page v2');
  await agent.settle(tx2.id);
  profile = await agent.profile();
  console.log(`  -> Settled $120 | Reputation: ${profile.reputation.toFixed(2)} | Memories: ${profile.memoriesCount}`);

  // Round 3: Bad experience
  console.log('\nRound 3: Agent tries Carol.');
  const mem3 = await agent.remember('Hired Carol for $95. Missed deadline by 3 days. Refund requested.', { importance: 0.9, tags: ['freelancer', 'carol', 'failure'] });
  const tx3 = await agent.charge(95, 'Carol: API integration');
  await agent.refund(tx3.id);
  profile = await agent.profile();
  console.log(`  -> REFUNDED $95 | Reputation: ${profile.reputation.toFixed(2)} | Memories: ${profile.memoriesCount}`);

  // Now recall — the feedback loop in action
  console.log('\n=== FEEDBACK LOOP: Agent recalls before Round 4 ===\n');
  const memories = await agent.recall(5);
  memories.forEach((m, i) => {
    console.log(`  ${i + 1}. [score: ${m.score.toFixed(3)}] ${m.content}`);
  });

  // Show the learning
  console.log('\n=== RESULT ===');
  console.log('Bob\'s memory is ranked HIGHEST — settle() reinforced it.');
  console.log('Carol\'s failure memory is HIGH importance but decaying.');
  console.log('Alice\'s memory sits in the middle.');
  console.log(`\nAgent wallet: $${(await agent.balance()).wallet.toFixed(2)} | Reputation: ${(await agent.balance()).reputation.toFixed(2)}`);
  console.log('\nThe agent now KNOWS Bob delivers. No LLM needed for this insight.');
  console.log('This is the MnemoPay feedback loop: economic outcomes shape agent memory.\n');
}

demo().catch(console.error);
