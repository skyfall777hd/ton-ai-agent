# TON AI Agent

TON mini app and web client for AI-assisted wallet actions on TON.

The project combines a chat interface, TON Connect wallet onboarding, lightweight intent parsing, MCP-style wallet access over HTTP, and execution planning for actions like balance checks, transfers, swaps, and username price lookups.

## What This Project Does

- Telegram Mini App style frontend built with Next.js App Router
- Chat-based TON assistant with English-first user-facing copy
- TON Connect wallet integration
- Wallet portfolio lookup for TON and jettons
- Execution planning for:
  - `balance`
  - `send`
  - `swap`
  - `sell`
  - `buy`
  - `username_price`
  - `nft`
- Local HTTP wallet MCP endpoint exposed by the app itself
- TON Docs MCP compatibility hooks for hackathon workflows
- OpenAI-powered fallback parsing and reply generation when configured

## Architecture

The app has three main layers:

1. Client UI in `src/components` and `src/app`
2. Chat and execution logic in `src/lib`
3. Server routes in `src/app/api`

Key routes:

- `/` main chat UI
- `/probe` simple health/probe page
- `/api/chat` assistant entrypoint
- `/api/wallet-balance` wallet balance helper endpoint
- `/api/wallet-mcp` HTTP MCP-style wallet endpoint
- `/api/ton-connect-manifest.json` TON Connect manifest

Key library modules:

- `src/lib/agent.ts` request parsing, conversation state, reply generation
- `src/lib/execution.ts` swap / transfer planning
- `src/lib/wallet-mcp.ts` wallet MCP client adapter
- `src/lib/mcp.ts` TON MCP profile and capability helpers

## Quickstart

Prerequisites:

- Node.js 20+
- npm
- TON wallet for end-to-end manual testing
- Optional: OpenAI API key for stronger parsing and response generation

Install and run:

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

If port `3000` is busy, Next.js will automatically pick another port in development.

## Environment Variables

Core app settings:

- `NEXT_PUBLIC_APP_URL` public base URL of the deployed app
- `NEXT_PUBLIC_TON_CONNECT_MANIFEST_URL` public URL to the TON Connect manifest
- `NEXT_PUBLIC_TWA_RETURN_URL` Telegram bot or Mini App return URL

AI settings:

- `OPENAI_API_KEY` enables OpenAI-backed parsing and response generation
- `OPENAI_MODEL` model name used for OpenAI requests

TON / MCP settings:

- `TON_HACKATHON_MODE=true` enables hackathon-oriented framing in responses
- `TON_DOCS_MCP_URL=https://docs.ton.org/mcp` endpoint for TON Docs MCP
- `TON_MCP_HTTP_URL=http://localhost:3000/api/wallet-mcp` wallet MCP HTTP endpoint
- `TON_API_ENDPOINT` TON JSON-RPC endpoint
- `TON_API_KEY` optional API key for TON API provider
- `TON_API_V3_JETTON_WALLETS_ENDPOINT` custom jetton wallets endpoint
- `TON_API_V3_JETTON_MASTERS_ENDPOINT` custom jetton masters endpoint
- `JETTON_ALIASES_JSON` optional symbol/name overrides for jettons

## Supported User Intents

Examples of supported requests:

- `show my balance`
- `how much TON do I have`
- `send 1 TON to ...`
- `swap 3 TON to USDT`
- `sell 10 TON`
- `buy 50 USDT`
- `how much does @username cost`

The assistant can:

- infer action and token pair from natural language
- detect whether a wallet is required
- prepare execution payloads for wallet confirmation
- return user-facing error messages for external service failures

## API Surface

### `POST /api/chat`

Main assistant endpoint.

Request shape:

```json
{
  "message": "swap 3 TON to USDT",
  "walletAddress": "EQ...",
  "walletConnected": true,
  "history": []
}
```

Returns a JSON payload with fields such as:

- `text`
- `intent`
- `execution`
- `portfolio`
- `understanding`
- `error`

### `GET|POST /api/wallet-mcp`

HTTP MCP-style endpoint for wallet-oriented capabilities, including portfolio lookup and transaction preparation.

### `GET /probe`

Simple probe endpoint useful for deployment and reverse proxy checks.

## Local Development Notes

- The project uses Next.js App Router
- `npm run dev` starts the development server
- `npm run build` creates a production build
- `npm start` runs the production server

Production PM2 example is included in [ecosystem.config.cjs](/root/ton-ai/ecosystem.config.cjs).

## Deployment

This repo is currently configured for a reverse-proxy deployment pattern:

- Next.js app runs on an internal port
- nginx proxies the public domain to that internal port
- PM2 can be used to keep the production process alive

Typical production flow:

```bash
npm install
npm run build
pm2 start ecosystem.config.cjs --only onlys
pm2 save
```

## Current Status

This is an MVP / hackathon-stage project with a functional product slice already in place:

- working chat UI
- wallet connect flow
- balance lookup
- swap / transfer preparation
- TON username price lookup
- MCP-compatible wallet endpoint inside the app

## Known Gaps

- richer on-chain confirmation UX with slippage, min received, and fee breakdown
- clearer routing between direct wallet actions and external swap tooling
- more explicit fallback handling for upstream TON and OpenAI failures
- stronger automated test coverage
- fuller deployment and troubleshooting docs

## Security Notes

- Do not commit real `OPENAI_API_KEY` values
- Keep TON API keys and wallet-related credentials out of the repository
- Review public deployment env files and logs for leaked secrets

## Useful Checks

Health check:

```bash
curl http://127.0.0.1:3000/probe
```

Production build:

```bash
npm run build
```

## Next Improvements For This README

- add screenshots of the chat and wallet flows
- document exact MCP methods exposed by `/api/wallet-mcp`
- add example response payloads for `/api/chat`
- add a short architecture diagram
