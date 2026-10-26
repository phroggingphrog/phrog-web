// phrog-web: Instagram home timeline with continuation token. Runs inside the logged-in tab. Read-only.
// Prints one row {payload: "<json>"}; ig_timeline.py maps it to the feed contract.
import { cli } from "@jackwener/opencli/registry";
cli({
    site: "instagram",
    name: "timeline",
    access: "read",
    description: "Instagram home timeline page with cursor, ad/suggested flags and full media fields (phrog-web)",
    domain: "www.instagram.com",
    args: [
        { name: "cursor", type: "string", default: "", help: "next_cursor from a previous page" },
        { name: "shape", type: "bool", default: false, help: "debug: return key names only" },
    ],
    columns: ["payload"],
    pipeline: [
        { navigate: "https://www.instagram.com" },
        { evaluate: `(async () => {
  const cursor = \${{ args.cursor | json }}, shape = \${{ args.shape | json }};
  const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
  const out = (o) => [{ payload: JSON.stringify(o) }];
  if (!csrf) return out({ http: 401, reason: "no_csrf" });
  const H = { "X-IG-App-ID": "936619743392459", "X-CSRFToken": csrf, "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded" };
  const body = new URLSearchParams({ reason: cursor ? "pagination" : "cold_start_fetch", is_pull_to_refresh: "0" });
  if (cursor) body.set("max_id", cursor);
  const res = await fetch("https://www.instagram.com/api/v1/feed/timeline/", { method: "POST", credentials: "include", headers: H, body });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch (e) {}
  if (!res.ok || !data || data.status === "fail") {
    return out({ http: res.status, redirected: res.redirected, url: res.url, message: data ? (data.message || "") : "", error_type: data ? (data.error_type || "") : "", challenge: !!(data && (data.challenge || data.checkpoint_url)), json: !!data });
  }
  if (shape) {
    const keys = (o) => o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort() : [];
    const first = (data.feed_items || [])[0] || {};
    return out({ http: 200, top: keys(data), item_keys: [...new Set((data.feed_items || []).flatMap(keys))], media_keys: [...new Set((data.feed_items || []).flatMap(i => keys(i.media_or_ad)))], user_keys: [...new Set((data.feed_items || []).flatMap(i => keys(i.media_or_ad && i.media_or_ad.user)))], n: (data.feed_items || []).length });
  }
  const medias = [], seen = new Set();
  const take = (m) => {
    const k = m.pk ?? m.id ?? m.code;
    if (k == null || seen.has(k)) return;
    seen.add(k); medias.push({ m });
  };
  for (const it of (data.feed_items || [])) {
    const m = it.media_or_ad || it.media;
    if (m && typeof m === "object" && m.user && (m.code || m.pk)) take(m);
  }
  const best = (c) => (c && c[0]) || null;
  const mediaOf = (m) => {
    const one = (x) => {
      const v = best(x.video_versions), i = best(x.image_versions2 && x.image_versions2.candidates);
      const src = v || i; if (!src) return null;
      return { type: v ? "video" : "image", url: src.url || null, width: src.width ?? x.original_width ?? null, height: src.height ?? x.original_height ?? null, alt_text: x.accessibility_caption || null };
    };
    const kids = Array.isArray(m.carousel_media) && m.carousel_media.length ? m.carousel_media : [m];
    return kids.map(one).filter(Boolean);
  };
  const items = medias.map(({ m }, i) => {
    const cap = m.caption && typeof m.caption.text === "string" ? m.caption.text : null;
    const fs = m.user && m.user.friendship_status;
    return {
      position: i + 1,
      native_id: String(m.pk ?? m.id ?? "").split("_")[0],
      code: m.code || null,
      media_type_raw: m.media_type ?? null,
      product_type: m.product_type || null,
      sponsored: !!(m.ad_id || m.is_paid_partnership_ad),
      author: { handle: m.user.username || null, name: m.user.full_name || null, followed: fs && typeof fs.following === "boolean" ? fs.following : null },
      caption: cap,
      taken_at: typeof m.taken_at === "number" ? m.taken_at : null,
      location: m.location && m.location.name ? { name: m.location.name } : null,
      like_count: typeof m.like_count === "number" ? m.like_count : null,
      comment_count: typeof m.comment_count === "number" ? m.comment_count : null,
      media: mediaOf(m),
    };
  });
  return out({ http: 200, next_cursor: data.next_max_id || null, more_available: data.more_available ?? null, items });
})()
` },
    ],
});
