## Context
Phrog Web owns search and adjacent public discovery sources. TASK-367 moves multi-engine search out of the DSH plugin while retaining the plugin as a thin client and keeping existing Phrog Web discovery capabilities.

## Goals / Non-Goals
- Make one shared search implementation available to Phrog Web MCP and authenticated HTTP callers.
- Preserve existing MCP compatibility inputs and response semantics while using the shared engine.
- Make DSH search use authenticated Phrog Web API rather than orchestrating providers locally.
- Preserve unrelated DSH tools and Phrog Web feed/social/vertical provider features.
- Do not deploy or change production runtime configuration.

## Decisions
- HTTP contract: POST /v1/search, bearer authentication using PHROG_WEB_SEARCH_API_KEY, body { query, options }; return structured shared-core result and meaningful non-2xx errors.
- Shared search core owns provider selection, fallback, normalization, ranking, deduplication and cache. Explicit provider selection must not silently fall back.
- Keep legacy MCP web_search arguments and mapping compatible while delegating to the shared core.
- DSH adapts HTTP response into the existing tool-facing shape; fetch/research/domain and unrelated tools remain unchanged.

## Risks / Trade-offs
- Local provider settings configure Phrog service; DSH client config must distinguish endpoint URL and API key from provider secrets.
- Local tests verify contract and adapter behavior but cannot prove production credentials/runtime configuration; no deployment is authorized.

## Open Questions
None for scoped implementation. Production endpoint/key provisioning and release remain outside this change and require separate approval.
