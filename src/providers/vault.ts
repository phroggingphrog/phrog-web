import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../config.js';

export interface VaultArgs {
  action: string;
  query?: string; note_id?: string; title?: string; body?: string; source?: string;
  tier?: string; content_type?: string; summary?: string; doi?: string; venue?: string;
  citation_count?: number | null; utility_score?: number | null; authority_score?: number | null;
  source_domain?: string; fetched_at?: string; fetch_provider?: string; is_retracted?: boolean | null;
  oa_url?: string; oa_source?: string; oa_version?: string; oa_license?: string; oa_recovery_kind?: string;
  claim?: string; quoted_support?: string; confidence?: string; evidence_type?: string;
  stance_target?: string; stance?: string; run_id?: string; tags?: string[]; limit?: number; ranked?: boolean;
}

async function call(tool: string, args: Record<string, any>): Promise<any> {
  loadConfig();
  const url = process.env.WEB_AGENT_FEYNMAN_URL || 'http://127.0.0.1:8910/mcp';
  const client = new Client({ name: 'phrog-web', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const result: any = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90000 });
    const text = (result.content ?? []).map((c: any) => c.text ?? '').join('\n').trim();
    if (result.isError) throw new Error(text || `Feynman tool ${tool} failed`);
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  } catch (e: any) {
    throw new Error(`Feynman MCP at ${url} failed: ${String(e.message).slice(0, 200)}`);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function researchVault(a: VaultArgs): Promise<any> {
  const actions = ['status', 'search', 'read', 'save', 'add_claim', 'search_claims'];
  if (!actions.includes(a.action)) throw new Error('action must be status, search, read, save, add_claim, or search_claims');
  const limit = Math.max(1, Math.min(100, a.limit ?? 10));
  const t = (s?: string) => (s ?? '').trim();
  switch (a.action) {
    case 'status':
      return call('feynman_vault_status', {});
    case 'search':
      if (!t(a.query)) throw new Error('query is required for action=search');
      return call('feynman_vault_search', { query: a.query, limit, tags: a.tags ?? [], ranked: a.ranked ?? false });
    case 'search_claims': {
      if (!t(a.query)) throw new Error('query is required for action=search_claims');
      const o: Record<string, any> = { query: a.query, limit };
      if (t(a.run_id)) o.runId = t(a.run_id);
      return call('feynman_vault_claim_search', o);
    }
    case 'read':
      if (!t(a.note_id)) throw new Error('note_id is required for action=read');
      return call('feynman_vault_read', { id: t(a.note_id) });
    case 'add_claim': {
      if (!t(a.note_id) || !t(a.claim)) throw new Error('note_id and claim are required for action=add_claim');
      const o: Record<string, any> = { noteId: t(a.note_id), claim: t(a.claim) };
      if (t(a.quoted_support)) o.quotedSupport = a.quoted_support;
      if (t(a.confidence)) o.confidence = a.confidence;
      if (t(a.evidence_type)) o.evidenceType = a.evidence_type;
      if (t(a.stance_target)) o.stanceTarget = a.stance_target;
      if (t(a.stance)) o.stance = a.stance;
      if (t(a.run_id)) o.runId = t(a.run_id);
      return call('feynman_vault_add_claim', o);
    }
    default: {
      if (!t(a.title) || !t(a.body)) throw new Error('title and body are required for action=save');
      const o: Record<string, any> = { title: a.title, body: a.body, tags: a.tags ?? [] };
      if (t(a.source)) o.source = t(a.source);
      const extra: Record<string, any> = {
        tier: a.tier, contentType: a.content_type, summary: a.summary, doi: a.doi, venue: a.venue,
        citationCount: a.citation_count, utilityScore: a.utility_score, authorityScore: a.authority_score,
        sourceDomain: a.source_domain, fetchedAt: a.fetched_at, fetchProvider: a.fetch_provider,
        isRetracted: a.is_retracted, oaUrl: a.oa_url, oaSource: a.oa_source, oaVersion: a.oa_version,
        oaLicense: a.oa_license, oaRecoveryKind: a.oa_recovery_kind,
      };
      for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') o[k] = v;
      return call('feynman_vault_create_note', o);
    }
  }
}
