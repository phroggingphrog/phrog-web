# Phrog Web

## Vision
A unified, agent-agnostic web intelligence and search hub with its own native HTTP API and pluggable agent adapters (MCP / tool schemas).

## Architecture
1. **HTTP REST Endpoints**:
   - `GET /api/search?q=...&mode=quick|live|deep`: Fast SearXNG aggregation + TinyFish fallback.
   - `POST /api/fetch`: Clean Markdown page extraction (Trafilatura + TinyFish Fetch for bot-protected URLs).
   - `POST /api/research`: Staged multi-hop research pipeline (Feynman & Vane engine).
2. **Pluggable Agent Adapter**:
   - Universal tool definition / schema ready to plug into Hermes, DSH, Claude Code, or any external agent.
3. **Dedicated Agent Browser (In-repo design)**:
   - Self-contained, agnostic browser agent module designed directly in this repository for standalone GitHub publishing.

## Personal discovery
Owner's words:
- "so for phrog web features that use social media, also the rss hub as well someo f the droped repo that we discuss before that need login"
- "it meant it could come from different profile sources but yeah it should be design for one user"
- "yes because I want to unified it and make it more centralised so hermes just can call the mcp to do discovery or something"

Scope: phrog-web serves one user (the owner) with many source accounts (Instagram, X, Spotify, Apple Music, RSS feeds). It owns collection, storage, ranking and feedback for personal discovery; Hermes calls an MCP tool and presents results. Personal tools need one owner token; existing anonymous tools are unchanged. The first slice moves Hermes' existing daily discovery cron into phrog-web. Plan: `docs/plans/personal-discovery-execution-plan.md`.
