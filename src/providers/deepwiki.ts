export interface DeepWikiAnswer {
  repo: string;
  question: string;
  answer: string;
  provider_used: 'deepwiki';
}

export interface DeepWikiStructure {
  repo: string;
  structure: string;
  provider_used: 'deepwiki';
}

export interface DeepWikiContents {
  repo: string;
  contents: string;
  provider_used: 'deepwiki';
}

const DEEPWIKI_MCP_URL = process.env.DEEPWIKI_MCP_URL || 'https://mcp.deepwiki.com/mcp';
/**
 * DeepWiki returns its failures as 200-status prose ("Error fetching wiki for ..."), which is the only
 * thing distinguishing a failed read from a real one.
 */
export function isUpstreamError(text: string): boolean {
  const t = text.trim();
  return /^error\b/i.test(t) && t.length < 400;
}

const TIMEOUT_MS = 60000;

async function callDeepWiki(toolName: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(DEEPWIKI_MCP_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`DeepWiki HTTP ${res.status}: ${res.statusText}`);
  }

  // DeepWiki answers 200 with the failure as text ("Error fetching wiki for repo ..."). Passing that
  // back as a successful structure or contents read is worse than failing: the caller cannot tell.

  const raw = await res.text();

  // Parse SSE or JSON
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.error) {
          throw new Error(parsed.error.message || 'DeepWiki RPC error');
        }
        const text = parsed.result?.content?.[0]?.text;
        if (text) {
          if (isUpstreamError(text)) throw new Error(`DeepWiki: ${text.trim()}`);
          return text;
        }
      } catch (e) {
        if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
          throw e;
        }
      }
    }
  }

  // Fallback: direct JSON
  try {
    const parsed = JSON.parse(raw);
    const text = parsed.result?.content?.[0]?.text;
    if (text) {
      if (isUpstreamError(text)) throw new Error(`DeepWiki: ${text.trim()}`);
      return text;
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('DeepWiki:')) throw err;
  }

  throw new Error('DeepWiki returned an empty response');
}

export async function askDeepWiki(repo: string, question: string): Promise<DeepWikiAnswer> {
  const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const answer = await callDeepWiki('ask_question', { repoName: cleanRepo, question });
  return {
    repo: cleanRepo,
    question,
    answer,
    provider_used: 'deepwiki',
  };
}

export async function readDeepWikiContents(repo: string, maxChars = 60000): Promise<DeepWikiContents> {
  const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const raw = await callDeepWiki('read_wiki_contents', { repoName: cleanRepo });
  const contents = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n\n[truncated: ${raw.length - maxChars} more chars]` : raw;
  return {
    repo: cleanRepo,
    contents,
    provider_used: 'deepwiki',
  };
}

export async function getDeepWikiStructure(repo: string): Promise<DeepWikiStructure> {
  const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const structure = await callDeepWiki('read_wiki_structure', { repoName: cleanRepo });
  return {
    repo: cleanRepo,
    structure,
    provider_used: 'deepwiki',
  };
}
