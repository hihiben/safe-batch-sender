#!/usr/bin/env python3
"""Serve this directory for local development, with the one header Safe needs.

`python3 -m http.server` is almost enough, but it sends no `Access-Control-Allow-Origin`, and Safe
fetches `<appUrl>/manifest.json` cross-origin from https://app.safe.global. Without CORS that fetch
throws, so:

  - *Apps -> Add custom app* refuses the URL ("The app doesn't support Safe App functionality"),
    because that dialog will not enable its button until the manifest loads;
  - opening an `apps/open?appUrl=...` link directly still works, because the iframe's src comes from
    the URL rather than the manifest — but Safe then has no name or icon for the app.

GitHub Pages sends `access-control-allow-origin: *` on everything, including 404s, so this only
matters locally.

    python3 tools/serve.py [port]        # default 8000
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class CorsHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        # Local edits should show up on reload, unlike on Pages where a CDN holds them for a while.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()


print(f"serving {ROOT} on http://localhost:{PORT}  (CORS: *, no-store)")
print("add it in Safe as a custom app, or use the link tools/make-link.js prints")
ThreadingHTTPServer(("127.0.0.1", PORT), CorsHandler).serve_forever()
