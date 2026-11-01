const http = require('http');

const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOG_FILE = path.join(DATA_DIR, 'requests.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
// Settings saved from the UI override the environment defaults
let config = {
  hardcoverToken: process.env.HARDCOVER_TOKEN || '',
  authKey: process.env.AUTH_KEY || '',
  maxResults: parseInt(process.env.MAX_RESULTS || '10', 10),
  ...readJson(CONFIG_FILE, {}),
};
const cleanToken = (t) => String(t || '').trim().replace(/^Bearer\s+/i, '');

const MAX_LOGS = 1000;
let logs = readJson(LOG_FILE, []);
let saveTimer;
function addLog(entry) {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(LOG_FILE, JSON.stringify(logs), () => {}), 500);
}
const API = 'https://api.hardcover.app/v1/graphql';

const QUERY = `query Search($q: String!, $n: Int!) {
  search(query: $q, query_type: "Book", per_page: $n, page: 1) { results }
}`;

async function hardcoverSearch(q) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cleanToken(config.hardcoverToken)}` },
    body: JSON.stringify({ query: QUERY, variables: { q, n: Number(config.maxResults) || 10 } }),
  });
  if (!res.ok) throw new Error(`Hardcover HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  const results = json.data?.search?.results;
  const parsed = typeof results === 'string' ? JSON.parse(results) : results;
  return (parsed?.hits || []).map((h) => h.document).filter(Boolean);
}

function toMetadata(d) {
  const authors = d.author_names || [];
  const series = [];
  const names = d.series_names || [];
  names.forEach((s, i) => {
    const pos = i === 0 ? d.featured_series_position : undefined;
    series.push(pos != null ? { series: s, sequence: String(pos) } : { series: s });
  });
  const m = {
    title: d.title,
    subtitle: d.subtitle || undefined,
    author: authors.join(', ') || undefined,
    description: d.description || undefined,
    cover: d.image?.url || undefined,
    publishedYear: d.release_year ? String(d.release_year) : undefined,
    isbn: (d.isbns || [])[0] || undefined,
    genres: d.genres?.length ? d.genres : undefined,
    tags: d.moods?.length ? d.moods : undefined,
    series: series.length ? series : undefined,
    duration: d.audio_seconds ? Math.round(d.audio_seconds / 60) : undefined,
  };
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined));
}

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});

const crypto = require('crypto');
if (!config.sessionSecret) {
  config.sessionSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}
const sign = (v) => crypto.createHmac('sha256', config.sessionSecret).update(v).digest('hex');
const SESSION_MS = 7 * 24 * 3600 * 1000;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  const a = Buffer.from(hash || '', 'hex');
  const b = crypto.scryptSync(String(pw), salt || '', 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isLoggedIn(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return !!sig && Number(exp) > Date.now() && sig === sign(exp);
}
const sessionCookie = () => {
  const exp = String(Date.now() + SESSION_MS);
  return `sid=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stats() {
  const now = Date.now();
  const first = Math.floor(now / 3600000) * 3600000 - 23 * 3600000;
  const hours = Array.from({ length: 24 }, (_, i) => ({ start: first + i * 3600000, ok: 0, failed: 0 }));
  for (const l of logs) {
    const idx = Math.floor((l.time - first) / 3600000);
    if (idx >= 0 && idx < 24) hours[idx][l.ok ? 'ok' : 'failed']++;
  }
  const ok = logs.filter((l) => l.ok).length;
  const avg = logs.length ? Math.round(logs.reduce((a, l) => a + l.ms, 0) / logs.length) : 0;
  return { total: logs.length, ok, failed: logs.length - ok, avgMs: avg, hours, recent: logs.slice(-100).reverse() };
}

async function runSearch(query, author) {
  const docs = await hardcoverSearch(author ? `${query} ${author}` : query);
  return docs.map(toMetadata).filter((m) => m.title);
}

async function handleAdmin(req, res, url) {
  const p = url.pathname.replace(/\/$/, '');
  if (p === '/admin') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
  if (p === '/admin/api/status') return send(res, 200, { setup: !!config.adminHash, loggedIn: isLoggedIn(req) });
  if (p === '/admin/api/setup' && req.method === 'POST') {
    if (config.adminHash) return send(res, 409, { error: 'Already set up' });
    const b = await readBody(req);
    if (typeof b.password !== 'string' || b.password.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters' });
    config.adminHash = hashPassword(b.password);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    res.setHeader('set-cookie', sessionCookie());
    return send(res, 200, { ok: true });
  }
  if (p === '/admin/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    await sleep(500);
    if (!config.adminHash || !checkPassword(b.password, config.adminHash)) return send(res, 401, { error: 'Wrong password' });
    res.setHeader('set-cookie', sessionCookie());
    return send(res, 200, { ok: true });
  }
  if (p === '/admin/api/logout') {
    res.setHeader('set-cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }
  if (!isLoggedIn(req)) return send(res, 401, { error: 'Not logged in' });
  if (p === '/admin/api/stats') return send(res, 200, stats());
  if (p === '/admin/api/config' && req.method === 'GET') {
    return send(res, 200, { hasToken: !!config.hardcoverToken, authKey: config.authKey, maxResults: config.maxResults });
  }
  if (p === '/admin/api/config' && req.method === 'PUT') {
    const b = await readBody(req);
    if (typeof b.hardcoverToken === 'string' && b.hardcoverToken.trim()) config.hardcoverToken = cleanToken(b.hardcoverToken);
    if (typeof b.authKey === 'string') config.authKey = b.authKey;
    if (b.maxResults) config.maxResults = Math.min(50, Math.max(1, parseInt(b.maxResults, 10) || 10));
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    return send(res, 200, { ok: true });
  }
  if (p === '/admin/api/test') {
    const query = url.searchParams.get('query');
    if (!query) return send(res, 400, { error: 'query is required' });
    try { return send(res, 200, { matches: await runSearch(query) }); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (p === '/admin/api/logs' && req.method === 'DELETE') {
    logs = [];
    fs.writeFile(LOG_FILE, '[]', () => {});
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'Not found' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return send(res, 200, { ok: true });
  if (url.pathname === '/') { res.writeHead(302, { location: '/admin' }); return res.end(); }
  if (url.pathname.startsWith('/admin')) return handleAdmin(req, res, url).catch((e) => send(res, 500, { error: e.message }));
  if (url.pathname !== '/search') return send(res, 404, { error: 'Not found' });

  const started = Date.now();
  const query = url.searchParams.get('query');
  const author = url.searchParams.get('author');
  const finish = (code, body, extra = {}) => {
    addLog({ time: started, ms: Date.now() - started, query, author, status: code, ok: code === 200, ...extra });
    send(res, code, body);
  };
  const fail = (code, error) => finish(code, { error }, { error });
  if (config.authKey && req.headers['authorization'] !== config.authKey) return fail(401, 'Unauthorized');
  if (!query) return fail(400, 'query is required');
  if (!config.hardcoverToken) return fail(500, 'Hardcover token not configured');
  try {
    const matches = await runSearch(query, author);
    finish(200, { matches }, { results: matches.length });
  } catch (e) {
    console.error(e);
    fail(500, e.message);
  }
}).listen(PORT, () => console.log(`Listening on ${PORT}`));
