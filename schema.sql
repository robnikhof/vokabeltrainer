-- Vokabeltrainer: D1 schema. One row per card and one settings row per user.
-- "user" is the email address Cloudflare Access verified for the request.
-- "srv" is the server time the row was last written; clients pull rows with srv > their last pull.
CREATE TABLE IF NOT EXISTS cards (
  user       TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  lang       TEXT    NOT NULL DEFAULT '',
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  srv        INTEGER NOT NULL,
  PRIMARY KEY (user, id)
);
CREATE INDEX IF NOT EXISTS cards_user_srv ON cards (user, srv);

CREATE TABLE IF NOT EXISTS settings (
  user       TEXT    PRIMARY KEY,
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  srv        INTEGER NOT NULL
);
