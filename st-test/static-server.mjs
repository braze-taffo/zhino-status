/**
 * CORS static server for the zhino-status dist bundle.
 * SillyTavern script iframes import this as an ES module.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('/workspace/zhino-status/dist');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

const types = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, extra = {}) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
    ...extra,
  };
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'method not allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.js';
  const file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root + path.sep) && file !== root) {
    send(res, 403, 'forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
    };
    if (req.method === 'HEAD') {
      send(res, 200, '', headers);
      return;
    }
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Private-Network': 'true',
      'Cache-Control': 'no-store',
      ...headers,
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(port, host, () => {
  console.log(`static ${root} on http://${host}:${port}`);
});
