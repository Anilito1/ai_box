-- The ideas forum. No personal data beyond the pseudo: a token is kept as its hash, an IP address only as a hash
-- salted with the day (it counts sign-ups and messages per address and per day, nothing else).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  pseudo TEXT NOT NULL,
  pseudo_key TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT NOT NULL,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX users_ip ON users (ip_hash);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL,
  area TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  reply TEXT,
  reply_at INTEGER,
  -- 1: hidden, by enough reports or by a moderator. reviewed: a moderator decided, reports no longer hide it.
  hidden INTEGER NOT NULL DEFAULT 0,
  reviewed INTEGER NOT NULL DEFAULT 0,
  -- Removed by its author: still counted in the day's quota.
  deleted INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX posts_user_day ON posts (user_id, day);
CREATE INDEX posts_user_created ON posts (user_id, created_at);
CREATE INDEX posts_ip ON posts (ip_hash);
CREATE INDEX posts_created ON posts (created_at);

CREATE TABLE votes (
  post_id TEXT NOT NULL REFERENCES posts (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX votes_user_day ON votes (user_id, day);

CREATE TABLE reports (
  post_id TEXT NOT NULL REFERENCES posts (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX reports_user_day ON reports (user_id, day);
