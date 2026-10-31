// sermon-stats — read-only stats API for the WordPress plugin
// Bindings: D1 database → variable DB → download-stats
// Custom domain: stats.sermons.download
//
// Each church has one key in the stats_keys table. The key decides the
// church — the plugin never sends a slug, so a site can only ever see its own stats.

// Only these file types count as sermon downloads. Everything else stays in D1
// (useful for spotting junk) but is left out of the stats churches see.
// Add 'pdf' here if churches should see sermon notes downloads too.
const SERMON_EXTENSIONS = ['mp3', 'm4a', 'mp4', 'wav', 'aac', 'ogg', 'mov', 'm4v'];
const SERMON_FILTER =
  '(' + SERMON_EXTENSIONS.map((ext) => `lower(filename) LIKE '%.${ext}'`).join(' OR ') + ')';

// Rows that count: this church, sermon files, not bots.
const WHERE = `church = ? AND ${SERMON_FILTER} AND COALESCE(bot, 0) = 0`;

// One download = one visitor, one sermon, one day (UTC).
// Older rows have no visitor, so they count at most once per sermon per minute.
const KEY = `filename || '|' || COALESCE(visitor || '|' || substr(downloaded_at, 1, 10), substr(downloaded_at, 1, 16))`;

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const url = new URL(request.url);
    if (url.pathname !== '/v1/summary') return json({ error: 'Not found' }, 404);

    const auth = request.headers.get('Authorization') || '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim().toLowerCase() : '';
    if (!/^[a-f0-9]{64}$/.test(key)) return json({ error: 'Unauthorised' }, 401);

    try {
      const row = await env.DB.prepare(
        'SELECT church FROM stats_keys WHERE api_key = ? AND active = 1'
      ).bind(key).first();
      if (!row) return json({ error: 'Unauthorised' }, 401);

      const q = (sql) => env.DB.prepare(sql).bind(row.church);

      const [totals, monthly, top30, topAll, countries, recent] = await env.DB.batch([
        q(`SELECT COUNT(DISTINCT ${KEY}) AS all_time,
                  COUNT(DISTINCT CASE WHEN downloaded_at >= date('now', '-7 days') THEN ${KEY} END) AS last_7,
                  COUNT(DISTINCT CASE WHEN downloaded_at >= date('now', '-30 days') THEN ${KEY} END) AS last_30,
                  COUNT(DISTINCT CASE WHEN downloaded_at >= date('now', 'start of month') THEN ${KEY} END) AS this_month,
                  MIN(downloaded_at) AS first_recorded,
                  MAX(downloaded_at) AS latest
           FROM downloads WHERE ${WHERE}`),
        q(`SELECT strftime('%Y-%m', downloaded_at) AS month, COUNT(DISTINCT ${KEY}) AS downloads
           FROM downloads
           WHERE ${WHERE} AND downloaded_at >= date('now', 'start of month', '-11 months')
           GROUP BY month ORDER BY month`),
        q(`SELECT filename, COUNT(DISTINCT ${KEY}) AS downloads FROM downloads
           WHERE ${WHERE} AND downloaded_at >= date('now', '-30 days')
           GROUP BY filename ORDER BY downloads DESC, filename LIMIT 10`),
        q(`SELECT filename, COUNT(DISTINCT ${KEY}) AS downloads FROM downloads
           WHERE ${WHERE} GROUP BY filename ORDER BY downloads DESC, filename LIMIT 20`),
        q(`SELECT country, COUNT(DISTINCT ${KEY}) AS downloads FROM downloads
           WHERE ${WHERE} AND country IS NOT NULL
           GROUP BY country ORDER BY downloads DESC LIMIT 10`),
        q(`SELECT filename, country, MAX(downloaded_at) AS downloaded_at FROM downloads
           WHERE ${WHERE} GROUP BY ${KEY} ORDER BY 3 DESC LIMIT 10`),
      ]);

      return json({
        church: row.church,
        generated_at: new Date().toISOString(),
        totals: totals.results[0],
        monthly: monthly.results,
        top_30_days: top30.results,
        top_all_time: topAll.results,
        countries: countries.results,
        recent: recent.results,
      });
    } catch (err) {
      console.error('Stats query error:', err);
      return json({ error: 'Stats unavailable' }, 500);
    }
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}
