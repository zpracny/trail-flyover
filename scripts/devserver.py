"""Static server for demo/ that can also store exported files: PUT /save/<name> → out/<name>.

Development only. It listens on 127.0.0.1 and, against DNS rebinding (a web page making the
browser talk to this server under its own domain), answers only requests addressed to
localhost / 127.0.0.1 / [::1]. Uploads are limited in size and never overwrite a file.
"""
import http.server, os, sys, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out')
MAX_UPLOAD = 2 * 1024 ** 3  # 2 GB — a 60 s 4K video is well below
LOCAL_HOSTS = {'127.0.0.1', 'localhost', '[::1]'}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.join(ROOT, 'demo'), **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def host_ok(self):
        host = (self.headers.get('Host') or '').lower()
        name = host.rsplit(':', 1)[0] if not host.endswith(']') else host
        if name in LOCAL_HOSTS:
            return True
        self.send_error(403, 'Only localhost')
        return False

    def do_GET(self):
        if self.host_ok():
            super().do_GET()

    def do_HEAD(self):
        if self.host_ok():
            super().do_HEAD()

    def do_PUT(self):
        if not self.host_ok():
            return
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if not path.startswith('/save/'):
            return self.send_error(404)
        # Only a plain file name: no directories, no hidden files.
        name = os.path.basename(path[len('/save/'):])
        if not name or name.startswith('.') or '\0' in name:
            return self.send_error(400)
        try:
            length = int(self.headers.get('Content-Length', ''))
        except ValueError:
            return self.send_error(411)
        if length < 0 or length > MAX_UPLOAD:
            return self.send_error(413)
        os.makedirs(OUT, exist_ok=True)
        # Never overwrite: video.mp4 → video-1.mp4, video-2.mp4, …
        stem, ext = os.path.splitext(name)
        target, n = os.path.join(OUT, name), 0
        while True:
            try:
                f = open(target, 'xb')
                break
            except FileExistsError:
                n += 1
                target = os.path.join(OUT, f'{stem}-{n}{ext}')
        with f:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        self.send_response(201)
        self.send_header('Location', '/save/' + urllib.parse.quote(os.path.basename(target)))
        self.end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8811
    out_dir = sys.argv[2] if len(sys.argv) > 2 else None
    if out_dir:
        OUT = os.path.abspath(out_dir)
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
