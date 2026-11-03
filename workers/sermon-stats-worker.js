// sermon-stats — read-only stats API for the WordPress plugin
// Bindings: D1 database → variable DB → download-stats
// Custom domain: stats.sermons.download
// Cron trigger: 17 3 * * *  (daily privacy clean-up, see cleanUp below)
//
// Each church has one key in the stats_keys table. The key decides the
// church — the plugin never sends a slug, so a site can only ever see its own stats.

// Only these file types count as sermon downloads. Everything else stays in D1
// (useful for spotting junk) but is left out of the stats churches see.
// Add 'pdf' here if churches should see sermon notes downloads too.
const SERMON_EXTENSIONS = ['mp3', 'm4a', 'mp4', 'wav', 'aac', 'ogg', 'mov', 'm4v'];
const SERMON_FILTER =
  '(' + SERMON_EXTENSIONS.map((ext) => `lower(filename) LIKE '%.${ext}'`).join(' OR ') + ')';

// One sermon = one file path. Older rows have no path, so they borrow the path that
// newer rows show for the same filename, when that filename only ever has one path.
// Truly ambiguous old rows (e.g. lots of different "6pm.mp3") stay grouped by filename.
// Every query reads from "d": this church's countable rows, each with an "item" (the sermon).
const BASE = `WITH pm AS (
    SELECT filename, MIN(path) AS path FROM downloads
    WHERE church = ? AND path IS NOT NULL
    GROUP BY filename HAVING COUNT(DISTINCT path) = 1
  ),
  d AS (
    SELECT downloads.filename, downloads.country, downloads.downloaded_at, downloads.visitor, downloads.kind,
           COALESCE(downloads.path, pm.path, downloads.filename) AS item
    FROM downloads LEFT JOIN pm ON pm.filename = downloads.filename
    WHERE downloads.church = ? AND ${SERMON_FILTER.replace(/filename/g, 'downloads.filename')}
      AND COALESCE(downloads.bot, 0) = 0
  )`;

// One download = one visitor, one sermon, one day (UTC).
// Rows without a visitor count at most once per sermon per minute.
const KEY = `item || '|' || COALESCE(visitor || '|' || substr(downloaded_at, 1, 10), substr(downloaded_at, 1, 16))`;

// Listening sessions from the on-site player, last 30 days. One listen = one visitor,
// one sermon, one day (UTC), keeping the longest time played. "secs" is seconds actually
// played (skipping ahead doesn't count); "dur" is the file's length when the player knew it.
const LISTENS = `WITH l AS (
    SELECT lower(path) AS item, MAX(path) AS path, MAX(listened) AS secs, MAX(duration) AS dur
    FROM listens WHERE church = ?1 AND started_at >= date('now', '-30 days')
    GROUP BY lower(path), COALESCE(visitor, session), substr(started_at, 1, 10)
  )`;

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

      const q = (sql) => env.DB.prepare(`${BASE} ${sql}`).bind(row.church, row.church);

      const [totals, monthly, top30, topAll, countries, recent, byKind] = await env.DB.batch([
        q(`SELECT COUNT(DISTINCT ${KEY}) AS all_time,
                  COUNT(DISTINCT CASE WHEN downloaded_at >= date('now', '-7 days') THEN ${KEY} END) AS last_7,
                  COUNT(DISTINCT CASE WHEN downloaded_at >= date('now', '-30 days') THEN ${KEY} END) AS last_30,
                  COUNT(DISTINCT CASE WHEN downloaded_at >= date('now', 'start of month') THEN ${KEY} END) AS this_month,
                  MIN(downloaded_at) AS first_recorded,
                  MAX(downloaded_at) AS latest
           FROM d`),
        q(`SELECT strftime('%Y-%m', downloaded_at) AS month, COUNT(DISTINCT ${KEY}) AS downloads
           FROM d WHERE downloaded_at >= date('now', 'start of month', '-11 months')
           GROUP BY month ORDER BY month`),
        q(`SELECT MAX(filename) AS filename, item AS path, COUNT(DISTINCT ${KEY}) AS downloads
           FROM d WHERE downloaded_at >= date('now', '-30 days')
           GROUP BY item ORDER BY downloads DESC, item LIMIT 10`),
        q(`SELECT MAX(filename) AS filename, item AS path, COUNT(DISTINCT ${KEY}) AS downloads
           FROM d GROUP BY item ORDER BY downloads DESC, item LIMIT 20`),
        q(`SELECT country, COUNT(DISTINCT ${KEY}) AS downloads
           FROM d WHERE country IS NOT NULL
           GROUP BY country ORDER BY downloads DESC LIMIT 10`),
        q(`SELECT filename, item AS path, country, MAX(downloaded_at) AS downloaded_at
           FROM d GROUP BY ${KEY} ORDER BY 4 DESC LIMIT 10`),
        // Plays (on-page player) vs downloads. Rows from before the split have no kind.
        q(`SELECT CASE WHEN kind IS NULL THEN 'before_split'
                       WHEN kind IN ('play', 'download') THEN kind
                       ELSE 'other' END AS kind,
                  COUNT(DISTINCT ${KEY}) AS all_time,
                  COUNT(DISTINCT CASE WHEN downloaded_at >= date('now', '-30 days') THEN ${KEY} END) AS last_30
           FROM d GROUP BY 1`),
      ]);

      // Listening time (plugin 1.5.0+). Separate so a problem here never hides the download stats.
      let listening = null;
      try {
        const [lsum, ltop] = await env.DB.batch([
          env.DB.prepare(`${LISTENS} SELECT COUNT(*) AS plays,
                COALESCE(SUM(secs >= 60), 0) AS one_minute,
                COALESCE(SUM(dur > 0 AND secs >= dur * 0.5), 0) AS halfway,
                COALESCE(SUM(dur > 0 AND secs >= dur * 0.9), 0) AS to_the_end,
                COALESCE(SUM(secs), 0) AS seconds,
                (SELECT MIN(started_at) FROM listens WHERE church = ?1) AS since
             FROM l`).bind(row.church),
          env.DB.prepare(`${LISTENS} SELECT MAX(path) AS path, COUNT(*) AS plays,
                SUM(secs >= 60) AS one_minute,
                SUM(dur > 0 AND secs >= dur * 0.5) AS halfway,
                CAST(AVG(secs) AS INTEGER) AS avg_seconds
             FROM l GROUP BY item ORDER BY plays DESC, item LIMIT 10`).bind(row.church),
        ]);
        listening = { last_30: lsum.results[0], top_30_days: ltop.results };
      } catch (err) {
        console.error('Listening query error:', err);
      }

      return json({
        church: row.church,
        generated_at: new Date().toISOString(),
        totals: totals.results[0],
        monthly: monthly.results,
        top_30_days: top30.results,
        top_all_time: topAll.results,
        countries: countries.results,
        recent: recent.results,
        by_kind: byKind.results,
        listening,
      });
    } catch (err) {
      console.error('Stats query error:', err);
      return json({ error: 'Stats unavailable' }, 500);
    }
  },

  // Runs daily from the Cron Trigger.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanUp(env));
  },
};

