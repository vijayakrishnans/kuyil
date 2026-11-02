# Supabase Infrastructure Component

Provisions Supabase projects for `stage` and `prod` environments under the
`kuyil` organization and stores generated credentials in AWS Secrets
Manager.

## Environments

| Environment | Project Name               | Status       |
|-------------|----------------------------|--------------|
| stage       | kuyil-stage    | Provisioned  |
| prod        | kuyil-prod     | Provisioned  |
| dev         | —                          | Not provisioned |

## Authentication

The Supabase Terraform provider authenticates via the `SUPABASE_ACCESS_TOKEN`
environment variable. In CI, the GitHub secret `SUPABASE_API_KEY` is mapped to
this variable.

## S3 Backend

State is stored at:
```
s3://sourceplane-<env>/env/<env>/kuyil/supabase/terraform.tfstate
```

## AWS Secrets Manager

Credentials are stored at:
```
sourceplane/kuyil/supabase/stage
sourceplane/kuyil/supabase/prod
```

The named Secrets Manager secret is treated as a stable container. Terraform
must not replace it during normal credential refreshes because AWS keeps deleted
secret names reserved during the recovery window. Credential and connection
changes should be written by creating a new `aws_secretsmanager_secret_version`
with `AWSCURRENT` instead of recreating `aws_secretsmanager_secret`.

If a prior failed apply left the secret scheduled for deletion, restore or
cancel deletion for the existing secret before retrying the Orun apply, then
remove any accidental Terraform taint from `aws_secretsmanager_secret.supabase`.

### Secret JSON Shape

```json
{
  "project_ref": "<assigned-by-supabase>",
  "project_url": "https://<project_ref>.supabase.co",
  "database_host": "db.<project_ref>.supabase.co",
  "database_port": "5432",
  "database_name": "postgres",
  "database_user": "postgres",
  "database_password": "<generated-32-char-password>",
  "connection_uri": "postgresql://postgres:<password>@db.<project_ref>.supabase.co:5432/postgres"
}
```

## Cloudflare Hyperdrive

Hyperdrive wiring is **not** included in this component. It belongs in a
follow-up Cloudflare infrastructure component that can reference the connection
details from Secrets Manager. This keeps the Supabase provisioning component
focused on database/project lifecycle only.

## Dependencies

- `bootstrap` component (S3 backend and AWS access)

## Outputs

| Output         | Description                          | Sensitive |
|----------------|--------------------------------------|-----------|
| project_ref    | Supabase project reference ID        | No        |
| project_name   | Supabase project name                | No        |
| project_url    | Supabase project URL                 | No        |
| secret_arn     | ARN of Secrets Manager secret        | No        |
| database_password | Generated DB password             | Yes       |
