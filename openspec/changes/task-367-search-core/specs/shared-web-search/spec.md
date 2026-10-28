# Shared Web Search Specification

## Requirements

### Requirement: Shared search across MCP and authenticated HTTP
The service MUST route MCP and authenticated HTTP search through the same multi-engine behavior, including normalization, provider selection, fallback, deduplication, fused ranking, and bounded caching.

#### Scenario: MCP search uses shared results
- **WHEN** a caller invokes the compatibility web_search MCP tool
- **THEN** the service returns shared-core results while preserving the established argument and output shape

#### Scenario: Explicit provider selection
- **WHEN** a caller selects a supported provider explicitly
- **THEN** the service searches that provider and MUST NOT silently substitute the default provider pipeline

#### Scenario: Unsupported provider
- **WHEN** a caller selects an unsupported provider
- **THEN** the service returns an explicit error rather than an empty success response

#### Scenario: No results
- **WHEN** all selected providers complete successfully and return no results
- **THEN** the service returns a successful empty result set

#### Scenario: Provider failure
- **WHEN** all attempted providers fail
- **THEN** the service reports failure rather than returning a successful empty result set

### Requirement: Authenticated HTTP search contract
The service MUST expose POST /v1/search requiring a valid bearer API key. It MUST reject missing or invalid credentials and invalid input; valid requests MUST return a structured search result and provider failures MUST be represented as non-success responses.

#### Scenario: Authenticated request
- **WHEN** a client submits a valid bearer token and valid query/options
- **THEN** the response contains the shared-core structured result

#### Scenario: Invalid authentication or input
- **WHEN** a client omits/uses an invalid bearer token or submits invalid query/options
- **THEN** the service rejects the request without running search

#### Scenario: Upstream search failure
- **WHEN** an authenticated request reaches a provider failure
- **THEN** the HTTP response indicates failure and does not report an empty successful result

### Requirement: Discovery features remain owned by Phrog Web
Phrog Web MUST retain its feed, public social search, places, deals, books, media, marketplace, and secondhand capabilities and their existing routes/tools while search orchestration is consolidated.

#### Scenario: Search-core migration does not remove discovery sources
- **WHEN** the shared search endpoint and MCP behavior are added
- **THEN** existing discovery routes and tools remain available in Phrog Web
