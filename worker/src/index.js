// Card Card Fruit – PSA 查詢後台（Cloudflare Worker）
//
// App 只會同呢個後台傾，PSA 通行證（PSA_TOKEN）只存喺 Cloudflare 嘅 secret，
// 唔會出現喺網頁或者 GitHub。
//
// 路徑：
//   GET    /api/cert/:certNumber            用證書編號查 PSA 證書
//   POST   /api/track  {group, invoice}      用團號 + 帳單號碼查 PSA 送評進度
//   GET    /api/admin/records/:invoice      （店舖用）睇一張帳單記錄
//   PUT    /api/admin/records/:invoice      （店舖用）新增或更新帳單記錄
//   DELETE /api/admin/records/:invoice      （店舖用）刪除帳單記錄
//
// 需要嘅設定（見 README.md）：
//   PSA_TOKEN      secret，PSA Public API 嘅 access token
//   ADMIN_KEY      secret，店舖管理帳單記錄用嘅密碼
//   ALLOWED_ORIGIN var，app 嘅網址來源，例如 https://claudemic888-star.github.io
//   RECORDS        KV namespace，存帳單號碼同團號嘅對應

const PSA_BASE = 'https://api.psacard.com/publicapi';
const CERT_TTL = 24 * 60 * 60; // 證書資料唔會變，暫存一日
const TRACK_TTL = 15 * 60; // 送評進度暫存 15 分鐘，慳 PSA 每日次數
const RATE_LIMIT = 30; // 每個 IP 每 10 分鐘最多 30 次查詢
const RATE_WINDOW_MS = 10 * 60 * 1000;

const hits = new Map(); // 每個 Worker 實例各自計數，屬盡力而為嘅防濫用

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '');

      if (path.startsWith('/api/admin/records/')) {
        return withCors(await handleAdmin(request, env, decodeURIComponent(path.slice('/api/admin/records/'.length))), cors);
      }

      if (!allowed(request)) return withCors(json({ error: 'too_many_requests' }, 429), cors);

      if (request.method === 'GET' && path.startsWith('/api/cert/')) {
        return withCors(await handleCert(decodeURIComponent(path.slice('/api/cert/'.length)), env, ctx), cors);
      }
      if (request.method === 'POST' && path === '/api/track') {
        let body;
        try { body = await request.json(); } catch { return withCors(json({ error: 'bad_request' }, 400), cors); }
        return withCors(await handleTrack(body, env, ctx), cors);
      }
      return withCors(json({ error: 'not_found' }, 404), cors);
    } catch (err) {
      if (err instanceof UpstreamError) return withCors(json({ error: err.code }, err.status), cors);
      console.error(err);
      return withCors(json({ error: 'server_error' }, 500), cors);
    }
  }
};

// ---------- 證書查詢 ----------

async function handleCert(raw, env, ctx) {
  const cert = String(raw || '').trim();
  if (!/^\d{5,12}$/.test(cert)) return json({ error: 'invalid_cert' }, 400);

  const data = await psaGet(`/cert/GetByCertNumber/${cert}`, env, ctx, CERT_TTL);
  const c = data && data.PSACert;
  if (!c || !c.CertNumber) return json({ found: false }, 200);

  return json({ found: true, cert: certView(c) }, 200);
}

function certView(c) {
  return {
    number: c.CertNumber,
    grade: c.CardGrade || '',
    gradeDescription: c.GradeDescription || '',
    year: c.Year || '',
    brand: c.Brand || '',
    category: c.Category || '',
    cardNumber: c.CardNumber || '',
    subject: c.Subject || '',
    variety: c.Variety || '',
    labelType: c.LabelType || '',
    population: numOrNull(c.TotalPopulation),
    populationHigher: numOrNull(c.PopulationHigher)
  };
}

// ---------- 團號 + 帳單號碼查進度 ----------

