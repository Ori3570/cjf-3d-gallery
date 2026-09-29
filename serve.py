"""Local-only preview, with deterministic MIME types on Windows."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from functools import partial

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
                      '.json': 'application/json', '.gz': 'application/octet-stream'}

if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    print('cjf gallery: http://127.0.0.1:8771/', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8771), partial(Handler, directory=str(root))).serve_forever()
