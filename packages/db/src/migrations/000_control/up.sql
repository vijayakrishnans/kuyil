-- Baseline control migration
-- Creates the migration tracking schema used by the migration runner.
-- Owner: control bounded context

CREATE SCHEMA IF NOT EXISTS _migrations;

CREATE TABLE IF NOT EXISTS _migrations.applied (
  id          TEXT PRIMARY KEY,
  context     TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by  TEXT NOT NULL DEFAULT current_user
);

COMMENT ON TABLE _migrations.applied IS
  'Tracks which migrations have been applied to the database.';
