terraform {
  required_version = ">= 1.15.0"

  # State lives on the platform (SB1): the runner exports TF_HTTP_* per job
  # (address = …/state/tfstate/{component}/{env}, run token as password), so
  # this block stays empty — no S3 bucket, no AWS role, no workspaces (the
  # environment is in the address).
  backend "http" {}

  required_providers {
    supabase = {
      source = "supabase/supabase"
      # Pinned below 1.6: from 1.6.0 the provider reads /billing/addons on
      # every project create/read, and Supabase does not serve billing
      # endpoints to OAuth tokens yet ("does not support oauth access") —
      # which is exactly the credential the platform brokers.
      version = "~> 1.5.1"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
  }
}

# --- Providers ---

# Authenticates via the SUPABASE_ACCESS_TOKEN env var (provider-native): a
# short-lived Management-API token minted per run from the workspace's
# Supabase integration, resolved into the job env by orun.
provider "supabase" {}

# --- Variables (standard Orun parameters) ---

variable "orgName" {
  type    = string
  default = "sourceplane"
}

variable "owner" {
  type    = string
  default = "sourceplane"
}

variable "repo" {
  type    = string
  default = "kuyil"
}

variable "namespace" {
  type    = string
  default = "sourceplane"
}

variable "namespacePrefix" {
  type    = string
  default = ""
}

variable "lane" {
  type    = string
  default = "verify"
}

variable "environment" {
  type    = string
  default = "stage"
}

variable "component" {
  type    = string
  default = "supabase"
}

variable "stackName" {
  type    = string
  default = "supabase"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

# Supabase target identity. supabaseRegion comes from the component's
# `spec.parameters`; supabaseOrgId is injected as TF_VAR_supabaseOrgId from the
# workspace's SUPABASE_ORG_ID secret (org-id connection fact). Both are
# required (no default) so a missing value fails plan loudly instead of
# silently pointing at the wrong org or region.
variable "supabaseOrgId" {
  type = string
}

variable "supabaseRegion" {
  type = string
}

# --- Locals ---

locals {
  supabase_org_id = var.supabaseOrgId
  supabase_region = var.supabaseRegion
  project_name    = "kuyil-${var.environment}"
}

# --- Generate database password ---

resource "random_password" "db_password" {
  length  = 32
  special = true
  # Avoid characters that cause issues in connection strings
  override_special = "!#$%&*()-_=+[]{}|:,.<>?"
}

# --- Supabase project ---

resource "supabase_project" "this" {
  organization_id   = local.supabase_org_id
  name              = local.project_name
  database_password = random_password.db_password.result
  region            = local.supabase_region
}

# --- Outputs ---
#
# Credentials leave this module ONLY through the composition's wire-secrets
# step (component.yaml `wireSecrets`), which pushes each named output into the
# workspace's project/{{env}} secret rung via `orun secrets set` (value over
# stdin, never argv). Consumers (cloudflare-hyperdrive, db-migrate, workers)
# read the same keys back as secretEnv references. No Secrets Manager.

output "project_ref" {
  description = "Supabase project reference ID"
  value       = supabase_project.this.id
}

output "project_name" {
  description = "Supabase project name"
  value       = supabase_project.this.name
}

output "project_url" {
  description = "Supabase project URL"
  value       = "https://${supabase_project.this.id}.supabase.co"
}

output "database_password" {
  description = "Generated database password (sensitive; wired to orun secrets)"
  value       = random_password.db_password.result
  sensitive   = true
}

output "connection_uri" {
  description = "Direct Postgres connection URI (sensitive; wired to orun secrets)"
  value       = "postgresql://postgres:${random_password.db_password.result}@db.${supabase_project.this.id}.supabase.co:5432/postgres"
  sensitive   = true
}
