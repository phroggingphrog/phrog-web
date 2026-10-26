import type { DatabaseSync } from 'node:sqlite';
import { Ctx, iso, nativeFromUrl, sha, text } from './common.js';

// Source action -> observation action. Anything not listed is out of scope (account admin, polls, sessions, ...).
const ACTIONS: Record<string, { action: string; target?: string; sponsored?: boolean }> = {
  liked_post: { action: 'like' },
  liked_story: { action: 'like' },
  liked_comment: { action: 'like', target: 'comment' },
  saved_post: { action: 'save' },
  viewed_post: { action: 'open' },
  watched_video: { action: 'open' },
  viewed_story: { action: 'open' },
  viewed_threads_post: { action: 'open' },
  viewed_ad: { action: 'ad_view', sponsored: true },
  clicked_ad: { action: 'ad_click', sponsored: true },
  not_interested_post: { action: 'not_interested' },
  not_interested_profile: { action: 'not_interested' },
  searched_profile: { action: 'search' },
};

const RELATIONS: Record<string, { relation: string; state: string }> = {
  following: { relation: 'follow', state: 'active' },
  threads_following: { relation: 'follow_threads', state: 'active' },
  unfollowed: { relation: 'follow', state: 'ended' },
  threads_unfollowed: { relation: 'follow_threads', state: 'ended' },
  follower: { relation: 'follower', state: 'active' },
  threads_follower: { relation: 'follower_threads', state: 'active' },
  close_friend: { relation: 'close_friend', state: 'active' },
  blocked: { relation: 'blocked', state: 'active' },
};

export function importSocial(src: DatabaseSync, ctx: Ctx) {
  const c = ctx.counts;

  // platform_events
  const events = src.prepare(`SELECT platform, account, action, counterparty, url, ts_utc, source_file, source_row FROM platform_events
    ORDER BY platform, account, action, ts_utc, counterparty, url, source_file, source_row`).all() as any[];
  for (const r of events) {
    c.read++;
    const m = ACTIONS[r.action];
    if (!m) { ctx.reason('excluded', `action=${r.action}`); continue; }
    const at = iso(r.ts_utc);
    if (!at) { ctx.reason('rejected', 'no_timestamp'); continue; }
    const url = text(r.url);
    const who = text(r.counterparty);
    if (!url && !who) { ctx.reason('rejected', 'no_target'); continue; }
    const accountId = ctx.account(r.platform, r.account);
    const creatorId = who ? ctx.creator(r.platform, who) : null;
    let itemId: string;
    if (url && r.action !== 'searched_profile') {
      const { native, kind } = nativeFromUrl(r.platform, url);
      itemId = ctx.item({ ids: [[r.platform, native]], kind, url: native.startsWith('story:') ? null : url, creatorId, author: who ? { handle: who } : null });
    } else itemId = creatorId!; // no post link (e.g. a save without url): the action attaches to the author
    const base = [r.platform, r.account, r.action, who ?? '', url ?? '', at].join('\x1f');
    ctx.obs({
      accountId, itemId, action: m.action, occurredAt: at, key: `social\x1f${base}\x1f${ctx.occurrence(base)}`, table: 'platform_events',
      rowKey: `${r.source_file}#${r.source_row}`, sponsored: m.sponsored,
      learn: m.target === 'comment' ? false : undefined, detail: { source_action: r.action, ...(m.target ? { target: m.target } : {}), ...(!url ? { no_post_url: true } : {}) },
    });
  }

  // follows -> current state, never deletes
  const follows = src.prepare(`SELECT platform, account, relation, username, ts_utc, source_file, source_row FROM follows
    ORDER BY platform, account, relation, username, ts_utc`).all() as any[];
  for (const r of follows) {
    c.read++;
    const m = RELATIONS[r.relation];
    if (!m) { ctx.reason('excluded', `relation=${r.relation}`); continue; }
    const who = text(r.username);
    if (!who) { ctx.reason('rejected', 'no_username'); continue; }
    ctx.state({
      accountId: ctx.account(r.platform, r.account), itemId: ctx.creator(r.platform, who), counterparty: who,
      relation: m.relation, state: m.state, effectiveAt: iso(r.ts_utc), prov: `social.follows:${r.source_file}#${r.source_row}`,
    });
  }

  // my_posts: own posts as items + 'post' observations. Identity is content based so a newer export does not duplicate.
  const posts = src.prepare(`SELECT platform, account, kind, caption, url, ts_utc, source_file, source_row FROM my_posts
    ORDER BY platform, account, kind, ts_utc, caption, url, source_file, source_row`).all() as any[];
  for (const r of posts) {
    c.read++;
    const at = iso(r.ts_utc);
    if (!at) { ctx.reason('rejected', 'no_timestamp'); continue; }
    const caption = text(r.caption);
    const own = ownPostKey(r.platform, r.account, r.kind, at, caption);
    const n = ctx.occurrence(`post\x1f${own}`);
    const url = text(r.url);
    const ids: Array<[string, string]> = [['import:own', n ? `${own}#${n}` : own]];
    if (url && !n) ids.unshift([r.platform, nativeFromUrl(r.platform, url).native]);
    const itemId = ctx.item({ ids, kind: r.kind === 'story' ? 'story' : 'post', description: caption, url, publishedAt: at });
    ctx.obs({
      accountId: ctx.account(r.platform, r.account), itemId, action: 'post', occurredAt: at, learn: false, key: `social\x1fpost\x1f${own}\x1f${n}`,
      table: 'my_posts', rowKey: `${r.source_file}#${r.source_row}`, detail: { source_action: 'my_post', post_kind: r.kind },
    });
  }

  // my_comments: the comment is an item authored by the owner, attached to the post owner
  const comments = src.prepare(`SELECT platform, account, target_owner, text, ts_utc, source_file, source_row FROM my_comments
    ORDER BY platform, account, target_owner, ts_utc, text, source_file, source_row`).all() as any[];
  for (const r of comments) {
    c.read++;
    const at = iso(r.ts_utc);
    if (!at) { ctx.reason('rejected', 'no_timestamp'); continue; }
    const body = text(r.text);
    if (!body) { ctx.reason('rejected', 'empty_comment'); continue; }
    const base = [r.platform, r.account, r.target_owner ?? '', at, sha(body)].join('\x1f');
    const n = ctx.occurrence(`comment\x1f${base}`);
    const who = text(r.target_owner);
    const itemId = ctx.item({
      ids: [['import:comment', `${sha(base)}${n ? `#${n}` : ''}`]], kind: 'comment', description: body, publishedAt: at,
      creatorId: who ? ctx.creator(r.platform, who) : null,
    });
    ctx.obs({
      accountId: ctx.account(r.platform, r.account), itemId, action: 'comment', occurredAt: at, key: `social\x1fcomment\x1f${base}\x1f${n}`,
      table: 'my_comments', rowKey: `${r.source_file}#${r.source_row}`, detail: { source_action: 'my_comment', target_owner: who },
    });
  }
}

export const ownPostKey = (platform: string, account: string, kind: string, ts: string, caption: string | null) =>
  sha([platform, account, kind, ts, caption ? sha(caption) : ''].join('\x1f'));
