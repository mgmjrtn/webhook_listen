'use strict';
/**
 * Webhook Catcher — a tiny, zero-dependency webhook.site replacement.
 *
 *   ANY  /hook/:sessionId[/anything]   -> captured into that session
 *   GET  /                              -> web UI (optionally password-protected)
 *   /api/...                            -> JSON API used by the UI
 *
 * Storage is in memory. A restart or redeploy (or a free-tier spin-down)
 * wipes captured requests. Download what you need.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MAX_BODY = Number(process.env.MAX_BODY_BYTES) || 10 * 1024 * 1024; // 10 MB
const MAX_PER_SESSION = Number(process.env.MAX_REQUESTS_PER_SESSION) || 1000;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 50;
const RESPONSE_STATUS = Number(process.env.RESPONSE_STATUS) || 200;

// Look for the UI in public/ first, then next to server.js (handles flattened uploads).
const INDEX_PATH = [
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'index.html'),
].find((p) => fs.existsSync(p));
if (!INDEX_PATH) {
  console.error('index.html not found. Expected public/index.html (or index.html) next to server.js. Files here: ' +
    fs.readdirSync(__dirname).join(', '));
  process.exit(1);
}
const INDEX_HTML = fs.readFileSync(INDEX_PATH);
const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** @type {Map<string, any>} insertion order == creation order */
const sessions = new Map();

const newId = (bytes = 5) => crypto.randomBytes(bytes).toString('hex');

function createSession(id, name) {
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  const s = {
    id: id || newId(),
    name: (name || '').trim().slice(0, 80) || null,
    createdAt: new Date().toISOString(),
    version: 1,      // bumps when cleared, so the UI knows to reload
    seq: 0,          // monotonically increasing request counter
    requests: [],
  };
  sessions.set(s.id, s);
  return s;
}

function sessionSummary(s) {
  const last = s.requests[s.requests.length - 1];
  return {
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    count: s.requests.length,
    lastAt: last ? last.receivedAt : null,
  };
}

function requestSummary(r) {
  return {
    id: r.id, seq: r.seq, receivedAt: r.receivedAt, method: r.method,
    path: r.path, contentType: r.contentType, size: r.size, ip: r.ip,
  };
}

// ---------- helpers ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let truncated = false;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
      else truncated = true;
    });
    req.on('end', () => resolve({ buf: Buffer.concat(chunks), size, truncated }));
    req.on('error', reject);
  });
}

