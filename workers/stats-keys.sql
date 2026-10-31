-- Run in: Cloudflare → D1 → download-stats → Console

-- One-off: create the keys table
CREATE TABLE stats_keys (
  church     TEXT PRIMARY KEY,
  api_key    TEXT NOT NULL UNIQUE,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add a church (slug must match the Worker's CHURCH variable), then copy the key
INSERT INTO stats_keys (church, api_key) VALUES ('stag', lower(hex(randomblob(32))));
SELECT api_key FROM stats_keys WHERE church = 'stag';

-- Replace a leaked key (old one stops working immediately; paste the new one into WP)
UPDATE stats_keys SET api_key = lower(hex(randomblob(32))) WHERE church = 'stag';

-- Switch a church off / back on
UPDATE stats_keys SET active = 0 WHERE church = 'stag';
UPDATE stats_keys SET active = 1 WHERE church = 'stag';

-- Which churches have keys
SELECT church, active, created_at FROM stats_keys ORDER BY church;
