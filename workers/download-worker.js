// [slug]-downloads — forced downloads + stats logging (identical for every church)
// Bindings:  BUCKET → [slug]-sermons (R2),  DB → download-stats (D1)
// Variables: CHURCH → [slug] (Text),  VISITOR_SALT → random value (Secret)

// User agents that are never a person listening to a sermon.
const BOT_PATTERN =
  /bot|crawl|spider|slurp|scrapy|facebookexternalhit|curl|wget|python|go-http-client|okhttp|java\/|libwww|httpclient|headless|ahrefs|semrush|bytespider|yandex|baidu/i;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const url = new URL(request.url);
    // Remove leading slash, treat + as space, then decode (%2B becomes a real +)
    const key = decodeURIComponent(url.pathname.slice(1).replace(/\+/g, ' '));
    if (!key) return new Response('Not found', { status: 404 });

    const isHead = request.method === 'HEAD';
    const object = isHead ? await env.BUCKET.head(key) : await env.BUCKET.get(key);
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
    if (!isHead && isFirstChunk) ctx.waitUntil(logDownload(env, url, request, filename));

    return new Response(isHead ? null : object.body, { headers });
  },
};

async function logDownload(env, url, request, filename) {
  try {
    const userAgent = request.headers.get('User-Agent') || '';
    const isBot = userAgent === '' || BOT_PATTERN.test(userAgent) ? 1 : 0;
    const now = new Date().toISOString();

    await env.DB.prepare(
      'INSERT INTO downloads (church, filename, country, downloaded_at, visitor, bot, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      env.CHURCH || url.hostname, // a hostname in stats = CHURCH variable missing
      filename,
      request.cf?.country || null,
      now,
      await visitorId(env, request, now.slice(0, 10)),
      isBot,
      userAgent.slice(0, 200) || null
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
