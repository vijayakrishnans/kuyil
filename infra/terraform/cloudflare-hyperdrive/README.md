# Cloudflare Hyperdrive Infrastructure Component

## Overview

This Terraform component provisions **Cloudflare Hyperdrive** resources for stage and prod environments. Hyperdrive is a Cloudflare-managed connection pooler and gateway that enables Cloudflare Workers to safely connect to external Postgres databases (Supabase in this case) without IPv6 connection issues or Supavisor tenant-lookup failures.

**Status**: Production-ready for stage/prod. Dev environment is intentionally unprovisioned.

## Component Purpose

- **Runtime data-plane seam**: Establishes the Workers → Hyperdrive → Supabase Postgres connection path
- **Connection pooling**: Hyperdrive handles TCP pooling and Postgres protocol negotiation
- **IPv4-safe**: Bypasses IPv6-only Supabase connections and Supavisor tenant-resolution issues
- **Binding reference**: Outputs Hyperdrive resource IDs for use in Worker environment bindings (deferred to Task 0010)

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Cloudflare Workers (runtime)                        │
│ (apps/api-edge, apps/web-console-next, etc.)       │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ Hyperdrive binding
                   │
┌──────────────────▼──────────────────────────────────┐
│ Cloudflare Hyperdrive (gateway)                     │
│ - Connection pooling                                 │
│ - Postgres protocol negotiation                      │
│ - IPv4 routing                                       │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ Secure tunnel
                   │
┌──────────────────▼──────────────────────────────────┐
│ Supabase Postgres (stage or prod)                   │
│ (kuyil-stage, kuyil-prod)  │
└─────────────────────────────────────────────────────┘
```

## Resources Created

For each environment (stage, prod):

- **`cloudflare_hyperdrive_config`**: Hyperdrive gateway resource
  - **Name**: `{namespacePrefix}kuyil-{environment}` (e.g., `kuyil-stage`)
  - **Origin**: Supabase Postgres (host, port, database, user, password read from AWS Secrets Manager)
  - **Caching**: Enabled by default (can be disabled; not configured per-environment in this component)

## Parameters

All parameters follow the Orun/golden-path Terraform convention:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `awsRegion` | string | `us-east-1` | AWS region for Secrets Manager access |
| `cloudflareApiToken` | string | *(required, sensitive)* | Cloudflare API token (from `CLOUDFLARE_API_TOKEN` env var in CI) |
| `cloudflareAccountId` | string | `""` | Cloudflare account ID (from `CLOUDFLARE_ACCOUNT_ID` env var in CI, or passed as `-var`) |
| `orgName` | string | `kuyil` | Organization name (for tags and secret paths) |
| `owner` | string | `kuyil` | Repository owner (for tags) |
| `repo` | string | `kuyil` | Repository name (for tags and secret paths) |
| `namespace` | string | `kuyil` | Namespace (for labels and naming conventions) |
| `namespacePrefix` | string | `""` | Prefix for resource names (e.g., `dev-` for non-prod) |
| `environment` | string | `stage` | Environment name (stage or prod) |
| `component` | string | `cloudflare-hyperdrive` | Component name (for tags) |
| `stackName` | string | `cloudflare-hyperdrive` | Stack name (for identification) |
| `terraformDir` | string | `terraform` | Terraform module directory path |
| `terraformVersion` | string | `1.15.3` | Terraform version constraint |

## Outputs

All outputs are non-secret:

| Output | Description |
|--------|-------------|
| `hyperdrive_id` | Cloudflare Hyperdrive config ID (used in Worker bindings) |
| `hyperdrive_name` | Hyperdrive config name |
| `hyperdrive_connection_string` | Reference format `hyperdrive://{id}` (for documentation) |
| `database_host` | Supabase database host (for reference) |
| `database_port` | Supabase database port (for reference) |
| `database_name` | Supabase database name (for reference) |
| `database_user` | Supabase database user (for reference) |

## Dependencies

This component depends on:

1. **`supabase` component** (same repo)
   - Must run first to create Supabase projects and write credentials to AWS Secrets Manager
   - This component reads credentials from the secret path: `sourceplane/kuyil/supabase/{environment}`

2. **AWS Secrets Manager access**
   - IAM role must allow `secretsmanager:GetSecretValue` for the Supabase secret path
   - Configured by `aws-admin` repo via GitHub OIDC role

3. **Cloudflare API token**
   - GitHub Actions secret: `CLOUDFLARE_API_TOKEN`
   - Passed to Terraform as `CLOUDFLARE_API_TOKEN` env var (mapped to `var.cloudflareApiToken`)

4. **Cloudflare account ID**
   - GitHub Actions secret: `CLOUDFLARE_ACCOUNT_ID`
   - Passed to Terraform as `TF_VAR_cloudflareAccountId` or `--var cloudflareAccountId=...` in CI

## Environments

Subscribed environments:

- **stage**: `plan-only` by default; `apply` on merge to main (via `github-push-main` trigger)
- **prod**: `plan-only` by default; `apply` on merge to main (via `github-push-main` trigger)
- **dev**: Not subscribed (dev Supabase is intentionally unprovisioned)

## Secret Storage

