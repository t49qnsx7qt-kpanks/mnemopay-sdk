# MnemoPay for Huawei AgentArts

Connect MnemoPay to Huawei's [AgentArts](https://www.huaweicloud.com/intl/en-us/product/pangulargemodels.html) platform as an MCP service.

## How It Works

AgentArts natively supports MCP services. MnemoPay registers as an SSE endpoint that any AgentArts agent or workflow can call. No custom plugin needed.

## Registration

### Step 1: Deploy MnemoPay MCP Server

Deploy to any cloud provider with an SSE endpoint:

```bash
# Fly.io (recommended for global edge deployment)
fly launch --name mnemopay-mcp
fly secrets set MNEMOPAY_MODE=production MNEMOPAY_AGENT_ID=huawei-agent

# Or Docker
docker run -p 3100:3100 -e MNEMOPAY_MODE=quick mnemopay/sdk
```

The server exposes `https://your-server.fly.dev/mcp` as an SSE endpoint.

### Step 2: Register in AgentArts

1. Navigate to **Agent Dev > Workstation > Component Library**
2. Select the **MCP Service** tab
3. Click **Create MCP Service**
4. Fill in:
   - **MCP Service Name:** MnemoPay
   - **English Name:** mnemopay
   - **MCP Service Address:** `https://your-server.fly.dev/mcp` (HTTPS required)
   - **Authorization:** API Key (set in header `X-API-Key`)
5. Click **Test and Next** to verify connectivity
6. Click **OK**

### Step 3: Use in Agents or Workflows

In the AgentArts workflow designer:
1. Add an **MCP Service** node
2. Select **mnemopay** from Personal Services
3. Choose the tool (remember, recall, charge, settle, etc.)
4. Wire input/output parameters to other nodes

## FinAgent Booster Compatibility

Huawei's FinAgent Booster uses 150+ modular components (MCPs). MnemoPay slots in as a trust and memory MCP:

| FinAgent Component | MnemoPay Tool | Purpose |
|-------------------|---------------|---------|
| Customer memory | `remember`, `recall` | Remember customer interactions across sessions |
| Transaction trust | `charge`, `settle` | Escrow with reputation-gated amounts |
| Fraud screening | Automatic | 10-signal fraud detection on every charge |
| Agent reputation | `reputation` | Trust tier for multi-agent coordination |
| Audit trail | `logs`, `history` | Immutable record of all operations |

### Example: Banking Agent with Memory

```
Workflow: Customer Support Agent
├── Node 1: MCP Service (mnemopay) → recall("customer:{phone}")
├── Node 2: LLM → Generate response using recalled context
├── Node 3: MCP Service (mnemopay) → remember("customer:{phone} asked about {topic}")
└── Node 4: MCP Service (mnemopay) → charge(0.01, "support session")
```

## A2A-T Integration

Huawei's A2A-T protocol (IG1453) enables agent-to-agent collaboration in telecom networks. MnemoPay can serve as the trust layer:

- **Registry Center:** MnemoPay agents register with reputation scores
- **Orchestration Center:** Workflows use MnemoPay for inter-agent escrow
- **Settlement:** charge/settle between agents in multi-step workflows

This is experimental — A2A-T SDK is still in early release. Watch for the open-source components.

## KooGallery Publishing

MnemoPay can be listed on [KooGallery](https://marketplace.huaweicloud.com/) as a SaaS service:

**Requirements:**
- Enterprise account on Huawei Cloud
- HCPN (Huawei Cloud Partner Network) membership
- 1+ pre-sales and 1+ post-sales personnel
- 8/5 support availability

**Revenue share:** Flexible ratio negotiated with Huawei Cloud.

**Available in:** 79 countries including Nigeria, Kenya, South Africa, Egypt, Ghana, and 20+ other African nations.

### Geographic Strategy

KooGallery is available across Africa and Asia — markets where MnemoPay's AI agent payment infrastructure has the highest growth potential. This aligns with Huawei's strong presence in African mobile infrastructure.

## US Entity Considerations

KooGallery does not currently list the United States in its service availability regions. Strategy options:

1. **Open-source distribution:** Publish MnemoPay MCP server as open-source. Huawei developers self-deploy via `npx @mnemopay/sdk`. No marketplace dependency.

2. **SSE endpoint:** Any AgentArts user worldwide can register MnemoPay via its SSE URL. No geographic restriction on MCP service registration.

3. **Partner entity:** If KooGallery listing is desired, a non-US entity (e.g., Nigerian subsidiary) can register as the seller.

**Recommended approach:** Option 1 (open-source) + Option 2 (SSE) covers the entire Huawei developer ecosystem without marketplace dependency.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MNEMOPAY_AGENT_ID` | `mcp-agent` | Unique agent identifier |
| `MNEMOPAY_MODE` | `quick` | `quick` or `production` |
| `MNEMOPAY_HTTP_PORT` | `3100` | SSE server port |
| `MNEMOPAY_API_KEY` | — | API key for authenticated access |

## License

MIT
