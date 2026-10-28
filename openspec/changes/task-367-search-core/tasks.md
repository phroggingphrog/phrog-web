## 1. Shared Phrog Web Search Contract
- [x] 1.1 Route REST and MCP search through the shared multi-engine core with documented normalization, ranking, deduplication, cache, and failure behavior.
- [x] 1.2 Expose authenticated structured HTTP search with input validation and consistent success/error responses.
- [x] 1.3 Preserve Phrog Web social, feed, and discovery source features and compatibility response contracts.

## 2. DSH Authenticated Client
- [ ] 2.1 Add configurable Phrog Web endpoint and credential settings without exposing secrets.
- [ ] 2.2 Replace local engine orchestration for DSH search tools with authenticated requests; preserve tool-facing result shape and cancellation/error handling.
- [ ] 2.3 Cover HTTP client auth, request options, response mapping, and failures with tests.

## 3. Verification and Integration
- [x] 3.1 Add regression coverage for provider selection, empty results, unsupported providers, route authorization, validation, and upstream failure.
- [x] 3.2 Run TypeScript checks and relevant/full test suites; review diff and confirm merge target before integration.
- [ ] 3.3 Commit and merge only scoped TASK-367 changes into the confirmed local target; do not deploy.
