"""stdin JSON -> web_acquisition.wiki -> stdout JSON. Same behaviour as the old save_to_wiki MCP tool."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from web_acquisition import wiki  # noqa: E402

a = json.load(sys.stdin)
title, target = (a.get("title") or "").strip(), a.get("target") or ""
job_id = (a.get("job_id") or "").strip()
urls, text, question = a.get("urls") or None, a.get("text") or "", a.get("question") or ""
if job_id:
    if urls or text.strip() or question.strip():
        raise ValueError("provide job_id or urls/text/question, not both")
    from web_acquisition import sitecrawl

    job = sitecrawl.job_status(job_id)
    if job.get("kind") != "deep":
        raise ValueError(f"job '{job_id}' is not a deep-research job")
    if job.get("status") != "completed":
        raise ValueError(f"deep-research job '{job_id}' is {job.get('status', 'unknown')}; wait for completion first")
    origin = job.get("path")
    if not isinstance(origin, str) or not Path(origin).is_file():
        raise ValueError(f"deep-research job '{job_id}' has no readable report file")
    report = Path(origin).read_text(errors="replace")
    if not report.strip():
        raise ValueError(f"deep-research job '{job_id}' produced an empty report")
    t = title or Path(origin).stem.replace("-", " ").replace("_", " ").title()
    out = wiki.file_deliverable(t, report, origin, target)
else:
    out = wiki.compile_to_wiki(kind=a.get("kind") or "note", urls=urls, text=text, question=question, title=title, target=target)
print(json.dumps(out))