async function handleTrack(body, env, ctx) {
  const group = String((body && body.group) || '').trim();
  const invoice = normInvoice(body && body.invoice);
  if (!/^[A-Za-z0-9-]{4,30}$/.test(group) || !/^[A-Z0-9-]{3,30}$/.test(invoice)) {
    return json({ error: 'bad_request' }, 400);
  }

  // 帳單號碼同團號要喺本店記錄對得上，先會問 PSA。
  // 對唔上同搵唔到用同一個回應，免得有人逐個號碼試。
  const rec = await env.RECORDS.get(`inv:${invoice}`, 'json');
  if (!rec || String(rec.group).trim() !== group) return json({ matched: false }, 200);

  const endpoint = rec.type === 'order' ? 'GetProgress' : 'GetSubmissionProgress';
  const p = await psaGet(`/order/${endpoint}/${encodeURIComponent(group)}`, env, ctx, TRACK_TTL);
  if (!p || !Array.isArray(p.orderProgressSteps)) return json({ matched: true, found: false }, 200);

  const steps = p.orderProgressSteps
    .slice()
    .sort((a, b) => (a.index ?? a.step) - (b.index ?? b.step))
    .map((s) => ({ step: s.step, completed: !!s.completed }));

  // 評級公佈咗，先去攞店舖登記咗嘅證書資料（每張證書暫存一日）。
  let certs = [];
  if (p.gradesReady && Array.isArray(rec.certs) && rec.certs.length) {
    certs = await Promise.all(rec.certs.slice(0, 50).map(async (n) => {
      try {
        const d = await psaGet(`/cert/GetByCertNumber/${encodeURIComponent(n)}`, env, ctx, CERT_TTL);
        return d && d.PSACert && d.PSACert.CertNumber ? certView(d.PSACert) : { number: String(n), missing: true };
      } catch {
        return { number: String(n), missing: true };
      }
    }));
  }

  return json({
    matched: true,
    found: true,
    group,
    invoice,
    cards: rec.cards ?? null,
    level: rec.level || '',
    date: rec.date || '',
    progress: {
      steps,
      gradesReady: !!p.gradesReady,
      shipped: !!p.shipped,
      problemOrder: !!p.problemOrder,
      accountingHold: !!p.accountingHold,
      readyForLabelReview: !!p.readyForLabelReview,
      shipCarrier: p.shipCarrier || '',
      shipTrackingNumber: p.shipTrackingNumber || ''
    },
    certs,
    checkedAt: new Date().toISOString()
  }, 200);
}

// ---------- 店舖管理帳單記錄 ----------

async function handleAdmin(request, env, rawInvoice) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.ADMIN_KEY || !safeEqual(auth, `Bearer ${env.ADMIN_KEY}`)) return json({ error: 'unauthorized' }, 401);

  const invoice = normInvoice(rawInvoice);
  if (!/^[A-Z0-9-]{3,30}$/.test(invoice)) return json({ error: 'bad_invoice' }, 400);
  const key = `inv:${invoice}`;

  if (request.method === 'GET') {
    const rec = await env.RECORDS.get(key, 'json');
    return rec ? json({ invoice, ...rec }, 200) : json({ error: 'not_found' }, 404);
  }
  if (request.method === 'DELETE') {
    await env.RECORDS.delete(key);
    return json({ deleted: invoice }, 200);
  }
  if (request.method === 'PUT') {
    let b;
    try { b = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
    const group = String((b && b.group) || '').trim();
    if (!/^[A-Za-z0-9-]{4,30}$/.test(group)) return json({ error: 'bad_group' }, 400);
    const rec = {
      group,
      type: b.type === 'order' ? 'order' : 'submission',
      cards: Number.isFinite(Number(b.cards)) ? Number(b.cards) : null,
      level: String(b.level || '').slice(0, 60),
      date: String(b.date || '').slice(0, 30),
      certs: Array.isArray(b.certs) ? b.certs.map((x) => String(x).trim()).filter((x) => /^\d{5,12}$/.test(x)).slice(0, 50) : []
    };
    await env.RECORDS.put(key, JSON.stringify(rec));
    return json({ saved: invoice, ...rec }, 200);
  }
  return json({ error: 'method_not_allowed' }, 405);
}

// ---------- PSA 連線 ----------

class UpstreamError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

async function psaGet(path, env, ctx, ttl) {
  if (!env.PSA_TOKEN) throw new UpstreamError('not_configured', 503);

  // 用 Cloudflare 嘅暫存，同一個號碼喺暫存時間內唔會再問 PSA。
  const cacheKey = new Request(`https://psa-cache.internal${path}`);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.json();
  }

  const res = await fetch(PSA_BASE + path, {
    headers: { Authorization: `bearer ${env.PSA_TOKEN}`, Accept: 'application/json' }
  });
  if (res.status === 401 || res.status === 403) throw new UpstreamError('psa_auth_failed', 502);
  if (res.status === 429) throw new UpstreamError('psa_limit_reached', 503);
  if (res.status === 404) return null;
  if (!res.ok) throw new UpstreamError('psa_unavailable', 502);

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { throw new UpstreamError('psa_bad_response', 502); }

  if (cache && data) {
    const toCache = new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` }
    });
    const p = cache.put(cacheKey, toCache);
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
  }
  return data;
}

// ---------- 輔助 ----------

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = String(env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  if (allowedOrigins.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function withCors(res, cors) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
  return r;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function allowed(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_LIMIT) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return true;
}

function normInvoice(v) { return String(v || '').trim().toUpperCase(); }
function numOrNull(v) { return Number.isFinite(v) ? v : null; }

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
