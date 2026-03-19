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
  const tls = require('tls');
  const crypto = require('crypto');
  const targetPath = req.url; // e.g. /ws/market
  log('WSS', 'Tunneling → ' + WS_HOST + targetPath);

  // Open a TLS connection directly to Polymarket WS host
  const upstream = tls.connect({
    host: WS_HOST,
    port: 443,
    rejectUnauthorized: false,
    servername: WS_HOST,
  });

  upstream.on('secureConnect', () => {
    log('WSS', 'TLS handshake OK — sending HTTP upgrade');

    // Generate a proper WebSocket key
    const wsKey = crypto.randomBytes(16).toString('base64');

    const upgradeReq = [
      'GET ' + targetPath + ' HTTP/1.1',
      'Host: ' + WS_HOST,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + wsKey,
      'Sec-WebSocket-Version: 13',
      'Origin: https://polymarket.com',
      'User-Agent: ' + BROWSER_HEADERS['User-Agent'],
      '',
      '',
    ].join('\r\n');

    upstream.write(upgradeReq);
  });

  let handshakeDone = false;
  let buf = Buffer.alloc(0);

  upstream.on('data', (chunk) => {
    if (!handshakeDone) {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf('\r\n\r\n');
      if (sep === -1) return;

      const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString();
      log('WSS', 'Upstream response: ' + statusLine);

      if (!statusLine.includes('101')) {
        log('WSS ERR', 'Upstream did not upgrade: ' + statusLine);
        socket.destroy();
        upstream.destroy();
        return;
      }

      // Compute Sec-WebSocket-Accept for the BROWSER using the browser's key
      const browserKey = req.headers['sec-websocket-key'];
      const accept = crypto
        .createHash('sha1')
        .update(browserKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      // Tell browser: upgrade complete
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n' +
        '\r\n'
      );

      handshakeDone = true;
      log('WSS', 'Tunnel established — piping frames bidirectionally');

      // Forward any WS data that came with the handshake response
      const rest = buf.slice(sep + 4);
      if (rest.length > 0) socket.write(rest);
    } else {
      // Live: pipe Polymarket → browser
      if (socket.writable) {
        socket.write(chunk);
        // Log first few messages from Polymarket
        try {
          const txt = chunk.toString('utf8');
          if (txt.includes('event_type') || txt.includes('price')) {
            log('UP→WSS', 'Polymarket sent: ' + txt.slice(0, 100));
          }
        } catch {}
      }
    }
  });

  // Live: pipe browser → Polymarket
  socket.on('data', (chunk) => {
    if (upstream.writable) {
      upstream.write(chunk);
      // Log first few messages from browser (subscription messages)
      try {
        const txt = chunk.toString('utf8');
        if (txt.includes('assets_ids') || txt.includes('subscribe')) {
          log('WSS→UP', 'Browser sent: ' + txt.slice(0, 120));
        }
      } catch {}
    }
  });

  upstream.on('error', (e) => {
    log('WSS ERR', 'Upstream: ' + e.message);
    if (!socket.destroyed) socket.destroy();
  });

  upstream.on('close', () => {
    log('WSS', 'Upstream closed');
    if (!socket.destroyed) socket.destroy();
  });

  socket.on('error', (e) => {
    log('WSS ERR', 'Browser socket: ' + e.message);
    if (!upstream.destroyed) upstream.destroy();
  });

  socket.on('close', () => {
    if (!upstream.destroyed) upstream.destroy();
  });
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
  log('UPGRADE', 'WebSocket upgrade request: ' + pathname);
  // /ws/* → ws-subscriptions-clob.polymarket.com/*
  if (pathname.startsWith('/ws/')) {
    proxyWebSocket(req, socket, head);
  } else {
    log('UPGRADE', 'Rejected unknown WS path: ' + pathname);
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
