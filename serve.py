"""Local-only preview, with deterministic MIME types and HTTP Range support on Windows."""
import os
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from functools import partial

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
                      '.json': 'application/json', '.gz': 'application/octet-stream'}

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

    def do_GET(self):
        header = self.headers.get('Range')
        if not header:
            return super().do_GET()
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', header.strip())
        if not match:
            return super().do_GET()
        path = self.translate_path(self.path)
        try:
            size = os.path.getsize(path)
        except OSError:
            return super().do_GET()
        start_text, end_text = match.groups()
        if start_text == '' and end_text == '':
            return super().do_GET()
        if start_text == '':  # suffix range: last N bytes
            start, end = max(0, size - int(end_text)), size - 1
        else:
            start = int(start_text)
            end = int(end_text) if end_text else size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            self.send_response(416)
            self.send_header('Content-Range', 'bytes */%d' % size)
            self.end_headers()
            return
        with open(path, 'rb') as file:
            file.seek(start)
            data = file.read(end - start + 1)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    print('cjf gallery: http://127.0.0.1:8771/', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8771), partial(Handler, directory=str(root))).serve_forever()
