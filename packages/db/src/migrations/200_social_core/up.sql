-- 200_social_core
-- Kuyil social persistence foundation — profiles, posts, follows, curations
-- (feeds + filters), per-user preferences, and the legal-only report queue.
-- Bounded context: social
-- Idempotent: uses IF NOT EXISTS throughout.
-- No cross-context foreign keys: user ids are identity subject ids, held as
-- bare UUIDs; money lives in the wallet context and is referenced by id only.

CREATE SCHEMA IF NOT EXISTS social;

COMMENT ON SCHEMA social IS 'Social bounded context — owns profiles, posts, the follow graph, curations (feeds and filters), preferences and legal reports.';

-- ============================================================
-- Profiles: one per identity user. Handle is the public name.
-- ============================================================
CREATE TABLE IF NOT EXISTS social.profiles (
  user_id          UUID        PRIMARY KEY,
  handle           TEXT        NOT NULL,
  bio              TEXT        NOT NULL DEFAULT '',
  sub_price_minor  INTEGER     NOT NULL DEFAULT 500,
  verified_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT profiles_handle_format CHECK (handle ~ '^[a-z0-9_]{2,20}$'),
  CONSTRAINT profiles_bio_length CHECK (char_length(bio) <= 160),
  CONSTRAINT profiles_sub_price_range CHECK (sub_price_minor BETWEEN 100 AND 1000000)
);

CREATE UNIQUE INDEX IF NOT EXISTS profiles_handle_idx ON social.profiles (handle);

-- ============================================================
-- Posts. Replies are posts with reply_to set. Removal is a legal
-- action only (see reports) and is soft: the row stays for audit.
-- ============================================================
CREATE TABLE IF NOT EXISTS social.posts (
  id                UUID        PRIMARY KEY,
  author_id         UUID        NOT NULL REFERENCES social.profiles (user_id),
  body              TEXT        NOT NULL,
  labels            TEXT[]      NOT NULL DEFAULT '{}',
  subscribers_only  BOOLEAN     NOT NULL DEFAULT false,
  reply_to          UUID        REFERENCES social.posts (id),
  removed_at        TIMESTAMPTZ,
  removed_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT posts_body_length CHECK (char_length(body) BETWEEN 1 AND 500),
  CONSTRAINT posts_labels_known CHECK (labels <@ ARRAY['politics','nsfw','crypto','religion','spoilers']::TEXT[]),
  CONSTRAINT posts_removed_reason CHECK ((removed_at IS NULL) = (removed_reason IS NULL))
);

-- Global timeline (Everything / Hot / Brand-safe): top-level, not removed.
CREATE INDEX IF NOT EXISTS posts_timeline_idx
  ON social.posts (created_at DESC, id DESC)
  WHERE removed_at IS NULL AND reply_to IS NULL;

-- Author pages and the Following feed.
CREATE INDEX IF NOT EXISTS posts_author_idx
  ON social.posts (author_id, created_at DESC, id DESC)
  WHERE removed_at IS NULL;

-- Threads.
CREATE INDEX IF NOT EXISTS posts_reply_idx
  ON social.posts (reply_to, created_at)
  WHERE reply_to IS NOT NULL;

-- Keyword feeds / filters scan body text; trigram keeps ILIKE cheap.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS posts_body_trgm_idx
  ON social.posts USING gin (lower(body) gin_trgm_ops)
  WHERE removed_at IS NULL;

-- ============================================================
-- Follow graph.
-- ============================================================
CREATE TABLE IF NOT EXISTS social.follows (
  follower_id  UUID        NOT NULL REFERENCES social.profiles (user_id),
  followee_id  UUID        NOT NULL REFERENCES social.profiles (user_id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT follows_not_self CHECK (follower_id <> followee_id)
);

CREATE INDEX IF NOT EXISTS follows_followee_idx ON social.follows (followee_id, created_at DESC);

-- ============================================================
-- Curations: community-published feeds (what to show) and filters
-- (what to hide). Built-ins (following, latest, hot, brandsafe,
-- f_nsfw, ...) are code, not rows. A priced curation is unlocked
-- once per user through a wallet purchase (curation_access).
-- ============================================================
CREATE TABLE IF NOT EXISTS social.curations (
  id           UUID        PRIMARY KEY,
  owner_id     UUID        NOT NULL REFERENCES social.profiles (user_id),
  kind         TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  description  TEXT        NOT NULL DEFAULT '',
  keywords     TEXT[]      NOT NULL DEFAULT '{}',
  labels       TEXT[]      NOT NULL DEFAULT '{}',
  price_minor  INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,

  CONSTRAINT curations_kind_check CHECK (kind IN ('feed', 'filter')),
  CONSTRAINT curations_name_length CHECK (char_length(name) BETWEEN 1 AND 40),
  CONSTRAINT curations_price_range CHECK (price_minor BETWEEN 0 AND 1000000),
  CONSTRAINT curations_has_rule CHECK (cardinality(keywords) > 0 OR cardinality(labels) > 0),
  CONSTRAINT curations_keywords_cap CHECK (cardinality(keywords) <= 30)
);

CREATE INDEX IF NOT EXISTS curations_kind_idx
  ON social.curations (kind, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS social.curation_access (
  user_id       UUID        NOT NULL,
  curation_id   UUID        NOT NULL REFERENCES social.curations (id),
  transfer_id   UUID,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, curation_id)
);

-- ============================================================
-- Per-user preferences: which feeds are tabs, which filters run.
-- Values are built-in ids or curation UUIDs as text.
-- ============================================================
CREATE TABLE IF NOT EXISTS social.user_prefs (
  user_id      UUID        PRIMARY KEY,
  feeds        TEXT[]      NOT NULL DEFAULT ARRAY['following','latest','hot','brandsafe']::TEXT[],
  filters      TEXT[]      NOT NULL DEFAULT ARRAY['f_nsfw']::TEXT[],
  active_feed  TEXT        NOT NULL DEFAULT 'latest',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT user_prefs_feeds_cap CHECK (cardinality(feeds) <= 20),
  CONSTRAINT user_prefs_filters_cap CHECK (cardinality(filters) <= 20)
);

-- ============================================================
-- Reports: the legal floor. Reasons are a closed list; "I dislike
-- this" is not a reason — readers use filters for that.
-- ============================================================
CREATE TABLE IF NOT EXISTS social.reports (
  id            UUID        PRIMARY KEY,
  post_id       UUID        NOT NULL REFERENCES social.posts (id),
  reporter_id   UUID        NOT NULL,
  reason        TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'open',
  resolved_by   UUID,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT reports_reason_check CHECK (reason IN ('csam', 'credible_threat', 'court_order', 'ncii', 'fraud')),
  CONSTRAINT reports_status_check CHECK (status IN ('open', 'removed', 'kept')),
  CONSTRAINT reports_resolution_check CHECK ((status = 'open') = (resolved_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS reports_one_open_per_reporter_idx
  ON social.reports (post_id, reporter_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS reports_queue_idx
  ON social.reports (created_at)
  WHERE status = 'open';
