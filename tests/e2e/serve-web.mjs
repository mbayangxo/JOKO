/**
 * Serve an exported web build (expo export --platform web) as an SPA and proxy
 * same-origin /api/* to a local API server — exactly the production topology
 * (frontend + /api on one origin), for browser-level tests. Local only.
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

export function serveWeb({ dir, apiPort, port = 0 }) {
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const p = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${apiPort}`, 'x-forwarded-proto': 'https', 'x-forwarded-for': req.headers['x-test-ip'] ?? '10.200.0.1' } }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      p.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(p);
      return;
    }
    const clean = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    let file = join(dir, clean);
    try {
      if (!(await stat(file)).isFile()) file = join(dir, 'index.html');
    } catch {
      file = join(dir, 'index.html');
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() })));
}
