/**
 * PolyARB Cloud Proxy v6
 * ──────────────────────
 * Uses Goldsky public GraphQL subgraph — no auth, no geo-blocking.
 * Falls back to Gamma API if Goldsky works.
 * Streams data to browser via SSE every 15s.
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3000;

// Public endpoints — no API key, no geo-blocking
const GOLDSKY_HOST = 'api.goldsky.com';
const GOLDSKY_PATH = '/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn';
const GAMMA_HOST   = 'gamma-api.polymarket.com';
const CLOB_HOST    = 'clob.polymarket.com';

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS,PUT');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type,POLY_ADDRESS,POLY_SIGNATURE,POLY_TIMESTAMP,POLY_NONCE,POLY_API_KEY,POLY_PASSPHRASE');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function ts()  { return new Date().toLocaleTimeString(); }
function log(tag, msg) { console.log(`[${ts()}] ${tag.padEnd(8)} ${msg}`); }

// ── Generic HTTPS request ─────────────────────────────────────
function httpsReq(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ rejectUnauthorized: false, ...opts }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error('HTTP ' + res.statusCode + ': ' + text.slice(0, 200)));
        resolve(text);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Goldsky GraphQL — public, no auth ────────────────────────
async function fetchFromGoldsky() {
  const query = `{
    fixedProductMarketMakers(
      first: 100
      orderBy: scaledCollateralVolume
      orderDirection: desc
      where: { outcomeSlotCount: 2 }
    ) {
      id
      outcomeTokenPrices
      outcomeTokenMarginalPrices
      scaledCollateralVolume
      conditions { id }
    }
  }`;

  const bodyStr = JSON.stringify({ query });
  const text = await httpsReq({
    hostname: GOLDSKY_HOST,
    port: 443,
    path: GOLDSKY_PATH,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'User-Agent': BROWSER_HEADERS['User-Agent'],
    },
  }, bodyStr);

  const data = JSON.parse(text);
  if (data.errors) throw new Error(JSON.stringify(data.errors[0]));
  return data.data.fixedProductMarketMakers || [];
}

// ── Gamma API ─────────────────────────────────────────────────
async function fetchFromGamma() {
  const text = await httpsReq({
    hostname: GAMMA_HOST, port: 443,
    path: '/markets?limit=100&active=true&order=volume&ascending=false',
    method: 'GET',
    headers: BROWSER_HEADERS,
  });
  if (text.trim().startsWith('<')) throw new Error('Got HTML (geo-blocked)');
  return JSON.parse(text);
}

// ── Build arb opportunities ───────────────────────────────────
function buildOppsFromGoldsky(makers) {
  const opps = [];
  for (const m of makers) {
    try {
      let prices = m.outcomeTokenMarginalPrices || m.outcomeTokenPrices;
      if (!prices || !Array.isArray(prices)) continue;
      const nums = prices.map(Number).filter(n => !isNaN(n) && n > 0 && n < 1);
      if (nums.length < 2) continue;
      const total = nums.reduce((a, b) => a + b, 0);
      const spread = parseFloat(((1 - total) * 100).toFixed(2));
      if (Math.abs(spread) < 0.3) continue;
      opps.push({
        id: m.id,
        name: 'Market ' + m.id.slice(0, 10) + '…',
        cat: 'Prediction',
        type: 'binary',
        prices: nums,
        outcomes: ['Yes', 'No'],
        spread: Math.abs(spread),
        impliedTotal: parseFloat((total * 100).toFixed(1)),
        volume: parseFloat(m.scaledCollateralVolume || 0),
        slug: m.id,
        tokens: null,
        source: 'goldsky',
      });
    } catch {}
  }
  return opps.sort((a, b) => b.spread - a.spread);
}

function buildOppsFromGamma(markets) {
  const opps = [];
  for (const m of markets) {
    try {
      let prices = m.outcomePrices;
      if (!prices) continue;
      if (typeof prices === 'string') prices = JSON.parse(prices);
      const nums = prices.map(Number).filter(n => !isNaN(n) && n > 0);
      if (nums.length < 2) continue;
      const total = nums.reduce((a, b) => a + b, 0);
      const spread = parseFloat(((1 - total) * 100).toFixed(2));
      if (Math.abs(spread) < 0.2) continue;
      let outcomes = m.outcomes;
      if (typeof outcomes === 'string') try { outcomes = JSON.parse(outcomes); } catch {}
      opps.push({
        id: m.id,
        name: m.question || m.title || 'Market',
        cat: m.category || 'General',
        type: nums.length === 2 ? 'binary' : 'multi',
        prices: nums,
        outcomes: outcomes || ['Yes', 'No'],
        spread: Math.abs(spread),
        impliedTotal: parseFloat((total * 100).toFixed(1)),
        volume: parseFloat(m.volume || 0),
        slug: m.slug || m.id || '',
        tokens: m.tokens || null,
        source: 'gamma',
      });
    } catch {}
  }
  return opps.sort((a, b) => b.spread - a.spread);
}

// ── Data cache & SSE ──────────────────────────────────────────
let CACHED_OPPS = [];
let DATA_SOURCE = 'none';
let LAST_FETCH = 0;
const SSE_CLIENTS = new Set();

function broadcast(obj) {
  const msg = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const client of SSE_CLIENTS) {
    try { client.write(msg); } catch {}
  }
}

async function pollData() {
  log('POLL', 'Fetching market data…');

  // Try Gamma first (richer data with names), fall back to Goldsky
  let opps = [];
  let source = '';

  try {
    const markets = await fetchFromGamma();
    opps = buildOppsFromGamma(markets);
    source = 'Gamma API (' + markets.length + ' markets)';
    log('GAMMA', 'OK — ' + markets.length + ' markets, ' + opps.length + ' opps');
  } catch(e) {
    log('GAMMA', 'Failed: ' + e.message + ' — trying Goldsky…');
    try {
      const makers = await fetchFromGoldsky();
      opps = buildOppsFromGoldsky(makers);
      source = 'Goldsky subgraph (' + makers.length + ' markets)';
      log('GOLDSKY', 'OK — ' + makers.length + ' markets, ' + opps.length + ' opps');
    } catch(e2) {
      log('GOLDSKY', 'Failed: ' + e2.message);
    }
  }

  if (opps.length > 0) {
    CACHED_OPPS = opps;
    DATA_SOURCE = source;
    LAST_FETCH = Date.now();
    broadcast({ type: 'opportunities', data: opps, source, ts: LAST_FETCH });
    log('PUSH', 'Broadcast ' + opps.length + ' opps to ' + SSE_CLIENTS.size + ' clients via ' + source);
  } else {
    log('POLL', 'No opportunities found from any source');
    broadcast({ type: 'status', msg: 'No data available — retrying…' });
  }
}

// ── HTTP proxy for CLOB ───────────────────────────────────────
function proxyHttp(req, res, targetHost, targetPath) {
  return new Promise(resolve => {
    const authH = {};
    ['POLY_ADDRESS','POLY_SIGNATURE','POLY_TIMESTAMP','POLY_NONCE','POLY_API_KEY','POLY_PASSPHRASE']
      .forEach(h => { const v = req.headers[h.toLowerCase()]; if (v) authH[h] = v; });

    const opts = {
      hostname: targetHost, port: 443, path: targetPath,
      method: req.method, rejectUnauthorized: false,
      headers: { ...BROWSER_HEADERS, 'Content-Type': req.headers['content-type']||'application/json', ...authH },
    };
    const up = https.request(opts, upRes => {
      log('HTTP', upRes.statusCode + ' ← ' + targetHost);
      addCors(res);
      res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type']||'application/json' });
      upRes.pipe(res);
      upRes.on('end', resolve);
    });
    up.on('error', e => { addCors(res); res.writeHead(502); res.end(JSON.stringify({error:e.message})); resolve(); });
    if (['POST','PUT','DELETE'].includes(req.method)) req.pipe(up); else up.end();
  });
}

function serveStatic(res, fp) {
  const ext = path.extname(fp);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    addCors(res);
    res.writeHead(200, { 'Content-Type': MIME[ext]||'text/plain' });
    res.end(data);
  });
}

// ── Server ────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname, q = u.search || '';

  if (req.method === 'OPTIONS') { addCors(res); res.writeHead(204); res.end(); return; }

  log(req.method, p);

  // SSE stream
  if (p === '/stream') {
    addCors(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"connected","msg":"PolyARB SSE stream ready"}\n\n');
    SSE_CLIENTS.add(res);
    log('SSE', 'Client connected. Total: ' + SSE_CLIENTS.size);

    // Send cached data immediately
    if (CACHED_OPPS.length > 0) {
      res.write('data: ' + JSON.stringify({ type:'opportunities', data:CACHED_OPPS, source:DATA_SOURCE, ts:LAST_FETCH }) + '\n\n');
    }

    const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch { clearInterval(ping); } }, 25000);
    req.on('close', () => { SSE_CLIENTS.delete(res); clearInterval(ping); log('SSE', 'Client left. Total: ' + SSE_CLIENTS.size); });
    return;
  }

  // Status
  if (p === '/status' || p === '/health') {
    addCors(res); res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ status:'ok', server:'PolyARB v6 SSE', uptime:Math.floor(process.uptime())+'s',
      opps:CACHED_OPPS.length, clients:SSE_CLIENTS.size, source:DATA_SOURCE,
      lastFetch: LAST_FETCH ? new Date(LAST_FETCH).toISOString() : 'never' }));
    return;
  }

  // CLOB proxy
  if (p.startsWith('/api/clob/')) { proxyHttp(req, res, CLOB_HOST, p.replace('/api/clob','') + q); return; }
  // Gamma proxy (for direct browser fetches)
  if (p.startsWith('/api/gamma/')) { proxyHttp(req, res, GAMMA_HOST, p.replace('/api/gamma','') + q); return; }

  // Static
  const fp = (p==='/'||p==='/index.html')
    ? path.join(__dirname,'public','index.html')
    : path.join(__dirname,'public',p);
  if (!path.resolve(fp).startsWith(path.resolve(__dirname,'public'))) { res.writeHead(403); res.end(); return; }
  serveStatic(res, fp);
});

server.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║   PolyARB Cloud Proxy v6 — SSE + Goldsky      ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('\n  ✓ URL:    http://localhost:' + PORT);
  console.log('  ✓ Stream: http://localhost:' + PORT + '/stream');
  console.log('  ✓ Status: http://localhost:' + PORT + '/status');
  console.log('\n  Data: Gamma API → Goldsky subgraph (fallback)\n');
  pollData();
  setInterval(pollData, 15000);
});

server.on('error', e => { console.error(e); process.exit(1); });
