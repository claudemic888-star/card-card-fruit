// 用 Node 內置嘅測試工具，模擬 PSA 回應測試後台。執行：node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ORIGIN = 'https://claudemic888-star.github.io';

function kv(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    async get(k, type) { const v = m.get(k); return v == null ? null : (type === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    _m: m
  };
}

function env(extra = {}) {
  return {
    PSA_TOKEN: 'test-token',
    ADMIN_KEY: 'admin-secret',
    ALLOWED_ORIGIN: ORIGIN,
    RECORDS: kv({
      'inv:CCF-0001': JSON.stringify({ group: '25123456', type: 'submission', cards: 5, level: 'Value', date: '2026-11-01', certs: [] }),
      'inv:CCF-0002': JSON.stringify({ group: '25123457', type: 'order', cards: 2, level: 'Regular', date: '2026-10-01', certs: ['12345678', '99999999'] })
    }),
    ...extra
  };
}

const psaCalls = [];
function mockPsa(routes) {
  globalThis.fetch = async (url, init) => {
    psaCalls.push({ url: String(url), auth: init && init.headers && init.headers.Authorization });
    for (const [re, fn] of routes) if (re.test(String(url))) return fn(String(url));
    return new Response('', { status: 404 });
  };
}
const ok = (obj) => new Response(JSON.stringify(obj), { status: 200 });

let ipCounter = 0;
function req(method, path, body, headers = {}) {
  return new Request('https://api.example.com' + path, {
    method,
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': `10.0.0.${++ipCounter % 250}`, 'Content-Type': 'application/json', ...headers },
    body: body == null ? undefined : JSON.stringify(body)
  });
}
async function call(r, e = env()) {
  const res = await worker.fetch(r, e, { waitUntil() {} });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

const CERT = { PSACert: { CertNumber: '12345678', CardGrade: 'GEM MT 10', GradeDescription: 'GEM MINT 10', Year: '2022', Brand: 'POKEMON JAPANESE', CardNumber: '071', Subject: 'KLEAVOR', Variety: 'FA', TotalPopulation: 2486, PopulationHigher: 0, LabelType: 'LighthouseLabel' } };
const PROGRESS = (gradesReady) => ({
  orderNumber: 'x', problemOrder: false, readyForLabelReview: false, gradesReady, accountingHold: false, shipped: gradesReady,
  shipTrackingNumber: gradesReady ? '1Z999' : '', shipCarrier: gradesReady ? 'UPS' : '',
  orderProgressSteps: [{ index: 2, step: 2, completed: false }, { index: 0, step: 0, completed: true }, { index: 1, step: 1, completed: true }]
});

test('證書查詢：搵到', async () => {
  mockPsa([[/GetByCertNumber\/12345678$/, () => ok(CERT)]]);
  const r = await call(req('GET', '/api/cert/12345678'));
  assert.equal(r.status, 200);
  assert.equal(r.body.found, true);
  assert.equal(r.body.cert.grade, 'GEM MT 10');
  assert.equal(r.body.cert.population, 2486);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(psaCalls.at(-1).auth, 'bearer test-token');
});

test('證書查詢：PSA 冇資料', async () => {
  mockPsa([[/GetByCertNumber/, () => ok({ PSACert: null })]]);
  const r = await call(req('GET', '/api/cert/11111111'));
  assert.deepEqual(r.body, { found: false });
});

test('證書查詢：格式錯唔會問 PSA', async () => {
  const before = psaCalls.length;
  const r = await call(req('GET', '/api/cert/abc'));
  assert.equal(r.status, 400);
  assert.equal(psaCalls.length, before);
});

test('進度：團號同帳單對得上，用 submission 查', async () => {
  mockPsa([[/GetSubmissionProgress\/25123456$/, () => ok(PROGRESS(false))]]);
  const r = await call(req('POST', '/api/track', { group: '25123456', invoice: 'ccf-0001' }));
  assert.equal(r.body.matched, true);
  assert.equal(r.body.found, true);
  assert.deepEqual(r.body.progress.steps.map((s) => s.step), [0, 1, 2]);
  assert.equal(r.body.progress.gradesReady, false);
  assert.deepEqual(r.body.certs, []);
});

test('進度：order 類型用 GetProgress，評級公佈後附上證書', async () => {
  mockPsa([
    [/GetProgress\/25123457$/, () => ok(PROGRESS(true))],
    [/GetByCertNumber\/12345678$/, () => ok(CERT)],
    [/GetByCertNumber\/99999999$/, () => ok({ PSACert: null })]
  ]);
  const r = await call(req('POST', '/api/track', { group: '25123457', invoice: 'CCF-0002' }));
  assert.equal(r.body.progress.shipped, true);
  assert.equal(r.body.progress.shipCarrier, 'UPS');
  assert.equal(r.body.certs.length, 2);
  assert.equal(r.body.certs[0].grade, 'GEM MT 10');
  assert.equal(r.body.certs[1].missing, true);
});

test('進度：對唔上同搵唔到係同一個回應，亦唔會問 PSA', async () => {
  const before = psaCalls.length;
  const a = await call(req('POST', '/api/track', { group: '25123457', invoice: 'CCF-0001' }));
  const b = await call(req('POST', '/api/track', { group: '25123456', invoice: 'CCF-9999' }));
  assert.deepEqual(a.body, { matched: false });
  assert.deepEqual(b.body, { matched: false });
  assert.equal(psaCalls.length, before);
});

test('PSA 通行證失效會回 502，額度用完回 503', async () => {
  mockPsa([[/GetByCertNumber\/22222222/, () => new Response('', { status: 401 })], [/GetByCertNumber\/33333333/, () => new Response('', { status: 429 })]]);
  const a = await call(req('GET', '/api/cert/22222222'));
  const b = await call(req('GET', '/api/cert/33333333'));
  assert.deepEqual([a.status, a.body.error], [502, 'psa_auth_failed']);
  assert.deepEqual([b.status, b.body.error], [503, 'psa_limit_reached']);
});

test('未設定 PSA_TOKEN 會回 503', async () => {
  const r = await call(req('GET', '/api/cert/12345678'), env({ PSA_TOKEN: '' }));
  assert.deepEqual([r.status, r.body.error], [503, 'not_configured']);
});

test('管理：冇密碼唔俾改', async () => {
  const r = await call(req('PUT', '/api/admin/records/CCF-0003', { group: '25123458' }));
  assert.equal(r.status, 401);
});

test('管理：新增、讀取、刪除帳單記錄', async () => {
  const e = env();
  const H = { Authorization: 'Bearer admin-secret' };
  const put = await call(req('PUT', '/api/admin/records/ccf-0003', { group: '25123458', cards: 3, level: 'Value', certs: ['12345678', 'bad'] }, H), e);
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.certs, ['12345678']);
  const get = await call(req('GET', '/api/admin/records/CCF-0003', null, H), e);
  assert.equal(get.body.group, '25123458');
  const del = await call(req('DELETE', '/api/admin/records/CCF-0003', null, H), e);
  assert.equal(del.status, 200);
  assert.equal(await e.RECORDS.get('inv:CCF-0003'), null);
});

test('其他網站來源唔會收到 CORS 許可', async () => {
  mockPsa([[/GetByCertNumber/, () => ok(CERT)]]);
  const r = await call(req('GET', '/api/cert/12345678', null, { Origin: 'https://evil.example' }));
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
});

test('同一個 IP 查太多次會被擋', async () => {
  mockPsa([[/GetByCertNumber/, () => ok(CERT)]]);
  let last;
  for (let i = 0; i < 31; i++) last = await call(req('GET', '/api/cert/12345678', null, { 'CF-Connecting-IP': '9.9.9.9' }));
  assert.equal(last.status, 429);
});
