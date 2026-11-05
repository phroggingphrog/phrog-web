<!-- phrog-development:start -->
Dev work: see ~/.agents/AGENTS.md. OpenSpec only for substantial changes (openspec skill, on demand).
<!-- phrog-development:end -->

# Phrog Web — Agent Guidelines

## 1. Project Principles
- **Language & Runtime**: TypeScript / Node.js (>=22.20), ES Modules (`type: "module"`).
- **Core Engine**: Fastify framework on port `8890`.
- **Zero-Symlink Rule**: All embedded dependencies and engines live inside `engines/` directly. Never create absolute host symlinks that break when cloned on another machine.
- **Secrets Policy**: Never commit `.env` or secret tokens. Keys are auto-loaded from `~/.config/phrog-web.env` or local `.env`.
- **Agnostic Design**: Keep tools and endpoints portable. Do not hardcode VPS-specific user paths in code.

---

## 2. Common Commands
```bash
# Install dependencies
pnpm install

# Compile TypeScript
npx tsc

# Start Gateway server (port 8890)
node dist/index.js

# Development mode with live reload
npx tsx watch src/index.ts

# Test MCP server directly over stdio
node dist/adapters/mcp/server.js
```

---

## 3. Directory Layout
- `src/config.ts`: Central configuration & env loader.
- `src/index.ts`: Fastify HTTP REST API.
- `src/providers/`:
  - `search.ts`: SearXNG + TinyFish + Consensus Academic.
  - `fetch.ts`: Plain Trafilatura + Crawl4AI + TinyFish Fetch.
  - `github.ts`: GitHub repo search (SearXNG + GitHub API fallback).
  - `deepwiki.ts`: DeepWiki streamable MCP HTTP client.
  - `research.ts`: quick research (search + one LLM pass) + Feynman background dispatcher.
- `src/wiki/`: Karpathy Agnostic LLM Wiki with `node:sqlite` vector search.
- `src/adapters/mcp/`: Stdio MCP Server.
- `src/adapters/schemas/`: Hermes / OpenAI function-calling JSON schemas.
- `engines/`: Cloned upstream engines (Feynman, Web Acquisition, scraper MCPs).
- `wiki/`: Default local Markdown vault.

---

## 4. Verification Check
Use checks proportional to the changed behavior. TypeScript changes require the relevant type/build check; questions and documentation-only changes do not require a build or live health check. Before a deployment claim, trace the owner-facing gateway and loaded revision, then exercise the requested action; `/health` proves health only. Commit only this task’s reviewed files when committing, preserving unrelated work. Follow the shared limit of three check/fix rounds.
