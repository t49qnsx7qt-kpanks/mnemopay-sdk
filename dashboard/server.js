/**
 * MnemoPay Live Dashboard Server
 * REST API backed by the real SDK + GitHub repo monitoring
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 3200;
const GITHUB_USER = process.env.GITHUB_USER || 't49qnsx7qt-kpanks';
const GH_CLI = process.env.GH_CLI || 'C:/Program Files/GitHub CLI/gh';

// ── Initialize the real SDK ─────────────────────────────────────────────────
let agent;
try {
  const SDK = require('../dist/index.js');
  agent = SDK.MnemoPay.quick(process.env.MNEMOPAY_AGENT_ID || 'dashboard-live');
  console.log('[sdk] MnemoPayLite initialized (live mode)');
} catch (e) {
  console.error('[sdk] Failed to load SDK:', e.message);
  console.log('[sdk] Falling back to inline implementation');
  // Minimal fallback if dist isn't built
  agent = createFallbackAgent();
}

function createFallbackAgent() {
  const memories = new Map();
  const transactions = new Map();
  const auditLog = [];
  let wallet = 0, reputation = 0.5;

  function uuid() { return crypto.randomUUID(); }
  function autoScore(c) {
    let s = 0.5;
    if (c.length > 200) s += 0.1;
    if (/error|fail|crash|critical|bug/i.test(c)) s += 0.2;
    if (/success|complete|paid|delivered/i.test(c)) s += 0.15;
    if (/prefer|always|never|important|must/i.test(c)) s += 0.15;
    return Math.min(s, 1.0);
  }
  function computeScore(imp, lastAcc, accCnt, decay = 0.05) {
    const hrs = (Date.now() - new Date(lastAcc).getTime()) / 3600000;
    return imp * Math.exp(-decay * hrs) * (1 + Math.log(1 + accCnt));
  }

  return {
    agentId: 'dashboard-live',
    async remember(content, opts = {}) {
      const importance = opts.importance ?? autoScore(content);
      const id = uuid();
      const now = new Date();
      memories.set(id, { id, agentId: 'dashboard-live', content, importance: Math.min(Math.max(importance, 0), 1), score: importance, createdAt: now, lastAccessed: now, accessCount: 0, tags: opts.tags || [] });
      auditLog.push({ id: uuid(), agentId: 'dashboard-live', action: 'memory:stored', details: { id, content: content.slice(0, 100), importance }, createdAt: now });
      return id;
    },
    async recall(queryOrLimit, maybeLimit) {
      const limit = typeof queryOrLimit === 'number' ? queryOrLimit : (maybeLimit ?? 5);
      const all = Array.from(memories.values()).map(m => { m.score = computeScore(m.importance, m.lastAccessed, m.accessCount); return m; });
      all.sort((a, b) => b.score - a.score);
      const results = all.slice(0, limit);
      results.forEach(m => { m.lastAccessed = new Date(); m.accessCount++; });
      return results;
    },
    async forget(id) { return memories.delete(id); },
    async reinforce(id, boost = 0.1) {
      const m = memories.get(id); if (!m) return false;
      m.importance = Math.min(m.importance + boost, 1.0); m.lastAccessed = new Date();
      auditLog.push({ id: uuid(), agentId: 'dashboard-live', action: 'memory:reinforced', details: { id, boost }, createdAt: new Date() });
      return true;
    },
    async consolidate() {
      let pruned = 0;
      for (const [id, m] of memories) { if (computeScore(m.importance, m.lastAccessed, m.accessCount) < 0.01) { memories.delete(id); pruned++; } }
      return pruned;
    },
    async charge(amount, reason) {
      const id = uuid(); const tx = { id, agentId: 'dashboard-live', amount, reason, status: 'pending', createdAt: new Date() };
      transactions.set(id, tx);
      auditLog.push({ id: uuid(), agentId: 'dashboard-live', action: 'payment:pending', details: { id, amount, reason }, createdAt: new Date() });
      return { ...tx };
    },
    async settle(txId) {
      const tx = transactions.get(txId); if (!tx || tx.status !== 'pending') return null;
      tx.status = 'completed'; tx.completedAt = new Date();
      wallet += tx.amount; reputation = Math.min(reputation + 0.01, 1.0);
      const oneHourAgo = Date.now() - 3600000; let reinforced = 0;
      for (const m of memories.values()) { if (new Date(m.lastAccessed).getTime() > oneHourAgo) { m.importance = Math.min(m.importance + 0.05, 1.0); reinforced++; } }
      auditLog.push({ id: uuid(), agentId: 'dashboard-live', action: 'payment:completed', details: { id: txId, amount: tx.amount, reinforced }, createdAt: new Date() });
      return { ...tx };
    },
    async refund(txId) {
      const tx = transactions.get(txId); if (!tx) return null;
      if (tx.status === 'completed') { wallet = Math.max(wallet - tx.amount, 0); reputation = Math.max(reputation - 0.05, 0); }
      tx.status = 'refunded';
      auditLog.push({ id: uuid(), agentId: 'dashboard-live', action: 'payment:refunded', details: { id: txId, amount: tx.amount }, createdAt: new Date() });
      return { ...tx };
    },
    balance() { return { wallet, reputation }; },
    profile() { return { id: 'dashboard-live', reputation, wallet, memoriesCount: memories.size, transactionsCount: transactions.size }; },
    logs(limit = 30) { return auditLog.slice(-limit).reverse(); },
    history(limit = 20) { return Array.from(transactions.values()).reverse().slice(0, limit); },
  };
}

// ── GitHub repo cache ───────────────────────────────────────────────────────
let repoCache = { data: null, lastFetch: 0 };
const REPO_CACHE_TTL = 60_000; // 1 minute

const MONITORED_REPOS = [
  { upstream: 'coinbase/agentkit', fork: `${GITHUB_USER}/agentkit`, branch: 'feat/mnemopay-action-provider' },
  { upstream: 'elizaOS/eliza', fork: `${GITHUB_USER}/eliza`, branch: 'feat/plugin-mnemopay' },
  { upstream: 'mastra-ai/mastra', fork: `${GITHUB_USER}/mastra`, branch: 'feat/mnemopay-integration' },
  { upstream: 'coinbase/x402', fork: `${GITHUB_USER}/x402`, branch: 'feat/mnemopay-middleware' },
  { upstream: 'Xiaoher-C/agentbnb', fork: `${GITHUB_USER}/agentbnb`, branch: 'feat/mnemopay-adapter' },
];

async function fetchRepoStatus() {
  if (Date.now() - repoCache.lastFetch < REPO_CACHE_TTL && repoCache.data) return repoCache.data;

  const results = [];
  for (const repo of MONITORED_REPOS) {
    try {
      // Get fork info
      const forkJson = execSync(`"${GH_CLI}" repo view ${repo.fork} --json name,stargazerCount,updatedAt,url,description `, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
      const fork = JSON.parse(forkJson);

      // Get upstream stars
      let upstreamStars = 0;
      try {
        const upJson = execSync(`"${GH_CLI}" repo view ${repo.upstream} --json stargazerCount `, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
        upstreamStars = JSON.parse(upJson).stargazerCount;
      } catch (e) {}

      // Get PR status
      let pr = null;
      try {
        const prJson = execSync(`"${GH_CLI}" pr list --repo ${repo.upstream} --author ${GITHUB_USER} --json number,title,state,url,createdAt,reviews,statusCheckRollup --limit 1 `, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
        const prs = JSON.parse(prJson);
        if (prs.length > 0) pr = prs[0];
      } catch (e) {}

      // Also check PRs on own fork
      if (!pr) {
        try {
          const prJson = execSync(`"${GH_CLI}" pr list --repo ${repo.fork} --json number,title,state,url,createdAt --limit 1 `, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
          const prs = JSON.parse(prJson);
          if (prs.length > 0) pr = prs[0];
        } catch (e) {}
      }

      results.push({
        name: repo.upstream,
        fork: repo.fork,
        branch: repo.branch,
        forkUrl: fork.url,
        upstreamStars,
        forkStars: fork.stargazerCount,
        updatedAt: fork.updatedAt,
        description: fork.description,
        pr: pr ? { number: pr.number, title: pr.title, state: pr.state, url: pr.url, createdAt: pr.createdAt } : null,
        status: pr ? (pr.state === 'MERGED' ? 'merged' : pr.state === 'OPEN' ? 'pr-open' : 'pr-closed') : 'forked',
      });
    } catch (e) {
      results.push({ name: repo.upstream, fork: repo.fork, branch: repo.branch, status: 'error', error: e.message });
    }
  }

  repoCache = { data: results, lastFetch: Date.now() };
  return results;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

// ── Server ──────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── API Routes ──────────────────────────────────────────────────────────

  // Memories
  if (pathname === '/api/memories' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const query = url.searchParams.get('q');
    const memories = query ? await agent.recall(query, limit) : await agent.recall(limit);
    return json(res, memories);
  }

  if (pathname === '/api/memories' && req.method === 'POST') {
    const body = await readBody(req);
    const id = await agent.remember(body.content, { importance: body.importance, tags: body.tags });
    return json(res, { id, status: 'stored' }, 201);
  }

  if (pathname.startsWith('/api/memories/') && req.method === 'DELETE') {
    const id = pathname.split('/')[3];
    const deleted = await agent.forget(id);
    return json(res, { deleted });
  }

  if (pathname === '/api/memories/reinforce' && req.method === 'POST') {
    const body = await readBody(req);
    await agent.reinforce(body.id, body.boost || 0.1);
    return json(res, { reinforced: true });
  }

  if (pathname === '/api/memories/consolidate' && req.method === 'POST') {
    const pruned = await agent.consolidate();
    return json(res, { pruned });
  }

  // Payments
  if (pathname === '/api/charge' && req.method === 'POST') {
    const body = await readBody(req);
    const tx = await agent.charge(body.amount, body.reason);
    return json(res, tx, 201);
  }

  if (pathname === '/api/settle' && req.method === 'POST') {
    const body = await readBody(req);
    const tx = await agent.settle(body.txId);
    return json(res, tx || { error: 'Transaction not found or not pending' });
  }

  if (pathname === '/api/refund' && req.method === 'POST') {
    const body = await readBody(req);
    const tx = await agent.refund(body.txId);
    return json(res, tx || { error: 'Transaction not found' });
  }

  // Profile & status
  if (pathname === '/api/profile' && req.method === 'GET') {
    const profile = await agent.profile();
    return json(res, profile);
  }

  if (pathname === '/api/balance' && req.method === 'GET') {
    const balance = await agent.balance();
    return json(res, balance);
  }

  if (pathname === '/api/history' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const history = await agent.history(limit);
    return json(res, history);
  }

  if (pathname === '/api/logs' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '30');
    const logs = await agent.logs(limit);
    return json(res, logs);
  }

  // GitHub repos
  if (pathname === '/api/repos' && req.method === 'GET') {
    try {
      const repos = await fetchRepoStatus();
      return json(res, repos);
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // Health
  if (pathname === '/healthz') {
    return json(res, { status: 'ok', mode: 'live', agentId: agent.agentId || 'dashboard-live' });
  }

  // ── Static files ────────────────────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // 404
  json(res, { error: 'Not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`\n  MnemoPay Live Dashboard`);
  console.log(`  ────────────────────────`);
  console.log(`  URL:     http://localhost:${PORT}`);
  console.log(`  Agent:   ${agent.agentId || 'dashboard-live'}`);
  console.log(`  Mode:    Live (real SDK)`);
  console.log(`  API:     /api/memories, /api/charge, /api/settle, /api/repos`);
  console.log(`  Repos:   ${MONITORED_REPOS.length} monitored\n`);
});
