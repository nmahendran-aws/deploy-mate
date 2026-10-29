-- ============================================================================
-- DeployMate Phase 9 (DM-902 / #2): Multi-Tenant PostgreSQL Schema
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  user_id          VARCHAR(64) PRIMARY KEY,
  email           VARCHAR(255) NOT NULL UNIQUE,
  display_name    VARCHAR(160) NOT NULL,
  username        VARCHAR(80) NOT NULL,
  avatar_url      TEXT,
  auth_provider   VARCHAR(32) NOT NULL DEFAULT 'github',
  student_verified BOOLEAN NOT NULL DEFAULT FALSE,
  academic_domain VARCHAR(120),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organizations (
  org_id          VARCHAR(64) PRIMARY KEY,
  name            VARCHAR(160) NOT NULL,
  slug            VARCHAR(100) NOT NULL UNIQUE,
  plan_tier       VARCHAR(32) NOT NULL DEFAULT 'CAMPUS_FREE',
  owner_user_id   VARCHAR(64) NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memberships (
  membership_id   VARCHAR(64) PRIMARY KEY,
  org_id          VARCHAR(64) NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  user_id         VARCHAR(64) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  user_email      VARCHAR(255) NOT NULL,
  role            VARCHAR(32) NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'DEVELOPER', 'VIEWER')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships(user_id);

CREATE TABLE IF NOT EXISTS projects (
  project_id         VARCHAR(64) PRIMARY KEY,
  org_id             VARCHAR(64) NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  name               VARCHAR(160) NOT NULL,
  slug               VARCHAR(100) NOT NULL,
  repo_url           TEXT NOT NULL,
  default_branch     VARCHAR(100) NOT NULL DEFAULT 'main',
  cloud_provider     VARCHAR(16) NOT NULL DEFAULT 'AWS',
  environments       JSONB NOT NULL DEFAULT '["production", "preview"]'::jsonb,
  created_by_user_id VARCHAR(64) NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_projects_org_id ON projects(org_id);

CREATE TABLE IF NOT EXISTS deployments (
  deployment_id      VARCHAR(64) PRIMARY KEY,
  org_id             VARCHAR(64) REFERENCES organizations(org_id) ON DELETE SET NULL,
  project_id         VARCHAR(64) REFERENCES projects(project_id) ON DELETE SET NULL,
  environment        VARCHAR(32) NOT NULL DEFAULT 'production',
  created_by_user_id VARCHAR(64),
  cloud_provider     VARCHAR(16) NOT NULL DEFAULT 'AWS',
  archetype          VARCHAR(32) NOT NULL DEFAULT 'STATIC_EDGE',
  tenancy            VARCHAR(32) NOT NULL DEFAULT 'DEPLOYMATE_MANAGED',
  target             VARCHAR(64) NOT NULL,
  status             VARCHAR(32) NOT NULL,
  repo_url           TEXT NOT NULL,
  custom_hostname    VARCHAR(255),
  url                TEXT,
  payload_json       JSONB NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deployments_org_created ON deployments(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);

CREATE TABLE IF NOT EXISTS reserved_hostnames (
  hostname        VARCHAR(255) PRIMARY KEY,
  deployment_id   VARCHAR(64) NOT NULL REFERENCES deployments(deployment_id) ON DELETE CASCADE,
  org_id          VARCHAR(64),
  reserved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- DeployMate Phase 9 · Sprint 2 (DM-906, DM-907, DM-908, DM-913)
-- ============================================================================

CREATE TABLE IF NOT EXISTS encrypted_secrets (
  secret_id          VARCHAR(64) PRIMARY KEY,
  org_id             VARCHAR(64) NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  project_id         VARCHAR(64) NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  environment        VARCHAR(32) NOT NULL DEFAULT 'production',
  secret_key         VARCHAR(128) NOT NULL,
  ciphertext         TEXT NOT NULL,
  iv                 VARCHAR(64) NOT NULL,
  auth_tag           VARCHAR(64) NOT NULL,
  masked_preview     VARCHAR(64) NOT NULL,
  updated_by_user_id VARCHAR(64),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, environment, secret_key)
);

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id VARCHAR(64) PRIMARY KEY,
  org_id          VARCHAR(64) NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  account_login   VARCHAR(120) NOT NULL,
  account_type    VARCHAR(32) NOT NULL DEFAULT 'Organization',
  repositories    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id  VARCHAR(128) PRIMARY KEY,
  event_type   VARCHAR(64) NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pr_preview_comments (
  comment_id     VARCHAR(64) PRIMARY KEY,
  repo_full_name VARCHAR(255) NOT NULL,
  pr_number      INTEGER NOT NULL,
  deployment_id  VARCHAR(64) NOT NULL,
  preview_url    TEXT,
  status         VARCHAR(32) NOT NULL,
  markdown_body  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repo_full_name, pr_number)
);
