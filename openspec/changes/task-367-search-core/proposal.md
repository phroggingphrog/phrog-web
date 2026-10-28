# Proposal

## Why

The multi-engine search implementation is currently coupled to the DSH plugin, while Phrog Web already owns the provider integrations and adjacent discovery capabilities. Moving orchestration into Phrog Web gives MCP and DSH one consistent search core and lets DSH use an authenticated contract without moving or dropping Phrog Web features.

## What Changes

- Consolidate multi-provider search orchestration and compatibility MCP behavior in Phrog Web.
- Add authenticated structured HTTP search at POST /v1/search with bounded input and explicit provider failure reporting.
- Migrate DSH search calls to a configurable authenticated Phrog Web client; preserve the existing tool-facing shape and non-search capabilities.
- Keep feed, public social, and other discovery providers/routes in Phrog Web.
- No production deployment or credential provisioning in this change.

## Capabilities

### New Capabilities
- shared-web-search: Shared multi-engine search behavior over MCP and authenticated HTTP.

### Modified Capabilities
None.

## Impact

- Phrog Web search provider, compatibility mapper, HTTP route, route registration, MCP tool description and tests.
- DSH plugin configuration, search client path, response mapping and client tests.
- No additional service, production environment change, or dependency is intended.
