/**
 * PolyARB Cloud Proxy Server
 * ──────────────────────────
 * Deploys to Render / Railway / Glitch for free.
 * Proxies Polymarket HTTP + WebSocket APIs from a non-blocked IP.
 * Zero npm dependencies — pure Node.js built-ins only.
 *
 * Deploy to Render:   https://render.com  (free tier, sleeps after 15min idle)
 * Deploy to Railway:  https://railway.app (free $5 credit/month)
 * Deploy to Glitch:   https://glitch.com  (free, always on)
 */

const http  = require('http');
const https = require('https');
const net   = require('net');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3000;

// Upstream hosts
const GAMMA_HOST = 'gamma-api.polymarket.com';
const CLOB_HOST  = 'clob.polymarket.com';
const WS_HOST    = 'ws-subscriptions-clob.polymarket.com';

// ── Realistic browser headers ────────────────────────────────
const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin':          'https://polymarket.com',
  'Referer':         'https://polymarket.com/',
};

// CORS headers for browser clients
function addCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS,PUT');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type,POLY_ADDRESS,POLY_SIGNATURE,POLY_TIMESTAMP,' +
    'POLY_NONCE,POLY_API_KEY,POLY_PASSPHRASE,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function ts() { return new Date().toLocaleTimeString(); }
function log(tag, msg) { console.log(`[${ts()}] ${tag.padEnd(8)} ${msg}`); }

// ── Live token cache — fetched fresh from Gamma on startup ───
let LIVE_TOKENS = [];

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, port: 443, path, method: 'GET',
      rejectUnauthorized: false,
      headers: {
        ...BROWSER_HEADERS,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    };
    const req = https.request(opts, res => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        const u = new URL(loc.startsWith('http') ? loc : 'https://' + hostname + loc);
        return httpsGet(u.hostname, u.pathname + u.search).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function parseTokensFromMarkets(markets) {
  const tokens = [];
  for (const m of markets) {
    const raw = m.tokens || m.clobTokenIds;
    if (!raw) continue;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      for (const t of (Array.isArray(parsed) ? parsed : [])) {
        const id = t.token_id || t.tokenId || (typeof t === 'string' ? t : null);
        if (id && typeof id === 'string' && id.length > 20) tokens.push(id);
      }
    } catch {}
    if (tokens.length >= 100) break;
  }
  return tokens;
}

async function fetchLiveTokens() {
  // Try multiple endpoints in order
  const endpoints = [
    { host: GAMMA_HOST, path: '/markets?limit=50&active=true&order=volume&ascending=false' },
    { host: CLOB_HOST,  path: '/sampling-simplified-markets' },
    { host: CLOB_HOST,  path: '/markets?next_cursor=&limit=50' },
  ];

  for (const ep of endpoints) {
    try {
      log('TOKENS', 'Trying ' + ep.host + ep.path.split('?')[0] + '…');
      const body = await httpsGet(ep.host, ep.path);

      // Guard against HTML responses
      if (body.trim().startsWith('<')) {
        log('TOKENS', ep.host + ' returned HTML — blocked, trying next');
        continue;
      }

      const data = JSON.parse(body);
      const markets = Array.isArray(data) ? data : (data.markets || data.data || []);
      if (!markets.length) continue;

      const tokens = parseTokensFromMarkets(markets);
      if (tokens.length > 0) {
        LIVE_TOKENS = tokens;
        log('TOKENS', 'Got ' + tokens.length + ' token IDs from ' + ep.host);
        return LIVE_TOKENS;
      }
    } catch(e) {
      log('TOKENS', ep.host + ' failed: ' + e.message);
    }
  }

  // Last resort: use known long-lived token IDs for major ongoing markets
  log('TOKENS', 'All endpoints blocked — using fallback known tokens');
  LIVE_TOKENS = [
    // These are token IDs for markets that run continuously
    '69236923620077691027083946871148767382819025171534030773872450204158838140620',
    '21742633143463906290569050155826241533067272736897614950488156847949938836455',
    '48331043336612883890938759509493159234755048973500640148014422747788308965732',
    '52114319501245915516055106046884209969926127482827954674443846427813813222429',
    '71321045679252212594626385532706912750332728571942532289631379312455583992563',
    '65818619657568813474341868652308942079804919287380422192892211131408793125422',
    '52114319501245915516055106046884209969926127482827954674443846427813813222426',
    '85354956062430465315924116860125388538595433819574542752031640332592237464430',
    '28558870151745004555804828152827571810437151803552038512264671979506746939983',
    '114122071509644379678018727908709560226618148003371446110114509806601493071694',
  ];
  return LIVE_TOKENS;
}

