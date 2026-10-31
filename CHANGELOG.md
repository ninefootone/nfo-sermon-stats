# Changelog

All notable changes to Sermon Download Stats are documented here.

## 1.2.1

### Changed
- Author name shown as "ninefootone creative" (lower case), in the plugin list and on the settings page.

## 1.2.0

### Added
- Automatic updates from GitHub releases via Plugin Update Checker 5.5 (same setup as Church Events).

## 1.1.0

### Changed
- Stats explanation updated: each person counts once per sermon per day, and known bots are excluded (counting is done by the `sermon-stats` Worker).

## 1.0.0

### Added
- Dashboard widget with 7-day, 30-day, this-month and all-time totals, plus the top five sermons for the last 30 days.
- Dashboard → Sermon Stats page with monthly chart, top sermons, countries and latest downloads.
- Settings → Sermon Stats for the church's stats key, or `NFO_SERMON_STATS_KEY` in wp-config.php.
- One-hour cache with a Refresh link; errors cached for five minutes.
