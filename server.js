/**
 * PolyARB Cloud Proxy Server v5
 * ─────────────────────────────
 * Strategy: Server polls Polymarket HTTP APIs every 5s and streams
 * data to browser via Server-Sent Events (SSE).
 * No WebSocket tunnel needed — SSE has no CORS issues.
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3000;

const GAMMA_HOST = 'gamma-api.polymarket.com';
const CLOB_HOST  = 'clob.polymarket.com';

const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin':          'https://polymarket.com',
  'Referer':         'https://polymarket.com/',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

function addCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS,PUT');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type,POLY_ADDRESS,POLY_SIGNATURE,POLY_TIMESTAMP,POLY_NONCE,POLY_API_KEY,POLY_PASSPHRASE');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function ts() { return new Date().toLocaleTimeString(); }
function log(tag, msg) { console.log(`[${ts()}] ${tag.padEnd(8)} ${msg}`); }

// ── HTTPS fetch helper ───────────────────────────────────────
function httpsGet(hostname, urlPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, port: 443, path: urlPath, method: 'GET',
      rejectUnauthorized: false,
      headers: { ...BROWSER_HEADERS, ...extraHeaders },
    };
    const req = https.request(opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        const u = new URL(loc.startsWith('http') ? loc : 'https://' + hostname + loc);
        return httpsGet(u.hostname, u.pathname + u.search).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + body.slice(0,100)));
        if (body.trim().startsWith('<')) return reject(new Error('Got HTML (blocked)'));
        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── Market data cache ────────────────────────────────────────
let MARKETS_CACHE = [];
let PRICES_CACHE  = {};   // tokenId -> { yes, no, spread, total }
let lastMarketFetch = 0;
let lastPriceFetch  = 0;
let SSE_CLIENTS = new Set();

async function fetchMarkets() {
  try {
    const body = await httpsGet(GAMMA_HOST, '/markets?limit=100&active=true&order=volume&ascending=false');
    const markets = JSON.parse(body);
    if (!Array.isArray(markets)) return;
    MARKETS_CACHE = markets;
    lastMarketFetch = Date.now();
    log('MARKETS', 'Fetched ' + markets.length + ' markets');
    broadcastToClients({ type: 'markets', data: markets });
  } catch(e) {
    log('MARKETS', 'Failed: ' + e.message);
  }
}

async function fetchPrices() {
  if (!MARKETS_CACHE.length) return;
  // Build arb opportunities directly from market data
  const opps = [];
  for (const m of MARKETS_CACHE) {
    try {
      let prices = m.outcomePrices;
      if (!prices) continue;
      if (typeof prices === 'string') prices = JSON.parse(prices);
      const nums = prices.map(Number).filter(n => !isNaN(n) && n > 0);
      if (nums.length < 2) continue;
      const total = nums.reduce((a,b)=>a+b,0);
      const spread = parseFloat(((1-total)*100).toFixed(2));
      if (Math.abs(spread) < 0.2) continue;

      let outcomes = m.outcomes;
      if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes);

      opps.push({
        id: m.id,
        name: m.question || m.title || 'Market',
        cat: m.category || 'General',
        type: nums.length === 2 ? 'binary' : 'multi',
        prices: nums,
        outcomes: outcomes || ['Yes','No'],
        spread: Math.abs(spread),
        impliedTotal: parseFloat((total*100).toFixed(1)),
        volume: parseFloat(m.volume || 0),
        slug: m.slug || m.id || '',
        tokens: m.tokens || null,
      });
    } catch {}
  }
  opps.sort((a,b)=>b.spread-a.spread);
  log('PRICES', 'Found ' + opps.length + ' arb opportunities from ' + MARKETS_CACHE.length + ' markets');
  broadcastToClients({ type: 'opportunities', data: opps });
}

function broadcastToClients(obj) {
  const msg = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const client of SSE_CLIENTS) {
    try { client.write(msg); } catch {}
  }
}

// Poll every 10s
async function pollLoop() {
  await fetchMarkets();
  await fetchPrices();
  setInterval(async () => {
    await fetchMarkets();
    await fetchPrices();
  }, 10000);
}

// ── HTTP proxy (for CLOB authenticated requests) ─────────────
function proxyHttp(req, res, targetHost, targetPath) {
  return new Promise((resolve) => {
    const authHeaders = {};
    ['POLY_ADDRESS','POLY_SIGNATURE','POLY_TIMESTAMP',
     'POLY_NONCE','POLY_API_KEY','POLY_PASSPHRASE'].forEach(h => {
      const v = req.headers[h.toLowerCase()];
      if (v) authHeaders[h] = v;
    });

    const opts = {
      hostname: targetHost, port: 443, path: targetPath,
      method: req.method, rejectUnauthorized: false,
      headers: { ...BROWSER_HEADERS,
        'Content-Type': req.headers['content-type'] || 'application/json',
        ...authHeaders },
    };

    const upstream = https.request(opts, upRes => {
      log('HTTP', upRes.statusCode + ' ← ' + targetHost + targetPath.split('?')[0]);
      addCors(res);
      res.writeHead(upRes.statusCode, {
        'Content-Type': upRes.headers['content-type'] || 'application/json',
      });
      upRes.pipe(res);
      upRes.on('end', resolve);
    });
    upstream.on('error', e => {
      addCors(res); res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error: e.message})); resolve();
    });
    if (['POST','PUT','DELETE'].includes(req.method)) req.pipe(upstream);
    else upstream.end();
  });
}

// ── Static files ─────────────────────────────────────────────
function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    addCors(res);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}

// ── Main server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const reqUrl   = new URL(req.url, 'http://localhost');
  const pathname = reqUrl.pathname;
  const search   = reqUrl.search || '';

  if (req.method === 'OPTIONS') { addCors(res); res.writeHead(204); res.end(); return; }

  log(req.method, pathname);

  // SSE stream — browser subscribes here for live data
  if (pathname === '/stream') {
    addCors(res);
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"connected","msg":"SSE stream connected"}\n\n');
    SSE_CLIENTS.add(res);
    log('SSE', 'Client connected. Total: ' + SSE_CLIENTS.size);

    // Send current data immediately
    if (MARKETS_CACHE.length) {
      res.write('data: ' + JSON.stringify({type:'markets', data: MARKETS_CACHE}) + '\n\n');
    }

    // Keepalive ping
    const ping = setInterval(() => {
      try { res.write(':ping\n\n'); } catch { clearInterval(ping); }
    }, 20000);

    req.on('close', () => {
      SSE_CLIENTS.delete(res);
      clearInterval(ping);
      log('SSE', 'Client disconnected. Total: ' + SSE_CLIENTS.size);
    });
    return;
  }

  // Status
  if (pathname === '/status' || pathname === '/health') {
    addCors(res);
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({
      status: 'ok', server: 'PolyARB Proxy v5 (SSE)',
      uptime: Math.floor(process.uptime())+'s',
      markets: MARKETS_CACHE.length,
      clients: SSE_CLIENTS.size,
      lastFetch: new Date(lastMarketFetch).toISOString(),
    }));
    return;
  }

  // Markets snapshot
  if (pathname === '/markets') {
    addCors(res);
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(MARKETS_CACHE));
    return;
  }

  // Gamma proxy
  if (pathname.startsWith('/api/gamma/')) {
    proxyHttp(req, res, GAMMA_HOST, pathname.replace('/api/gamma','') + search);
    return;
  }

  // CLOB proxy
  if (pathname.startsWith('/api/clob/')) {
    proxyHttp(req, res, CLOB_HOST, pathname.replace('/api/clob','') + search);
    return;
  }

  // Static files
  const filePath = (pathname === '/' || pathname === '/index.html')
    ? path.join(__dirname, 'public', 'index.html')
    : path.join(__dirname, 'public', pathname);

  const pub = path.resolve(__dirname, 'public');
  if (!path.resolve(filePath).startsWith(pub)) { res.writeHead(403); res.end(); return; }
  serveStatic(res, filePath);
});

server.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║   PolyARB Cloud Proxy v5 — SSE Edition        ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('\n  ✓ URL:     http://localhost:' + PORT);
  console.log('  ✓ Stream:  http://localhost:' + PORT + '/stream  (SSE)');
  console.log('  ✓ Markets: http://localhost:' + PORT + '/markets');
  console.log('  ✓ Status:  http://localhost:' + PORT + '/status\n');
  pollLoop();
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error('Port ' + PORT + ' in use.');
  else console.error(e);
  process.exit(1);
});
