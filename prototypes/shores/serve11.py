import sys
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def log_message(self, *args):
        pass


port, root = int(sys.argv[1]), sys.argv[2]
ThreadingHTTPServer(('', port), partial(Handler, directory=root)).serve_forever()
