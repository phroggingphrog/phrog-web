// Fake collector following the contract. FAKE_MODE: ok | auth | garbage | hang | empty_ok | end. FAKE_ARGS_FILE records argv.
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (process.env.FAKE_ARGS_FILE) appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(argv) + '\n');
const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const mode = process.env.FAKE_MODE || 'ok';
const account = get('--account');
const cursor = get('--cursor');
const base = { account, cursor, next_cursor: 'NEXT:abc==', fetched_at: '2026-10-26T01:00:00Z', error: null };
const post = (n, extra = {}) => ({
  position: n, native_id: `native_${n}`, code: `C${n}`, url: `https://www.instagram.com/p/C${n}/`,
  media_type: n === 2 ? 'carousel' : 'photo', sponsored: n === 3, suggested: n === 2,
  author: { handle: `user${n}`, name: `User ${n}`, followed: n !== 2 },
  caption: `Caption number ${n} #tag${n} @friend`, hashtags: [`tag${n}`], mentions: ['friend'],
  taken_at: n === 1 ? 1790000000 : null, location: n === 1 ? { name: 'Sydney' } : null, like_count: n === 1 ? 10 : null, comment_count: null,
  media: [{ type: 'image', url: `https://cdn.example/${n}.jpg`, width: 1080, height: 1350, alt_text: null }], ...extra,
});
if (mode === 'hang') setTimeout(() => {}, 60000);
else if (mode === 'garbage') console.log('not json at all');
else if (mode === 'auth') console.log(JSON.stringify({ ...base, status: 'auth_required', error: 'login needed', items: [post(1)] }));
else if (mode === 'empty_ok') console.log(JSON.stringify({ ...base, status: 'ok', items: [] }));
else if (mode === 'end') console.log(JSON.stringify({ ...base, status: 'end', next_cursor: null, items: [post(4)] }));
else console.log(JSON.stringify({ ...base, status: 'ok', items: [post(1), post(2), post(3)] }));
