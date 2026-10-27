<!-- phrog-development:start -->
For development, read `/home/phroggingphrog/.dsh/profiles/vanilla/node_modules/phrog-development/skills/using-phrog-development/SKILL.md`
and `/home/phroggingphrog/.agents/AGENTS.md`. Use automatic upstream OpenSpec routing for substantial changes; small fixes and questions need no new spec or setup.
Reuse existing authorization and the current project workspace before creating isolation. New worktrees belong under `~/projects/.worktrees/` through the host's workspace tools; a worktree never authorizes another deployment.
Shared server workflow controls older workflow text below; retain repository product, security and contribution requirements. Backlog owns overall server work status; private GitHub repositories retain their issue tracking without duplicate tickets. Verify the owner's actual deployment before claiming live or fixed.
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
  - `research.ts`: Vane quick research + Feynman background dispatcher.
- `src/wiki/`: Karpathy Agnostic LLM Wiki with `node:sqlite` vector search.
- `src/adapters/mcp/`: Stdio MCP Server.
- `src/adapters/schemas/`: Hermes / OpenAI function-calling JSON schemas.
- `engines/`: Cloned upstream engines (Feynman, Vane, Web Acquisition).
- `wiki/`: Default local Markdown vault.

---

## 4. Verification Check
Use checks proportional to the changed behavior. TypeScript changes require the relevant type/build check; questions and documentation-only changes do not require a build or live health check. Before a deployment claim, trace the owner-facing gateway and loaded revision, then exercise the requested action; `/health` proves health only. Commit only this task’s reviewed files when committing, preserving unrelated work. Follow the shared limit of three check/fix rounds.
