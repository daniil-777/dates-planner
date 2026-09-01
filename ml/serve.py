"""A stdlib HTTP sidecar exposing the same ClassifyResult contract as ``srv/lib/classifier``.

Point ``CLASSIFIER_URL`` at this process and the CAP backend classifies remotely instead of
locally, with no code change (CONTRACTS section 5). That indirection is what lets the identical
container be deployed to SAP AI Core later: the app only ever knows the JSON shape.

No web framework on purpose -- one route and one JSON body do not justify a dependency, and the
Python side of this repo must stay installable from a four-line requirements.txt.

Usage: python ml/serve.py --port 8088
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from predict import DEFAULT_WEIGHTS, Model, classify, load_model  # noqa: E402

# A classify request is a merchant string, a number and a timestamp. Anything larger is either a
# mistake or an attempt to make the process allocate, so it never reaches json.loads.
MAX_BODY_BYTES = 64 * 1024


def _make_handler(model: Model) -> type[BaseHTTPRequestHandler]:
    """Bind the loaded model into the handler class, so weights are decoded once at startup."""

    class ClassifierHandler(BaseHTTPRequestHandler):
        server_version = 'twowaymatch-classifier/1'
        protocol_version = 'HTTP/1.1'

        def _respond(self, status: int, payload: dict[str, object], drained: bool = True) -> None:
            """Write one JSON response, closing the connection when the body was never read.

            The server speaks HTTP/1.1, so the socket is reused by default and the caller (Node's
            fetch) keeps it open. Every early rejection below answers *before* consuming the
            request body, which would leave those bytes to be parsed as the next request line and
            turn one bad request into a broken connection; ``drained=False`` closes instead.
            """
            body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            if not drained:
                self.send_header('Connection', 'close')
                self.close_connection = True
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
            if self.path.rstrip('/') in ('', '/health'):
                self._respond(
                    200,
                    {
                        'status': 'ok',
                        'trainedAt': model.trained_at,
                        'trainedRows': model.trained_rows,
                        'metrics': model.metrics,
                        'nBuckets': model.n_buckets,
                    },
                )
            else:
                self._respond(404, {'error': 'not found'})

        def do_POST(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
            if self.path.rstrip('/') not in ('', '/classify'):
                self._respond(404, {'error': 'not found'}, drained=False)
                return
            try:
                length = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                self._respond(400, {'error': 'invalid Content-Length'}, drained=False)
                return
            if length <= 0:
                self._respond(400, {'error': 'empty body'}, drained=False)
                return
            if length > MAX_BODY_BYTES:
                self._respond(413, {'error': 'body too large'}, drained=False)
                return

            try:
                request = json.loads(self.rfile.read(length).decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._respond(400, {'error': 'body is not valid JSON'})
                return
            if not isinstance(request, dict):
                self._respond(400, {'error': 'body must be a JSON object'})
                return

            merchant_raw = request.get('merchantRaw')
            amount = request.get('amount')
            when_iso = request.get('whenISO')
            if not isinstance(merchant_raw, str) or not isinstance(when_iso, str):
                self._respond(400, {'error': 'merchantRaw and whenISO must be strings'})
                return
            if isinstance(amount, bool) or not isinstance(amount, (int, float)):
                self._respond(400, {'error': 'amount must be a number'})
                return
            # Python's json accepts NaN/Infinity, and an arbitrarily long integer literal blows up
            # in float(). Either would reach log1p and come back out of softmax as NaN, which
            # json.dumps then writes as the token NaN -- invalid JSON that the caller cannot parse.
            try:
                amount_value = float(amount)
            except (OverflowError, ValueError):
                self._respond(400, {'error': 'amount must be a finite number'})
                return
            if not math.isfinite(amount_value):
                self._respond(400, {'error': 'amount must be a finite number'})
                return

            try:
                # 'remote' is the truth from the caller's side of the wire: CONTRACTS section 5
                # says a ClassifyResult obtained over CLASSIFIER_URL carries engine 'remote'.
                result = classify(model, merchant_raw, amount_value, when_iso, engine='remote')
            except ValueError:
                # Deliberately not str(error): the parse errors would otherwise quote whenISO back
                # at the caller, and request bodies are the household's private data.
                self._respond(400, {'error': 'whenISO must be YYYY-MM-DD or YYYY-MM-DDTHH:MM'})
                return
            self._respond(200, result)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            """Log the request line and status only -- merchant names are the household's business."""
            sys.stderr.write(f'{self.command} {self.path} {args[1] if len(args) > 1 else ""}\n')

    return ClassifierHandler


def main() -> None:
    parser = argparse.ArgumentParser(description='Serve the classifier over HTTP.')
    parser.add_argument('--host', default='127.0.0.1', help='bind address')
    parser.add_argument('--port', type=int, default=8088, help='bind port')
    parser.add_argument('--weights', default=DEFAULT_WEIGHTS, help='path to weights.json')
    args = parser.parse_args()

    model = load_model(args.weights)
    server = ThreadingHTTPServer((args.host, args.port), _make_handler(model))
    print(f'classifier listening on http://{args.host}:{args.port}')
    print(f'  weights   {args.weights} (trained {model.trained_at} on {model.trained_rows} rows)')
    print(f'  POST /    {{"merchantRaw": "...", "amount": 12.5, "whenISO": "2026-03-14T20:15"}}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopping')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
