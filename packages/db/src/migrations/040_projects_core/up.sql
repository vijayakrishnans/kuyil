-- 040_projects_core
-- Projects persistence foundation — projects and environments tables
-- Bounded context: projects

CREATE SCHEMA IF NOT EXISTS projects;

COMMENT ON SCHEMA projects IS 'Projects bounded context — owns project and environment persistence.';

-- Projects table: one project belongs to exactly one organization.
CREATE TABLE IF NOT EXISTS projects.projects (
  id          UUID PRIMARY KEY,
  org_id      UUID NOT NULL,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  slug_lower  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

COMMENT ON TABLE projects.projects IS 'Projects within an organization. Every query must scope by org_id.';
COMMENT ON COLUMN projects.projects.org_id IS 'Owning organization — opaque reference, no cross-context FK.';
COMMENT ON COLUMN projects.projects.slug_lower IS 'Lowercased slug for case-insensitive uniqueness within org.';

-- Unique slug per organization (case-insensitive via slug_lower)
CREATE UNIQUE INDEX IF NOT EXISTS projects_org_slug_lower_idx
  ON projects.projects (org_id, slug_lower);

-- Composite unique for FK target from environments
CREATE UNIQUE INDEX IF NOT EXISTS projects_org_id_id_idx
  ON projects.projects (org_id, id);

-- List projects by org, newest first with id tie-breaker
CREATE INDEX IF NOT EXISTS projects_org_created_idx
  ON projects.projects (org_id, created_at DESC, id DESC);

-- Environments table: one environment belongs to exactly one project and organization.
CREATE TABLE IF NOT EXISTS projects.environments (
  id          UUID PRIMARY KEY,
  org_id      UUID NOT NULL,
  project_id  UUID NOT NULL,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  slug_lower  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  FOREIGN KEY (org_id, project_id) REFERENCES projects.projects (org_id, id)
);

COMMENT ON TABLE projects.environments IS 'Environments within a project. Every query must scope by org_id + project_id.';
COMMENT ON COLUMN projects.environments.org_id IS 'Owning organization — denormalized for tenant isolation.';
COMMENT ON COLUMN projects.environments.project_id IS 'Owning project — same bounded context FK.';
COMMENT ON COLUMN projects.environments.slug_lower IS 'Lowercased slug for case-insensitive uniqueness within org+project.';

-- Unique slug per org + project (case-insensitive via slug_lower)
CREATE UNIQUE INDEX IF NOT EXISTS environments_org_project_slug_lower_idx
  ON projects.environments (org_id, project_id, slug_lower);

-- List environments by org + project, newest first with id tie-breaker
CREATE INDEX IF NOT EXISTS environments_org_project_created_idx
  ON projects.environments (org_id, project_id, created_at DESC, id DESC);
