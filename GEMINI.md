# MnemoPay SDK - Context & Instructions

MnemoPay is a comprehensive trust and reputation layer for AI agents, providing Agent Credit Scoring (300-850), behavioral finance, payments, and tamper-evident memory.

## Project Overview

- **Purpose**: Unified SDK for agent identity (KYA), credit scoring, secure payments (Stripe, Paystack, Lightning), and cognitive memory.
- **Architecture**: Modular TypeScript design in `src/`.
  - `fico.ts`: Agent Credit Score calculation.
  - `behavioral.ts`: Nobel-laureate inspired behavioral economics for agents.
  - `integrity.ts`: Merkle-tree based memory verification.
  - `anomaly.ts`: EWMA and canary-based compromise detection.
  - `ledger.ts`: Double-entry, hash-chained financial ledger.
  - `mcp/`: Model Context Protocol server implementation.
- **Modes**: 
  - `MnemoPay.quick()`: Zero-infra, in-memory mode for dev/testing.
  - `MnemoPay.create()`: Production mode with durable storage and real payment rails.

## Building and Running

- **Install Dependencies**: `npm install`
- **Build**: `npm run build` (compiles TS to `dist/`)
- **Test**: `npm test` (runs Vitest suite with 670+ tests)
- **Lint/Type-Check**: `npm run lint`
- **MCP Server**: Run via `mnemopay-mcp` binary or `node dist/mcp/server.js`.

## Development Conventions

- **Technical Integrity**: 
  - NEVER use string amounts for currency; always use numbers (2-decimal precision).
  - Always pair `charge()` with `settle()` or `refund()`.
  - Use `MnemoPay.quick()` for unit tests to avoid external dependencies.
- **Testing**:
  - All new features MUST include tests in `tests/` mirroring the `src/` structure.
  - Run `npm test` before any commit.
  - Stress tests (e.g., `stress-200k.test.ts`) should be run for core ledger changes.
- **Security**:
  - Respect the `sanitizeMemoryContent` logic to prevent prompt injection.
  - Always use constant-time equality for sensitive comparisons (e.g., `constantTimeEqual` in `identity.ts`).
- **Styling**:
  - Follow the Stripe-inspired design system detailed in `DESIGN.md` for any UI/web work.
  - Use `sohne-var` font with `"ss01"` and weight 300 for headlines.

## Key Files

- `src/index.ts`: Main entry point and SDK factory.
- `src/client.ts`: REST client for remote MnemoPay services.
- `DESIGN.md`: Deep dive into the visual and typographic system.
- `CLAUDE.md`: High-level summary of architecture and "Don'ts".
