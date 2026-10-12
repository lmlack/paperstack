#!/usr/bin/env node
// Zero-dependency static server. Browsers refuse to load ES modules over
// file://, so the app needs a real origin, and this is the smallest way to get one.
//
//   node serve.js [port]

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(import.meta.dirname);
const port = Number(process.argv[2]) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

createServer((req, res) => {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const path = join(root, normalize(requested === '/' ? '/index.html' : requested));

  if (!path.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = statSync(path);
    if (info.isDirectory()) throw new Error('directory');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, () => console.log(`Paperstack → http://localhost:${port}`));