// Privacy clean-up (the retention promised in churches' privacy policies):
//  - user_agent is deleted after 90 days (only needed for spotting bots).
//  - visitor IDs older than 7 days are swapped for random codes starting "~". Each old ID
//    gets one random code, so "same person, same day" still counts once and the stats
//    don't change, but the code can no longer be traced back to an IP address, even
//    with VISITOR_SALT. The lookup table is emptied straight away.
// Note: D1 Time Travel can restore the database to any point in the last 30 days, so
// old values are only gone for good once they're past that window too.
const VISITOR_DAYS = 7;
const USER_AGENT_DAYS = 90;

async function cleanUp(env) {
  const oldVisitor = `visitor IS NOT NULL AND visitor NOT LIKE '~%'
    AND downloaded_at < date('now', '-${VISITOR_DAYS} days')`;
  // Same for listening sessions, which use started_at instead of downloaded_at.
  const oldListener = `visitor IS NOT NULL AND visitor NOT LIKE '~%'
    AND started_at < date('now', '-${VISITOR_DAYS} days')`;
  try {
    const results = await env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS visitor_map (visitor TEXT PRIMARY KEY, anon TEXT NOT NULL)'),
      env.DB.prepare('DELETE FROM visitor_map'),
      // One random code per old ID across both tables, so a person's download and
      // listen on the same day still match up after anonymising.
      env.DB.prepare(`INSERT INTO visitor_map (visitor, anon)
        SELECT visitor, '~' || lower(hex(randomblob(8)))
        FROM (SELECT visitor FROM downloads WHERE ${oldVisitor}
              UNION SELECT visitor FROM listens WHERE ${oldListener})`),
      env.DB.prepare(`UPDATE downloads
        SET visitor = (SELECT anon FROM visitor_map m WHERE m.visitor = downloads.visitor)
        WHERE ${oldVisitor}`),
      env.DB.prepare(`UPDATE listens
        SET visitor = (SELECT anon FROM visitor_map m WHERE m.visitor = listens.visitor)
        WHERE ${oldListener}`),
      env.DB.prepare('DELETE FROM visitor_map'),
      env.DB.prepare(`UPDATE downloads SET user_agent = NULL
        WHERE user_agent IS NOT NULL AND downloaded_at < date('now', '-${USER_AGENT_DAYS} days')`),
    ]);
    console.log(
      `Clean-up done: ${results[3].meta.changes} download and ${results[4].meta.changes} listen visitor IDs anonymised, ` +
        `${results[6].meta.changes} user agents removed`
    );
  } catch (err) {
    console.error('Clean-up error:', err);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}
