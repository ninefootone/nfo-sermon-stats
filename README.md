# Sermon Download Stats

WordPress plugin that shows a church its sermon download stats from `sermons.download` in the dashboard. Stats come from the `sermon-stats` Cloudflare Worker, which reads the shared `download-stats` D1 database. WordPress never talks to D1 directly.

## Requirements

- WordPress 6.0+, PHP 7.4+
- A stats key for the church (one row in the `stats_keys` table)

## Installation

1. Download `nfo-sermon-stats.zip` from the latest [release](../../releases) (not GitHub's "Source code" zip — that includes the Worker code and a wrongly named folder).
2. WordPress → Plugins → Add New → Upload Plugin → activate.
3. Add the key to `wp-config.php`, above `/* That's all, stop editing! */`:
   ```php
   define( 'NFO_SERMON_STATS_KEY', 'the-64-character-key' );
   ```
   Or paste it in Settings → Sermon Stats (visible to site admins).
4. Settings → Sermon Stats should say "Connected".

Updates then appear in WordPress like any other plugin.

## Releasing an update

1. Make the change.
2. Bump the version in **both** places in `nfo-sermon-stats.php`: the `Version:` header and `const VERSION`.
3. Add an entry to `CHANGELOG.md`.
4. Commit, then tag and push:
   ```sh
   git commit -am "v1.2.1: what changed"
   git tag v1.2.1
   git push && git push --tags
   ```
5. The Release action builds `nfo-sermon-stats.zip` and attaches it to a GitHub release. Sites pick it up within about 12 hours (or Dashboard → Updates → Check again).

## Cloudflare Workers

`workers/` holds the Cloudflare code. It is **not** included in the plugin zip and is not deployed automatically — paste it into the dashboard.

| File | Where it goes |
|---|---|
| `download-worker.js` | Every `[slug]-downloads` Worker (needs `BUCKET`, `DB`, `CHURCH`, `VISITOR_SALT`) |
| `sermon-stats-worker.js` | The `sermon-stats` Worker on `stats.sermons.download` (needs `DB`) |
| `stats-keys.sql` | Creating, rotating and disabling church stats keys |
| `migration-2026-10-visitor.sql` | Adds `visitor`, `bot`, `user_agent` to `downloads` (already run) |
| `migration-2026-10-path.sql` | Adds `path` to `downloads` — run before deploying the Workers that use it |

The D1 console needs **one statement at a time, with no comment lines**.

## How downloads are counted

One visitor, one sermon (= one file path), one day (UTC). Bots (by user agent) and non-sermon file types are excluded. Rows from before the visitor ID was added count at most once per sermon per minute.