Supabase credentials are stored in AWS Secrets Manager and read at plan/apply time:

- **Secret path**: `sourceplane/kuyil/supabase/{environment}`
- **Secret contents**: JSON with fields `database_host`, `database_port`, `database_name`, `database_user`, `database_password`
- **Terraform access**: Via `data.aws_secretsmanager_secret_version` data source
- **Lifecycle**: Written by the `supabase` component; this component reads only

**Important**: Database passwords are read from the secret but never logged or included in non-sensitive outputs.

## Cloudflare Hyperdrive Configuration

The component creates a `cloudflare_hyperdrive_config` resource with:

- **Origin type**: Postgres
- **Connection pooling**: Automatic (handled by Hyperdrive)
- **Caching**: Enabled (query result caching; can be disabled if needed)
- **Credentials**: Read from AWS Secrets Manager; not exposed in Terraform state

## Usage in Workers (Downstream Task 0010)

Once this component is applied, Worker bindings will reference the Hyperdrive resource ID:

```javascript
// wrangler.toml or environment bindings
[[env.stage.services]]
binding = "HYPERDRIVE_STAGE"
service = "kuyil-stage"

// Worker code (pseudocode)
import postgres from 'pg';
const db = env.HYPERDRIVE_STAGE;
const connection = postgres(db.connectionString);
```

See **Task 0010** for full Worker binding setup and runtime integration.

## Local Verification

### Prerequisites

```bash
# Ensure Orun CLI is installed
which orun

# Ensure AWS credentials are configured
aws sts get-caller-identity

# Ensure Supabase component has run at least once
# (Secrets Manager entries exist for stage/prod)
aws secretsmanager get-secret-value --secret-id sourceplane/kuyil/supabase/stage
```

### Validate Syntax

```bash
cd /path/to/kuyil
orun validate --intent intent.yaml
```

### Generate Local Plan

```bash
# Full plan
orun plan --intent intent.yaml --output plan.json

# Changed files only (useful for PR scoping)
orun plan --changed --intent intent.yaml --output plan.json --base main --head HEAD
```

### Dry-run Execute

```bash
# Dry-run the plan (no resources created)
orun run --plan plan.json --dry-run --runner github-actions
```

### Inspect Component

```bash
# List components
orun component --intent intent.yaml --long

# View the DAG
orun plan --intent intent.yaml --view dag
```

## Operational Notes

### Existing Hyperdrive Resources

If Hyperdrive resources were created outside of Terraform (manually via Cloudflare dashboard), **do not import them** in this task. The target architecture is Terraform-owned infrastructure. Any manual Hyperdrive resources can be migrated in a later task if needed.

### Secret Rotation

When Supabase database passwords rotate (Task 0006.1 pattern):

1. The `supabase` component updates the AWS Secrets Manager secret
2. Run `terraform apply` (or merge to main to trigger CI apply)
3. Hyperdrive detects the credential change and reconnects
4. Existing Worker connections are pooled transparently

### Scaling and Limits

Cloudflare Hyperdrive limits:

- Up to 100 Hyperdrive configs per account
- Connection pooling: up to 1,000 concurrent connections per config
- Caching: configurable; disabled for privacy-sensitive queries

For this task, default caching is enabled. Disable via component update if needed.

### Troubleshooting

| Issue | Resolution |
|-------|-----------|
| `terraform plan` shows no changes but Hyperdrive not created | Check `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` env vars are set and valid |
| `Error: Error reading secret` | Verify Supabase component ran first and wrote the secret to AWS Secrets Manager |
| `Error: 401 Unauthorized` | Check Cloudflare API token has Hyperdrive permissions; regenerate if needed |
| Hyperdrive state shows as `Misconfigured` | Check database credentials in AWS Secrets Manager are correct; re-run apply after credential rotation |

## Post-Apply Verification

After `terraform apply`:

```bash
# List Hyperdrive resources in Cloudflare
wrangler hyperdrive list

# Test connection (requires Worker binding, deferred to Task 0010)
# See Task 0010 for smoke tests
```

## Security

- **Credentials**: Read-only from AWS Secrets Manager; not committed to git
- **API token**: Sensitive variable; never logged
- **State**: Stored in AWS S3 (encrypted, access controlled)
- **Audit**: Terraform changes tagged with Repository, Component, Environment

## Related Tasks

- **Task 0006**: Supabase provisioning (creates credentials in AWS Secrets Manager)
- **Task 0008**: Migration runner (proves Supabase connectivity from CI)
- **Task 0009** (this): Hyperdrive infrastructure (establishes runtime connection seam)
- **Task 0010** (proposed): Worker binding setup (wires Hyperdrive into Worker environment)
- **Task 0011** (proposed): Worker code integration (uses Hyperdrive binding in runtime)

## References

- [Cloudflare Hyperdrive Docs](https://developers.cloudflare.com/hyperdrive/)
- [Cloudflare Terraform Provider](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/hyperdrive_config)
- [Orun Golden Path](../../../specs/core/orun-golden-path.md)
- [Constitution Rule 1: Cloudflare-first runtime](../../../specs/core/constitution.md#1-cloudflare-first-runtime-extraction-safe-data-plane)
