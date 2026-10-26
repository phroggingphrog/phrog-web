import { resolve } from 'node:path';
import { mkdirSync, createWriteStream, rmSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../config.js';
import { downloadsDir } from './books.js';

const execFileAsync = promisify(execFile);

export interface GithubRepo {
  name: string;
  description: string;
  url: string;
  stars?: number;
  language?: string;
  license?: string;
}

export interface GithubSearchResponse {
  query: string;
  repos: GithubRepo[];
  provider_used: string;
  total: number;
}

export async function searchGithubRepos(query: string, limit = 10): Promise<GithubSearchResponse> {
  const config = loadConfig();
  const searxUrl = config.search?.providers?.searxng?.url || 'http://127.0.0.1:8888';

  // 1. Try local SearXNG GitHub engine first
  try {
    const url = new URL('/search', searxUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('engines', 'github');
    url.searchParams.set('format', 'json');

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });

    if (res.ok) {
      const data = await res.json() as any;
      if (Array.isArray(data.results) && data.results.length > 0) {
        const repos: GithubRepo[] = data.results.slice(0, limit).map((r: any) => ({
          name: r.title || r.package_name || '',
          description: r.content || '',
          url: r.url || '',
          stars: r.popularity,
          language: r.tags?.[0],
          license: r.license_name,
        }));

        return {
          query,
          repos,
          provider_used: 'searxng-github',
          total: repos.length,
        };
      }
    }
  } catch (err) {
    // Fall back to direct GitHub API
  }

  // 2. Direct GitHub Search API fallback
  const ghUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`;
  const res = await fetch(ghUrl, {
    signal: AbortSignal.timeout(8000),
    headers: {
      'User-Agent': 'Phrog-Web-Agent',
      'Accept': 'application/vnd.github.v3+json',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub Search API HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json() as any;
  const repos: GithubRepo[] = (data.items || []).slice(0, limit).map((item: any) => ({
    name: item.full_name || item.name,
    description: item.description || '',
    url: item.html_url,
    stars: item.stargazers_count,
    language: item.language,
    license: item.license?.spdx_id || item.license?.name,
  }));

  return {
    query,
    repos,
    provider_used: 'github-api',
    total: repos.length,
  };
}

// ---- Keyless GitHub downloads (public repos only, no API token) ----

export interface GithubDownloadResult {
  repo: string;
  ref: string;
  tarball: string;
  extracted_to?: string;
  bytes: number;
  provider_used: 'github-codeload';
}

export interface GithubPatchResult {
  repo: string;
  number: number;
  kind: 'diff' | 'patch';
  content: string;
  truncated: boolean;
  provider_used: 'github-web';
}

const MAX_TARBALL_BYTES = 200 * 1024 * 1024;

export function normalizeGithubRepo(input: string): string {
  const repo = input
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .split('/')
    .slice(0, 2)
    .join('/');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes('..')) {
    throw new Error(`Invalid GitHub repo "${input}"; expected owner/repo`);
  }
  return repo;
}

function safeRef(ref: string): string {
  if (!/^[A-Za-z0-9_./-]+$/.test(ref) || ref.includes('..') || ref.startsWith('/')) {
    throw new Error(`Invalid ref "${ref}"`);
  }
  return ref;
}

export async function downloadGithubRepo(
  repoInput: string,
  opts: { ref?: string; extract?: boolean } = {},
): Promise<GithubDownloadResult> {
  const repo = normalizeGithubRepo(repoInput);
  const ref = safeRef(opts.ref || 'HEAD');
  const extract = opts.extract !== false;

  const dir = resolve(downloadsDir(), 'github');
  mkdirSync(dir, { recursive: true });
  const stem = `${repo.replace('/', '__')}__${ref.replace(/\//g, '_')}`;
  const tarball = resolve(dir, `${stem}.tar.gz`);

  const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/${ref}`, {
    signal: AbortSignal.timeout(180000),
    headers: { 'User-Agent': 'Phrog-Web-Agent' },
    redirect: 'follow',
  });
  if (res.status === 404) throw new Error(`GitHub 404: ${repo}@${ref} not found or not public`);
  if (!res.ok || !res.body) throw new Error(`GitHub codeload HTTP ${res.status}: ${res.statusText}`);

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_TARBALL_BYTES) throw new Error(`Tarball ${declared} bytes exceeds ${MAX_TARBALL_BYTES} byte cap`);

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_TARBALL_BYTES) return cb(new Error(`Tarball exceeds ${MAX_TARBALL_BYTES} byte cap`));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as any), limiter, createWriteStream(tarball));
  } catch (err) {
    rmSync(tarball, { force: true });
    throw err;
  }

  const result: GithubDownloadResult = { repo, ref, tarball, bytes, provider_used: 'github-codeload' };
  if (extract) {
    const dest = resolve(dir, stem);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    await execFileAsync('tar', ['-xzf', tarball, '-C', dest, '--strip-components=1'], { timeout: 120000 });
    result.extracted_to = dest;
  }
  return result;
}

export async function fetchGithubPatch(
  repoInput: string,
  number: number,
  kind: 'diff' | 'patch' = 'diff',
  maxChars = 100000,
): Promise<GithubPatchResult> {
  const repo = normalizeGithubRepo(repoInput);
  if (!Number.isInteger(number) || number <= 0) throw new Error('Pull request number must be a positive integer');
  const res = await fetch(`https://github.com/${repo}/pull/${number}.${kind}`, {
    signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'Phrog-Web-Agent' },
    redirect: 'follow',
  });
  if (res.status === 404) throw new Error(`GitHub 404: ${repo}#${number} not found or not public`);
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}: ${res.statusText}`);
  const raw = await res.text();
  const truncated = raw.length > maxChars;
  return {
    repo,
    number,
    kind,
    content: truncated ? raw.slice(0, maxChars) : raw,
    truncated,
    provider_used: 'github-web',
  };
}
