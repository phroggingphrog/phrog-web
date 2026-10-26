#!/usr/bin/env python3
"""phrog-web Instagram home timeline collector (runs on the Hermes VM).
Usage: ig_timeline.py --account <name> [--limit N] [--cursor C]
Prints one JSON object (feed contract in README.md); exit code is 0 for every status."""
import argparse, datetime, fcntl, json, os, re, subprocess, sys, time
from pathlib import Path

HOME = Path.home()
OPENCLI_DIR = HOME / ".opencli"
LOCK = HOME / ".cache/phrog-web/ig-browser.lock"
ACCOUNT_RE = re.compile(r"^[A-Za-z0-9._]{1,40}$")
GUARDED = {"ig_scroll.py", "igswitch.py"}


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def busy_process():
    """True if the Hermes cron's ig_scroll.py or igswitch.py is running (argv element basename match)."""
    me = os.getpid()
    for d in Path("/proc").iterdir():
        if not d.name.isdigit() or int(d.name) == me:
            continue
        try:
            argv = (d / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        if any(os.path.basename(a.decode("utf-8", "replace")) in GUARDED for a in argv if a):
            return True
    return False


def out(status, account, cursor, next_cursor=None, items=None, error=None):
    print(json.dumps({"status": status, "account": account, "cursor": cursor, "next_cursor": next_cursor,
                      "fetched_at": now(), "error": error, "items": items or []}, ensure_ascii=False))
    sys.exit(0)


def current_account():
    f = OPENCLI_DIR / "ig-current"
    return f.read_text().strip() if f.exists() else "ykswrdn"


def run_opencli(cursor):
    cmd = ["opencli", "instagram", "timeline", "-f", "json"]
    if cursor:
        cmd += ["--cursor", cursor]
    last = ""
    for attempt in range(2):  # first call after a Chrome start sometimes says "Navigation rejected"
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        try:
            rows, _ = json.JSONDecoder().raw_decode(r.stdout.lstrip())
            return json.loads(rows[0]["payload"]), ""
        except (ValueError, KeyError, IndexError, TypeError):
            last = (r.stdout + r.stderr).strip().splitlines()
            last = " ".join(l.strip() for l in last if "Navigation" in l or "error" in l.lower() or "message" in l)[:200] or "no output"
            time.sleep(3)
    return None, last


def classify(p):
    """Map a non-200 adapter payload to a status."""
    http, msg, et = p.get("http"), (p.get("message") or "").lower(), (p.get("error_type") or "").lower()
    if p.get("challenge") or "challenge" in msg or "checkpoint" in msg or "checkpoint" in et or "challenge" in et:
        return "challenge"
    if http == 429 or "wait a few minutes" in msg or "rate" in et:
        return "rate_limited"
    if http in (401, 403) or "login_required" in msg or "login_required" in et or "login" in (p.get("url") or "").split("?")[0]:
        return "auth_required"
    if http in (404, 410) or p.get("json") is False:
        return "unsupported"
    return "failed"


def suggested_from(it):
    # The timeline response has no suggested marker (inventory_source is always "media_or_ad").
    # Proxy: a non-sponsored post from an author the account does not follow. Unknown follow state -> False.
    return (not it.get("sponsored")) and it["author"].get("followed") is False


def build(it):
    code = it.get("code")
    raw = it.get("media_type_raw")
    prod = (it.get("product_type") or "").lower()
    mtype = "carousel" if raw == 8 else "reel" if prod == "clips" else "video" if raw == 2 else "photo" if raw == 1 else None
    cap = it.get("caption")
    tags = re.findall(r"#([\w]+)", cap, re.UNICODE) if cap else []
    ments = re.findall(r"@([A-Za-z0-9._]+)", cap) if cap else []
    o = {"position": it["position"], "native_id": it["native_id"], "code": code,
         "url": f"https://www.instagram.com/p/{code}/" if code else None, "media_type": mtype,
         "sponsored": bool(it.get("sponsored")), "suggested": suggested_from(it),
         "author": it["author"], "caption": cap, "hashtags": tags, "mentions": ments,
         "taken_at": it.get("taken_at"), "location": it.get("location"),
         "like_count": it.get("like_count"), "comment_count": it.get("comment_count"), "media": it.get("media") or []}
    return o


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--account", required=True)
    ap.add_argument("--limit", type=int, default=12)
    ap.add_argument("--cursor", default="")
    a = ap.parse_args()
    cursor = a.cursor or None
    acct = a.account
    if not ACCOUNT_RE.match(acct) or not (OPENCLI_DIR / f"ig-cookies-{acct}.json").exists():
        out("unsupported", acct, cursor, error="unknown account")

    LOCK.parent.mkdir(parents=True, exist_ok=True)
    fh = open(LOCK, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        out("busy", acct, cursor, error="another phrog-web browser run holds the lock")
    if busy_process():
        out("busy", acct, cursor, error="ig_scroll.py or igswitch.py is running")

    try:
        if current_account() != acct:
            r = subprocess.run([str(HOME / ".local/bin/uv"), "run", "-q", "--with", "playwright", "python", "-I",
                                str(OPENCLI_DIR / "igswitch.py"), acct], cwd="/tmp", capture_output=True, timeout=120)
            if r.returncode != 0:
                out("failed", acct, cursor, error="account switch failed")
        # Instagram serves 2-3 posts per request: keep requesting until --limit is reached.
        # Never truncate a request's posts, or next_cursor would skip them for good.
        items, nxt, req = [], cursor, 0
        while True:
            p, err = run_opencli(nxt)
            req += 1
            if p is None or p.get("http") != 200:
                if items:  # keep what we have; the caller continues from nxt
                    break
                if p is None:
                    out("failed", acct, cursor, error=err)
                st = classify(p)
                out(st, acct, cursor, error=f"http {p.get('http')} {p.get('error_type') or p.get('reason') or ''}".strip())
            items += [build(i) for i in p.get("items", [])]
            nxt = p.get("next_cursor")
            if not nxt or a.limit <= 0 or len(items) >= a.limit or req >= 8:
                break
        for n, it in enumerate(items, 1):
            it["position"] = n
        if not items and not nxt:
            out("end", acct, cursor)
        out("ok", acct, cursor, nxt, items)
    except subprocess.TimeoutExpired:
        out("failed", acct, cursor, error="timeout")
    except Exception as e:  # never raise: exit 0 with a status
        out("failed", acct, cursor, error=f"{type(e).__name__}: {str(e)[:150]}")


if __name__ == "__main__":
    main()
