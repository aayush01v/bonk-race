#!/usr/bin/env node
/**
 * Zero-dependency HTTP static server for Sim Race / Bonk.
 * Works out of the box in Node.js 18+ and GitHub Codespaces.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.env.PORT || '8000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(__dirname);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  // CORS & dev cache headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url);
  let pathname = decodeURIComponent(parsedUrl.pathname);

  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  const filePath = path.normalize(path.join(ROOT, pathname));

  // Security: prevent path traversal outside root
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:30px;background:#cfeaff;color:#2a1a5e">
        <h2>404 Not Found</h2>
        <p>The requested file <code>${pathname}</code> was not found.</p>
        <p><a href="/" style="font-weight:bold;color:#2a1a5e">Return to Game Launcher</a></p>
      </body></html>`);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  const codespaceName = process.env.CODESPACE_NAME;
  console.log('='.repeat(60));
  console.log('  SIM RACE / BONK - DEV & TEST SERVER');
  console.log('='.repeat(60));
  console.log(`- Local URL:         http://localhost:${PORT}/`);
  console.log(`- Babylon 3D Client: http://localhost:${PORT}/sim-race-babylon.html`);
  console.log(`- WebGL1 Client:     http://localhost:${PORT}/sim-race-webgl.html`);
  if (codespaceName) {
    console.log(`- Codespace URL:     https://${codespaceName}-${PORT}.app.github.dev/`);
    console.log('  (Make sure Port 8000 visibility is set to "Public" in the PORTS tab if sharing)');
  }
  console.log('='.repeat(60));
  console.log('Serving files from:', ROOT);
  console.log('Press Ctrl+C to stop.\n');
});
