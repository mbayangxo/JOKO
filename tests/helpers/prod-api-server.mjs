/**
 * Serves the real Vercel entry (api/index.js) over HTTP for black-box tests.
 * Started as a child process by tests/helpers/http-harness.js so NODE_ENV and
 * provider env vars are exactly what production code reads — nothing mocked.
 */
import http from 'node:http';

const { default: handler } = await import('../../api/index.js');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  req.query = Object.fromEntries(url.searchParams.entries());
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    if (!res.headersSent) res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
    return res;
  };
  res.send = (body) => {
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
    return res;
  };
  try {
    await handler(req, res);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ harnessError: String(error) });
  }
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});
