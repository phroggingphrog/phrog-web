// Fake collector with five posts whose captions steer the fake Jev server: "great" scores high, "meh" low, empty has no text.
const caps = ['great jazz night', 'meh sponsored thing', '', 'great street market', 'meh again'];
const items = caps.map((caption, i) => ({
  position: i + 1, native_id: `jev_native_${i + 1}`, url: `https://www.instagram.com/p/J${i + 1}/`, media_type: 'photo',
  sponsored: false, suggested: false, author: { handle: `poster${i + 1}`, name: `Poster ${i + 1}`, followed: true },
  caption, hashtags: [], mentions: [], taken_at: 1790000000 + i, location: null, like_count: null, comment_count: null,
  media: [{ type: 'image', url: `https://cdn.example/${i + 1}.jpg`, width: 1080, height: 1350, alt_text: null }],
}));
console.log(JSON.stringify({ status: 'ok', account: 'x', cursor: null, next_cursor: 'NEXT:abc==', fetched_at: '2026-10-26T01:00:00Z', error: null, items }));
