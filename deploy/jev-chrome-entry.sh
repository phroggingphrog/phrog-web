#!/bin/sh
# Chromium (new headless) listens on the container's 127.0.0.1:9222 only; forward 0.0.0.0:9223 -> it so the host can publish it.
CHROME=/home/appuser/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
"$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --remote-debugging-port=9222 \
  --user-data-dir=/tmp/jev-profile --no-first-run --no-default-browser-check --lang=en-US about:blank &
python3 - <<'PY'
import asyncio
async def pipe(r, w):
    try:
        while (d := await r.read(65536)):
            w.write(d); await w.drain()
    finally:
        w.close()
async def handle(r, w):
    try:
        ur, uw = await asyncio.open_connection("127.0.0.1", 9222)
    except OSError:
        w.close(); return
    await asyncio.gather(pipe(r, uw), pipe(ur, w))
async def main():
    s = await asyncio.start_server(handle, "0.0.0.0", 9223)
    async with s: await s.serve_forever()
asyncio.run(main())
PY
