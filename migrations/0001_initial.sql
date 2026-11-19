CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lock_token TEXT,
  lock_until INTEGER
);

CREATE TABLE IF NOT EXISTS app_projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  position INTEGER NOT NULL,
  document TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_posts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  document TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_highlights (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  document TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_stories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
  highlight_id TEXT NOT NULL REFERENCES app_highlights(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  document TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS app_posts_project_order ON app_posts(project_id, position);
CREATE INDEX IF NOT EXISTS app_highlights_project_order ON app_highlights(project_id, position);
CREATE INDEX IF NOT EXISTS app_stories_highlight_order ON app_stories(highlight_id, position);

INSERT OR IGNORE INTO app_state (id, lock_token, lock_until) VALUES (1, NULL, NULL);

