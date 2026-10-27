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
