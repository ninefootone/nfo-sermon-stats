// sermon-downloads — ONE Worker for every church's sermon downloads (replaces [slug]-downloads)
//
// Domains:   one Custom Domain (or, while migrating, one Route) per church: [slug].sermons.download
// Bindings:  DB    → download-stats (D1)
//            R2_<SLUG> → [slug]-sermons (R2), one per church. Slug in capitals, hyphens as
//            underscores: stag → R2_STAG, st-marys → R2_ST_MARYS
// Variables: VISITOR_SALT (Secret) — same value as before
//            HOSTS (Text, optional) — JSON for hostnames that aren't [slug].sermons.download, e.g.
//            {"downloads.apassionforlife.org.uk": "ap4l", "test.sermons.download": "stag"}
//
// The slug is also the church name recorded in stats, so it must match what the old
// Worker's CHURCH variable was, or that church's stats will split in two.

const BASE_DOMAIN = '.sermons.download';

// User agents that are never a person listening to a sermon.
const BOT_PATTERN =
  /bot|crawl|spider|slurp|scrapy|facebookexternalhit|curl|wget|python|go-http-client|okhttp|java\/|libwww|httpclient|headless|ahrefs|semrush|bytespider|yandex|baidu/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === LISTEN_PATH) return handleListen(request, env, url);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const church = churchFor(env, url.hostname);
    if (!church) return new Response('Not found', { status: 404 });

    // Remove leading slash, treat + as space, then decode (%2B becomes a real +)
    const key = decodeURIComponent(url.pathname.slice(1).replace(/\+/g, ' '));
    if (!key) return new Response('Not found', { status: 404 });

    const isHead = request.method === 'HEAD';
    const object = isHead ? await church.bucket.head(key) : await church.bucket.get(key);
    if (!object) return new Response('File not found', { status: 404 });

    const filename = key.split('/').pop();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Length', String(object.size));
    headers.set('ETag', object.httpEtag);
    headers.set(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );

    // Log real downloads only: not HEAD checks, and not follow-up chunk requests
    // (a Range request that doesn't start at byte 0 is the same download continuing).
    const range = (request.headers.get('Range') || '').trim();
    const isFirstChunk = range === '' || /^bytes=0-/i.test(range);
    if (!isHead && isFirstChunk) ctx.waitUntil(logDownload(env, request, church.slug, key, filename));

    return new Response(isHead ? null : object.body, { headers });
  },
};

// ---------- Listening time (plugin 1.5.0+) ----------
// The plugin's player script sends {s: session, p: path, l: seconds played, d: duration}
// to https://[slug].sermons.download/_listen when playback starts, every minute while
// playing, and on pause / end / leaving the page. One row per session in the listens table.
// Seconds can only go up, and never faster than real time allows (2.5x speed + 90s slack),
// so a faked request can't claim a whole sermon was heard in seconds.
const LISTEN_PATH = '/_listen';
const LISTEN_EXT = /\.(mp3|m4a|mp4|wav|aac|ogg|mov|m4v)$/i;
const MAX_SECONDS = 6 * 3600;

async function handleListen(request, env, url) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers });

  const church = churchFor(env, url.hostname);
  if (!church) return new Response('Not found', { status: 404, headers });

  let body;
  try {
    const text = await request.text();
    if (text.length > 1000) throw new Error('too long');
    body = JSON.parse(text);
  } catch {
    return new Response('Bad request', { status: 400, headers });
  }

  const session = String(body?.s || '');
  const path = String(body?.p || '').replace(/^\/+/, '');
  if (!/^[a-f0-9]{16,32}$/.test(session) || path.length > 300 || !LISTEN_EXT.test(path) || /[\x00-\x1f]/.test(path)) {
    return new Response('Bad request', { status: 400, headers });
  }
  const listened = clampSeconds(body.l);
  const duration = clampSeconds(body.d) || null;

  const userAgent = request.headers.get('User-Agent') || '';
  if (userAgent === '' || BOT_PATTERN.test(userAgent)) return new Response(null, { status: 204, headers });

  try {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO listens (church, session, path, visitor, country, listened, duration, started_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, MIN(?6, 90), ?7, ?8, ?8)
       ON CONFLICT (church, session, path) DO UPDATE SET
         listened = MAX(listened, MIN(?6, CAST((julianday(?8) - julianday(started_at)) * 86400 * 2.5 AS INTEGER) + 90)),
         duration = COALESCE(?7, duration),
         updated_at = ?8`
    ).bind(
      church.slug,
      session,
      path,
      await visitorId(env, request, now.slice(0, 10)),
      request.cf?.country || null,
      listened,
      duration,
      now
    ).run();
  } catch (err) {
    console.error('Listen logging error:', err);
  }
  return new Response(null, { status: 204, headers });
}

function clampSeconds(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_SECONDS) : 0;
}

// Which church a hostname belongs to, and its bucket. null = unknown host or no bucket binding.
function churchFor(env, hostname) {
  const host = hostname.toLowerCase();
  let hosts = {};
  if (env.HOSTS) {
    try {
      hosts = JSON.parse(env.HOSTS);
    } catch {
      console.error('HOSTS variable is not valid JSON');
    }
  }
  let slug = hosts[host];
  if (!slug && host.endsWith(BASE_DOMAIN)) slug = host.slice(0, -BASE_DOMAIN.length);
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null;

  const binding = 'R2_' + slug.toUpperCase().replace(/-/g, '_');
  const bucket = env[binding];
  if (!bucket) {
    console.error(`No R2 binding ${binding} for ${host}`);
    return null;
  }
  return { slug, bucket };
}

async function logDownload(env, request, church, path, filename) {
  try {
    const userAgent = request.headers.get('User-Agent') || '';
    const isBot = userAgent === '' || BOT_PATTERN.test(userAgent) ? 1 : 0;
    const now = new Date().toISOString();

    // What fetched the file: the on-page player (audio/video) or a download link (document).
    // Anything else is saved as-is, or 'unknown' if the browser didn't say.
    const dest = (request.headers.get('Sec-Fetch-Dest') || '').toLowerCase();
    const kind =
      dest === 'audio' || dest === 'video' ? 'play'
      : dest === 'document' ? 'download'
      : (dest || 'unknown').slice(0, 20);

    await env.DB.prepare(
      'INSERT INTO downloads (church, filename, path, country, downloaded_at, visitor, bot, user_agent, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      church,
      filename,
      path, // full key incl. folders, so 2026/10/6pm.mp3 and 2026/11/6pm.mp3 stay separate
      request.cf?.country || null,
      now,
      await visitorId(env, request, now.slice(0, 10)),
      isBot,
      userAgent.slice(0, 200) || null,
      kind
    ).run();
  } catch (err) {
    console.error('D1 logging error:', err);
  }
}

// Scrambled, one-way ID for "this IP address, today". The real IP is never stored,
// and the same person gets a different ID tomorrow. NULL if VISITOR_SALT is missing.
async function visitorId(env, request, day) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!env.VISITOR_SALT || !ip) return null;
  const data = new TextEncoder().encode(`${env.VISITOR_SALT}|${day}|${ip}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
