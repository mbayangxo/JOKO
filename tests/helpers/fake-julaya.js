/**
 * Fake Julaya provider for QA/failure-injection tests. Runs a real HTTP server
 * so the app exercises its actual network client (fetchExternalJson), auth
 * header, timeouts and response parsing — nothing inside lib/ is mocked.
 *
 * Behaviour is scripted per call via `setNext({ initiate, status })`:
 *   initiate: 'pending' | 'completed' | 'failed' | 'timeout' | 'http500' | 'http400'
 *   status:   status returned by GET /transactions/:id ('completed' | 'failed' | 'pending')
 */
import http from 'node:http';

export function startFakeJulaya({ port = 0, apiKey = 'fake-julaya-key' } = {}) {
  const state = {
    initiate: 'pending',
    status: 'pending',
    statusAmount: null,
    calls: [],
    transactions: new Map(),
  };
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    state.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });

    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { message: 'bad key' });

    if (req.method === 'GET' && req.url.startsWith('/transactions/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      const tx = state.transactions.get(id);
      if (!tx) return send(404, { message: 'unknown transaction' });
      return send(200, {
        id,
        reference: tx.reference,
        status: state.status,
        amount: state.statusAmount ?? tx.amount,
        currency: 'XOF',
      });
    }

    if (req.method === 'POST') {
      const mode = state.initiate;
      if (mode === 'timeout') return; // never respond — client times out
      if (mode === 'http500') return send(500, { message: 'upstream error' });
      if (mode === 'http400') return send(400, { message: 'rejected by operator' });
      seq += 1;
      const id = `jul_${seq}_${Date.now()}`;
      state.transactions.set(id, { reference: body?.reference, amount: body?.amount });
      return send(200, { id, reference: body?.reference, status: mode });
    }
    send(404, { message: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://127.0.0.1:${actual}`,
        apiKey,
        state,
        setNext(next) {
          Object.assign(state, next);
        },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}