function paramsToObject(params) {
  const out = {};
  for (const [k, v] of params) {
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  return out;
}

function decodeBody(buf, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (!buf.length) return { bodyEncoding: 'none', body: '' };
  const text = buf.toString('utf8');
  const isText = Buffer.from(text, 'utf8').equals(buf);
  if (!isText) return { bodyEncoding: 'base64', body: buf.toString('base64') };

  const out = { bodyEncoding: 'utf8', body: text };
  const t = text.trim();
  if (ct.includes('json') || t.startsWith('{') || t.startsWith('[')) {
    try { out.json = JSON.parse(t); } catch { /* not JSON, keep raw */ }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    try { out.form = paramsToObject(new URLSearchParams(text)); } catch { /* ignore */ }
  }
  return out;
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const isStr = typeof body === 'string';
  const payload = isBuf || isStr ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isBuf || isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function authorized(req) {
  if (!ADMIN_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  const a = Buffer.from(pass);
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- export formats ----------

function fence(s, lang = '') {
  const ticks = s.includes('```') ? '~~~~' : '```';
  return `${ticks}${lang}\n${s}\n${ticks}`;
}

function requestToMarkdown(r) {
  const lines = [];
  lines.push(`### #${r.seq} ${r.method} ${r.path}`);
  lines.push('');
  lines.push(`- Received: ${r.receivedAt}`);
  lines.push(`- From IP: ${r.ip || '(unknown)'}`);
  lines.push(`- Content-Type: ${r.contentType || '(none)'}`);
  lines.push(`- Body size: ${r.size} bytes${r.truncated ? ` (truncated to ${MAX_BODY} bytes)` : ''}`);
  if (Object.keys(r.query).length) {
    lines.push('', '**Query parameters**', '', fence(JSON.stringify(r.query, null, 2), 'json'));
  }
  lines.push('', '**Headers**', '', fence(JSON.stringify(r.headers, null, 2), 'json'));
  lines.push('', '**Body**', '');
  if (r.bodyEncoding === 'none') lines.push('_(empty)_');
  else if (r.json !== undefined) lines.push(fence(JSON.stringify(r.json, null, 2), 'json'));
  else if (r.form) {
    lines.push('Form fields:', '', fence(JSON.stringify(r.form, null, 2), 'json'), '', 'Raw:', '', fence(r.body));
  } else if (r.bodyEncoding === 'base64') lines.push('_(binary body, base64-encoded)_', '', fence(r.body));
  else lines.push(fence(r.body));
  return lines.join('\n');
}

function sessionToMarkdown(s) {
  const head = [
    `# Webhook session: ${s.name || s.id}`,
    '',
    `- Session ID: ${s.id}`,
    `- Created: ${s.createdAt}`,
    `- Exported: ${new Date().toISOString()}`,
    `- Requests: ${s.requests.length}`,
    '',
  ].join('\n');
  if (!s.requests.length) return head + '\n_(no requests captured)_\n';
  return head + '\n' + s.requests.map(requestToMarkdown).join('\n\n---\n\n') + '\n';
}

function stripInternal(r) {
  const { ...copy } = r;
  return copy;
}

function sendExport(res, format, basename, mdFn, jsonValue, inline) {
  const isJson = format === 'json';
  const body = isJson ? JSON.stringify(jsonValue, null, 2) : mdFn();
  const headers = {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
  };
  if (!inline) headers['content-disposition'] = `attachment; filename="${basename}.${isJson ? 'json' : 'md'}"`;
  send(res, 200, body, headers);
}

// ---------- capture ----------

async function capture(req, res, sid, url) {
  const { buf, size, truncated } = await readBody(req);
  let s = sessions.get(sid);
  // Unknown ID (e.g. after a restart): create it so old URLs keep working.
  if (!s) s = createSession(sid, null);

  const contentType = req.headers['content-type'] || '';
  const record = {
    id: newId(4),
    seq: ++s.seq,
    receivedAt: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    url: req.url,
    query: paramsToObject(url.searchParams),
    headers: req.headers,
    ip: clientIp(req),
    contentType,
    size,
    truncated,
    ...decodeBody(buf, contentType),
  };
  s.requests.push(record);
  if (s.requests.length > MAX_PER_SESSION) s.requests.splice(0, s.requests.length - MAX_PER_SESSION);

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': '*',
    'access-control-allow-headers': '*',
  };
  if (req.method === 'OPTIONS') return send(res, 204, '', cors);
  if (req.method === 'HEAD') { res.writeHead(RESPONSE_STATUS, cors); return res.end(); }
  send(res, RESPONSE_STATUS, { ok: true, session: s.id, request: record.id }, cors);
}

// ---------- router ----------

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  // Public webhook endpoint: /hook/:sid[/...]
  if (parts[0] === 'hook') {
    const sid = parts[1];
    if (!sid || !SID_RE.test(sid)) return send(res, 404, { error: 'Use /hook/<sessionId>' });
    return capture(req, res, sid, url);
  }

  if (url.pathname === '/healthz') return send(res, 200, 'ok');

  // Everything else is the UI/API and may be password-protected.
  if (!authorized(req)) {
    return send(res, 401, 'Authentication required', { 'www-authenticate': 'Basic realm="Webhook Catcher"' });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, INDEX_HTML, { 'content-type': 'text/html; charset=utf-8' });
  }

  if (parts[0] !== 'api' || parts[1] !== 'sessions') return send(res, 404, { error: 'Not found' });

  // /api/sessions
  if (parts.length === 2) {
    if (req.method === 'GET') {
      return send(res, 200, [...sessions.values()].reverse().map(sessionSummary));
    }
    if (req.method === 'POST') {
      const { buf } = await readBody(req);
      let name = null;
      try { name = JSON.parse(buf.toString('utf8') || '{}').name || null; } catch { /* ignore */ }
      return send(res, 201, sessionSummary(createSession(null, name)));
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  const sid = parts[2];
  const s = sessions.get(sid);
  if (!s) return send(res, 404, { error: 'Session not found' });
  const fmt = url.searchParams.get('format') === 'json' ? 'json' : 'md';
  const inline = url.searchParams.get('inline') === '1';

  // /api/sessions/:sid
  if (parts.length === 3) {
    if (req.method === 'DELETE') { sessions.delete(sid); return send(res, 200, { ok: true }); }
    if (req.method === 'PATCH') {
      const { buf } = await readBody(req);
      try { s.name = String(JSON.parse(buf.toString('utf8')).name || '').trim().slice(0, 80) || null; } catch { /* ignore */ }
      return send(res, 200, sessionSummary(s));
    }
    if (req.method === 'GET') return send(res, 200, sessionSummary(s));
    return send(res, 405, { error: 'Method not allowed' });
  }

  // /api/sessions/:sid/clear
  if (parts[3] === 'clear' && req.method === 'POST') {
    s.requests = [];
    s.version += 1;
    return send(res, 200, { ok: true });
  }

  // /api/sessions/:sid/export
  if (parts[3] === 'export' && req.method === 'GET') {
    const json = { session: sessionSummary(s), exportedAt: new Date().toISOString(), requests: s.requests.map(stripInternal) };
    return sendExport(res, fmt, `webhooks-${s.id}`, () => sessionToMarkdown(s), json, inline);
  }

  // /api/sessions/:sid/requests[...]
  if (parts[3] === 'requests' && req.method === 'GET') {
    if (parts.length === 4) {
      const after = Number(url.searchParams.get('after')) || 0;
      const list = s.requests.filter((r) => r.seq > after).map(requestSummary);
      return send(res, 200, { version: s.version, requests: list });
    }
    const r = s.requests.find((x) => x.id === parts[4]);
    if (!r) return send(res, 404, { error: 'Request not found' });
    if (parts[5] === 'export') {
      return sendExport(res, fmt, `webhook-${s.id}-${r.seq}`, () => requestToMarkdown(r), r, inline);
    }
    return send(res, 200, r);
  }

  if (parts[3] === 'requests' && parts[4] && req.method === 'DELETE') {
    s.requests = s.requests.filter((x) => x.id !== parts[4]);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
      else res.end();
    });
  })
  .listen(PORT, () => {
    console.log(`Webhook Catcher listening on :${PORT}${ADMIN_PASSWORD ? ' (UI password-protected)' : ''}`);
  });