// ── HTTP Proxy ───────────────────────────────────────────────
function proxyHttp(req, res, targetHost, targetPath) {
  return new Promise((resolve) => {
    const authHeaders = {};
    ['POLY_ADDRESS','POLY_SIGNATURE','POLY_TIMESTAMP',
     'POLY_NONCE','POLY_API_KEY','POLY_PASSPHRASE'].forEach(h => {
      const v = req.headers[h.toLowerCase()];
      if (v) authHeaders[h] = v;
    });

    const options = {
      hostname: targetHost,
      port: 443,
      path: targetPath,
      method: req.method,
      rejectUnauthorized: false,
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': req.headers['content-type'] || 'application/json',
        ...authHeaders,
      },
    };

    const upstream = https.request(options, (upRes) => {
      log('HTTP', `${upRes.statusCode} ← ${targetHost}${targetPath.split('?')[0]}`);
      addCors(res);
      // Stream response with correct headers
      const outHeaders = { 'Content-Type': upRes.headers['content-type'] || 'application/json' };
      if (upRes.headers['content-encoding']) outHeaders['Content-Encoding'] = upRes.headers['content-encoding'];
      res.writeHead(upRes.statusCode, outHeaders);
      upRes.pipe(res);
      upRes.on('end', resolve);
    });

    upstream.on('error', (e) => {
      log('ERROR', e.message);
      addCors(res);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upstream error', message: e.message }));
      resolve();
    });

    if (['POST','PUT','DELETE'].includes(req.method)) {
      req.pipe(upstream);
    } else {
      upstream.end();
    }
  });
}

// ── WebSocket Proxy ──────────────────────────────────────────
// Browser connects: ws://your-server/ws/market
// We forward to:    wss://ws-subscriptions-clob.polymarket.com/ws/market
function proxyWebSocket(req, socket, head) {
  const targetPath = req.url; // /ws/market etc.
  log('WSS', `Upgrading → ${WS_HOST}${targetPath}`);

  // Connect to Polymarket WS over TLS
  const upstream = net.createConnection({ host: WS_HOST, port: 443 });

  // We need to do the TLS handshake ourselves to get a raw socket
  const tlsSocket = require('tls').connect({
    host: WS_HOST,
    port: 443,
    socket: upstream,
    rejectUnauthorized: false,
    servername: WS_HOST,
  });

  tlsSocket.on('connect', () => {
    // Forward the upgrade request to upstream with correct headers
    const upgradeReq = [
      `GET ${targetPath} HTTP/1.1`,
      `Host: ${WS_HOST}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Sec-WebSocket-Key: ${req.headers['sec-websocket-key'] || 'dGhlIHNhbXBsZSBub25jZQ=='}`,
      `Sec-WebSocket-Version: ${req.headers['sec-websocket-version'] || '13'}`,
      `Origin: https://polymarket.com`,
      `User-Agent: ${BROWSER_HEADERS['User-Agent']}`,
      '',
      '',
    ].join('\r\n');

    tlsSocket.write(upgradeReq);
  });

  let upgraded = false;
  let buffer = Buffer.alloc(0);

  tlsSocket.on('data', (chunk) => {
    if (!upgraded) {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      // Send 101 Switching Protocols back to browser
      const responseHeaders = buffer.slice(0, headerEnd).toString();
      const wsKey = req.headers['sec-websocket-key'];
      const crypto = require('crypto');
      const accept = crypto.createHash('sha1')
        .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n'
      );

      upgraded = true;
      // Forward any data after the headers
      const rest = buffer.slice(headerEnd + 4);
      if (rest.length > 0) socket.write(rest);
    } else {
      // Pipe WS frames bidirectionally
      socket.write(chunk);
    }
  });

  // Browser → Polymarket
  socket.on('data', (chunk) => {
    if (tlsSocket.writable) tlsSocket.write(chunk);
  });

  tlsSocket.on('error', (e) => {
    log('WSS ERR', e.message);
    socket.destroy();
  });

  socket.on('error', () => tlsSocket.destroy());
  socket.on('close', () => tlsSocket.destroy());
  tlsSocket.on('close', () => socket.destroy());
}

