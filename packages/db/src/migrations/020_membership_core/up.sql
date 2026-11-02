-- Membership persistence foundation.
-- Context: membership
-- Idempotent: uses IF NOT EXISTS throughout.

CREATE SCHEMA IF NOT EXISTS membership;

COMMENT ON SCHEMA membership IS 'Membership bounded context — owns organizations, members, invitations, and role assignments.';

-- Organizations: the root tenant boundary.
CREATE TABLE IF NOT EXISTS membership.organizations (
  id            UUID        PRIMARY KEY,
  name          TEXT        NOT NULL,
  slug          TEXT        NOT NULL,
  slug_lower    TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT organizations_status_check CHECK (status IN ('active', 'suspended', 'deleted'))
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_lower_idx
  ON membership.organizations (slug_lower);

COMMENT ON TABLE membership.organizations IS 'Root organization records — the tenant and billing boundary.';
COMMENT ON COLUMN membership.organizations.slug_lower IS 'Normalized (lower-case) slug for case-insensitive uniqueness.';

-- Organization members: connects a subject to an organization.
CREATE TABLE IF NOT EXISTS membership.organization_members (
  id              UUID        PRIMARY KEY,
  org_id          UUID        NOT NULL,
  subject_id      TEXT        NOT NULL,
  subject_type    TEXT        NOT NULL DEFAULT 'user',
  status          TEXT        NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT org_members_status_check CHECK (status IN ('active', 'removed')),
  CONSTRAINT org_members_subject_type_check CHECK (subject_type IN ('user', 'service_principal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS org_members_org_subject_idx
  ON membership.organization_members (org_id, subject_id);

CREATE INDEX IF NOT EXISTS org_members_subject_id_idx
  ON membership.organization_members (subject_id);

CREATE INDEX IF NOT EXISTS org_members_org_id_idx
  ON membership.organization_members (org_id);

COMMENT ON TABLE membership.organization_members IS 'Membership facts connecting subjects to organizations. Subject references are opaque IDs.';
COMMENT ON COLUMN membership.organization_members.subject_id IS 'Opaque subject ID from the identity or service-principal context.';
COMMENT ON COLUMN membership.organization_members.org_id IS 'The organization this membership belongs to.';

-- Organization invitations: invitation lifecycle records.
CREATE TABLE IF NOT EXISTS membership.organization_invitations (
  id              UUID        PRIMARY KEY,
  org_id          UUID        NOT NULL,
  email           TEXT        NOT NULL,
  email_lower     TEXT        NOT NULL,
  role            TEXT        NOT NULL,
  token_hash      TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending',
  invited_by      TEXT        NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT org_invitations_status_check CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  CONSTRAINT org_invitations_role_check CHECK (role IN (
    'owner', 'admin', 'builder', 'viewer', 'billing_admin',
    'project_admin', 'project_builder', 'project_viewer'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS org_invitations_token_hash_idx
  ON membership.organization_invitations (token_hash);

CREATE INDEX IF NOT EXISTS org_invitations_org_id_idx
  ON membership.organization_invitations (org_id);

CREATE INDEX IF NOT EXISTS org_invitations_email_lower_idx
  ON membership.organization_invitations (org_id, email_lower);

COMMENT ON TABLE membership.organization_invitations IS 'Invitation lifecycle records. Only token hashes stored, never raw tokens.';
COMMENT ON COLUMN membership.organization_invitations.token_hash IS 'SHA-256 hash of the invitation acceptance token. Raw token never stored.';
COMMENT ON COLUMN membership.organization_invitations.email_lower IS 'Normalized (lower-case) email for case-insensitive lookup.';

-- Role assignments: authorization facts consumed by the policy context.
CREATE TABLE IF NOT EXISTS membership.role_assignments (
  id              UUID        PRIMARY KEY,
  org_id          UUID        NOT NULL,
  subject_id      TEXT        NOT NULL,
  subject_type    TEXT        NOT NULL DEFAULT 'user',
  role            TEXT        NOT NULL,
  scope_kind      TEXT        NOT NULL DEFAULT 'organization',
  scope_ref       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,

  CONSTRAINT role_assignments_role_check CHECK (role IN (
    'owner', 'admin', 'builder', 'viewer', 'billing_admin',
    'project_admin', 'project_builder', 'project_viewer'
  )),
  CONSTRAINT role_assignments_scope_kind_check CHECK (scope_kind IN ('organization', 'project')),
  CONSTRAINT role_assignments_subject_type_check CHECK (subject_type IN ('user', 'service_principal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS role_assignments_active_idx
  ON membership.role_assignments (org_id, subject_id, role, scope_kind, COALESCE(scope_ref, ''))
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS role_assignments_org_subject_idx
  ON membership.role_assignments (org_id, subject_id);

CREATE INDEX IF NOT EXISTS role_assignments_subject_id_idx
  ON membership.role_assignments (subject_id);

COMMENT ON TABLE membership.role_assignments IS 'Authorization facts consumed by the policy context. Scoped to organization or project.';
COMMENT ON COLUMN membership.role_assignments.subject_id IS 'Opaque subject ID — no foreign key to identity context.';
COMMENT ON COLUMN membership.role_assignments.scope_kind IS 'organization or project — determines the scope of the role.';
COMMENT ON COLUMN membership.role_assignments.scope_ref IS 'Optional project reference for project-scoped roles. NULL for organization-scoped.';
