CREATE TABLE IF NOT EXISTS feeds (
  id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  do_name TEXT NOT NULL,
  name TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, id)
);