// ── Status endpoint ──────────────────────────────────────────
function serveStatus(res) {
  addCors(res);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    server: 'PolyARB Cloud Proxy v4',
    uptime: Math.floor(process.uptime()) + 's',
    timestamp: new Date().toISOString(),
    proxies: {
      gamma:  `https://${GAMMA_HOST}`,
      clob:   `https://${CLOB_HOST}`,
      ws:     `wss://${WS_HOST}`,
    },
    note: 'WebSocket: connect to ws://THIS_SERVER/ws/market'
  }));
}

// ── Static file server ───────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

function serveStatic(req, res, filePath) {
  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found');
    } else {
      addCors(res);
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    }
  });
}

// ── Main HTTP server ─────────────────────────────────────────
const server = http.createServer((req, res) => {
  const reqUrl   = new URL(req.url, 'http://localhost');
  const pathname = reqUrl.pathname;
  const search   = reqUrl.search || '';

  // Preflight
  if (req.method === 'OPTIONS') { addCors(res); res.writeHead(204); res.end(); return; }

  log(req.method, pathname);

  // Status
  if (pathname === '/status' || pathname === '/health') { serveStatus(res); return; }

  // Live token IDs endpoint — used by bot to subscribe to fresh markets
  if (pathname === '/tokens') {
    addCors(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tokens: LIVE_TOKENS, count: LIVE_TOKENS.length, ts: Date.now() }));
    return;
  }

  // Gamma API proxy: /api/gamma/* → gamma-api.polymarket.com/*
  if (pathname.startsWith('/api/gamma/')) {
    const up = pathname.replace('/api/gamma', '') + search;
    log('→GAMMA', up.split('?')[0]);
    proxyHttp(req, res, GAMMA_HOST, up);
    return;
  }

  // CLOB API proxy: /api/clob/* → clob.polymarket.com/*
  if (pathname.startsWith('/api/clob/')) {
    const up = pathname.replace('/api/clob', '') + search;
    log('→CLOB', up.split('?')[0]);
    proxyHttp(req, res, CLOB_HOST, up);
    return;
  }

  // Static files from ./public
  let filePath = pathname === '/' || pathname === '/index.html'
    ? path.join(__dirname, 'public', 'index.html')
    : path.join(__dirname, 'public', pathname);

  const publicDir = path.resolve(__dirname, 'public');
  if (!path.resolve(filePath).startsWith(publicDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  serveStatic(req, res, filePath);
});

// WebSocket upgrade handler
server.on('upgrade', (req, socket, head) => {
  const pathname = req.url;
  // /ws/* → ws-subscriptions-clob.polymarket.com/*
  if (pathname.startsWith('/ws/')) {
    proxyWebSocket(req, socket, head);
  } else {
    socket.destroy();
  }
});

// Fetch live tokens before starting
fetchLiveTokens().then(() => {
  setInterval(fetchLiveTokens, 10 * 60 * 1000); // refresh every 10 min
});

server.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║      PolyARB Cloud Proxy v4 — Ready           ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`\n  ✓ HTTP server:   http://localhost:${PORT}`);
  console.log(`  ✓ Bot UI:        http://localhost:${PORT}/`);
  console.log(`  ✓ Status:        http://localhost:${PORT}/status`);
  console.log('\n  Routes:');
  console.log(`  /api/gamma/* → https://${GAMMA_HOST}/*`);
  console.log(`  /api/clob/*  → https://${CLOB_HOST}/*`);
  console.log(`  /ws/*        → wss://${WS_HOST}/*  (WebSocket)`);
  console.log('\n  Deploy to Render.com for free cloud hosting.\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} in use. Try: PORT=3001 node server.js`);
  else console.error('Server error:', e);
  process.exit(1);
});
