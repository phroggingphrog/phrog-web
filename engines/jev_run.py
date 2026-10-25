"""Run one Jev browse task. Executed with Jev's own venv (Python 3.12+): JSON request on stdin, one JSON line on stdout."""
import json
import re
import sys
import time

from jev_ultrafast import Agent
from jev_ultrafast.browser import StalePage


def open_agent(url, goal):
    """The page can still be navigating at the first snapshot (redirects, cold starts): retry before giving up."""
    for attempt in range(3):
        try:
            return Agent(url, goal)
        except StalePage:
            if attempt == 2:
                raise
            time.sleep(2)


ERROR_PAGE = re.compile(r"something went wrong|oops|try again later|error occurred", re.I)


def hard_reload(agent, page):
    """SPAs (Google Flights) show an error page when their in-page refresh fails, yet load the same URL fine as a fresh document."""
    browser = agent.state["browser"]
    browser.call("Page.navigate", url=page["url"])
    for _ in range(40):
        time.sleep(0.25)
        try:
            if browser.evaluate("document.readyState") == "complete":
                break
        except StalePage:
            pass
    time.sleep(3)
    return browser.observe(screenshot=False)


req = json.load(sys.stdin)
deadline = time.monotonic() + float(req.get("max_seconds", 90))
steps, last, page, seen = [], None, {}, 0
try:
    with open_agent(req["url"], req["goal"]) as agent:
        for state in agent.run():
            last = state
            for h in state["history"][seen:]:  # each tick repeats the history: record only new entries
                steps.append({k: h.get(k) for k in ("action", "kind", "text", "page_changed") if k in h})
            seen = len(state["history"])
            if time.monotonic() > deadline:
                break
        page = agent.state["page"]
        recovered = False
        if (last or {}).get("status") != "done" and ERROR_PAGE.search(page.get("text") or ""):
            page, recovered = hard_reload(agent, page), True
        controls = [{k: e.get(k) for k in ("index", "role", "label", "value")} for e in agent.snapshot()["elements"]
                    if e.get("value") or e.get("role") in {"combobox", "textbox", "searchbox", "checkbox"}][:25]
    status = (last or {}).get("status", "none")
    if recovered:
        status = "recovered" if not ERROR_PAGE.search(page.get("text") or "") else status
    out = {"ok": True, "status": status, "elapsed_ms": (last or {}).get("elapsed_ms"),
           "timed_out": time.monotonic() > deadline, "steps": steps[-40:],
           "controls": controls, "page": {"url": page.get("url"), "title": page.get("title"), "text": (page.get("text") or "")[: int(req.get("max_chars", 6000))]}}
except Exception as exc:  # no-key, connection, guard errors: report, never crash the caller
    out = {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:300]}", "steps": steps[-40:]}
print(json.dumps(out))
