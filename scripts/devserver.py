"""Static server for demo/ that can also store exported files: PUT /save/<name> → out/<name>."""
import http.server, os, sys, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out')

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.join(ROOT, 'demo'), **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_PUT(self):
        path = urllib.parse.unquote(self.path)
        if not path.startswith('/save/'):
            return self.send_error(404)
        name = os.path.basename(path[len('/save/'):])
        if not name or name.startswith('.'):
            return self.send_error(400)
        os.makedirs(OUT, exist_ok=True)
        length = int(self.headers.get('Content-Length', 0))
        with open(os.path.join(OUT, name), 'wb') as f:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        self.send_response(201)
        self.end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8811
http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
