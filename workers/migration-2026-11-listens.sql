-- Listening time from the on-site player (plugin 1.5.0+).
-- One row per play session: how many seconds were actually played (skips don't count).
-- Run in the download-stats D1 console BEFORE deploying the new Workers,
-- one statement at a time, without these comment lines.

CREATE TABLE listens (church TEXT NOT NULL, session TEXT NOT NULL, path TEXT NOT NULL, visitor TEXT, country TEXT, listened INTEGER NOT NULL DEFAULT 0, duration INTEGER, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (church, session, path));

CREATE INDEX listens_church_started ON listens (church, started_at);

-- Check: should list "listens"
SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'listens';
