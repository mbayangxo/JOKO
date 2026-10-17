/**
 * Serve an exported web build (expo export --platform web) as an SPA and proxy
 * same-origin /api/* to a local API server — exactly the production topology
 * (frontend + /api on one origin), for browser-level tests. Local only.
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

export function serveWeb({ dir, apiPort, port = 0, compress = false, cache = false }) {
  const gz = new Map();
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
      const st = await stat(file);
      // A directory serves its own index.html (e.g. /admin/ → the ops console), as the static host does.
      if (st.isDirectory()) file = (await stat(join(file, 'index.html')).catch(() => null))?.isFile() ? join(file, 'index.html') : join(dir, 'index.html');
      else if (!st.isFile()) file = join(dir, 'index.html');
    } catch {
      file = join(dir, 'index.html');
    }
    const body = await readFile(file);
    const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' };
    // J12 network lab: like the production static host — gzip, and immutable caching of hashed bundles.
    if (cache && /\/_expo\/static\//.test(req.url)) headers['cache-control'] = 'public, max-age=31536000, immutable';
    if (compress && /gzip/.test(req.headers['accept-encoding'] ?? '') && /\.(js|css|html|json|svg)$/.test(file)) {
      if (!gz.has(file)) gz.set(file, gzipSync(body, { level: 9 }));
      headers['content-encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(gz.get(file));
      return;
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() })));
}
