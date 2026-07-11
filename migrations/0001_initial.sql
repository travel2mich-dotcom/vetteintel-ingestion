PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  profile_url TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  profile_id TEXT,
  vin TEXT,
  partial_vin TEXT,
  year INTEGER,
  variant TEXT,
  body_style TEXT,
  serial_number TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  discovered_at TEXT NOT NULL,
  processed_at TEXT,
  raw_html_key TEXT,
  FOREIGN KEY (source_id) REFERENCES sources(source_id)
);

CREATE INDEX IF NOT EXISTS idx_profiles_status_next
  ON profiles(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_profiles_vin
  ON profiles(vin);

CREATE TABLE IF NOT EXISTS sticker_assets (
  asset_id TEXT PRIMARY KEY,
  profile_url TEXT NOT NULL,
  vin TEXT,
  source_url TEXT NOT NULL,
  content_type TEXT,
  byte_length INTEGER,
  sha256 TEXT,
  r2_key TEXT,
  status TEXT NOT NULL DEFAULT 'discovered',
  quality_status TEXT NOT NULL DEFAULT 'unreviewed',
  discovered_at TEXT NOT NULL,
  downloaded_at TEXT,
  last_error TEXT,
  UNIQUE(source_url),
  UNIQUE(sha256),
  FOREIGN KEY (profile_url) REFERENCES profiles(profile_url)
);

CREATE INDEX IF NOT EXISTS idx_assets_vin ON sticker_assets(vin);
CREATE INDEX IF NOT EXISTS idx_assets_status ON sticker_assets(status);

CREATE TABLE IF NOT EXISTS crawl_runs (
  run_id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  profiles_attempted INTEGER NOT NULL DEFAULT 0,
  profiles_completed INTEGER NOT NULL DEFAULT 0,
  assets_downloaded INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO sources (
  source_id, source_name, base_url, enabled, created_at, updated_at
) VALUES (
  'cac-zr1-registry',
  'Corvette Action Center C7 ZR1 Registry',
  'https://www.corvetteactioncenter.com/specs/c7-corvette/corvette-zr1-registry/',
  1,
  datetime('now'),
  datetime('now')
);
