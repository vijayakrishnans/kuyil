terraform {
  required_version = ">= 1.15.0"

  # State lives on the platform (SB1): the runner exports TF_HTTP_* per job, so
  # this block stays empty — no S3 bucket, no AWS role, no workspaces.
  backend "http" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
  }
}

# --- Providers ---

# Authenticates via the CLOUDFLARE_API_TOKEN env var (provider-native): the
# token is an orun-managed secret resolved into the job env at run time, so it
# never transits Terraform variables.
provider "cloudflare" {}

# --- Variables (standard Orun parameters) ---

variable "cloudflare_account_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Cloudflare account ID (from CLOUDFLARE_ACCOUNT_ID env var)"
}

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
  default = "cloudflare-domain"
}

variable "stackName" {
  type    = string
  default = "cloudflare-domain"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

# --- Domain variables (from intent.yaml env and component parameters) ---

variable "baseDomain" {
  type        = string
  default     = "kuyil.example.com"
  description = "Root domain to manage (from BASE_DOMAIN env or component parameter)"
}

variable "zoneMode" {
  type        = string
  default     = "existing"
  description = "Zone management mode: 'existing' adopts zone, 'managed' creates it"
  validation {
    condition     = contains(["existing", "managed"], var.zoneMode)
    error_message = "zoneMode must be 'existing' or 'managed'."
  }
}

variable "workerNamePrefix" {
  type        = string
  default     = "kuyil-web-console-next"
  description = "Worker name prefix for the new console; full Worker service name is {prefix}-{environment}"
}

variable "CONSOLE_CUSTOM_DOMAIN" {
  type        = string
  default     = ""
  description = "Custom domain for the console (from CONSOLE_CUSTOM_DOMAIN env var via TF_VAR)"
}

# --- Locals ---

locals {
  console_custom_domain = var.CONSOLE_CUSTOM_DOMAIN
  worker_name           = "${var.workerNamePrefix}-${var.environment}"
  has_custom_domain     = local.console_custom_domain != ""
}

# --- Zone lookup (existing mode) ---

data "cloudflare_zone" "existing" {
  count = var.zoneMode == "existing" ? 1 : 0
  name  = var.baseDomain
}

# --- Zone creation (managed mode) ---

resource "cloudflare_zone" "managed" {
  count      = var.zoneMode == "managed" ? 1 : 0
  account_id = var.cloudflare_account_id
  zone       = var.baseDomain
  plan       = "free"
}

locals {
  zone_id     = var.zoneMode == "existing" ? data.cloudflare_zone.existing[0].id : cloudflare_zone.managed[0].id
  zone_name   = var.baseDomain
  zone_status = var.zoneMode == "existing" ? data.cloudflare_zone.existing[0].status : cloudflare_zone.managed[0].status
}

# --- Worker custom domain attachment ---
#
# Phase 1 of 2 — state entry dropped here; v5 re-import lands in Task 0085b.
#
# Background: in the cloudflare TF provider v4.x line this resource is named
# `cloudflare_workers_domain` (description: "Creates a Worker Custom Domain.").
# It is renamed to `cloudflare_workers_custom_domain` in v5. The v5 provider
# does not implement cross-resource-type `MoveState` for this rename, so a
# single-PR migration is impossible (proven by failed PR-CI runs 26642692516
# and 26642904336 — see ai/proposals/task-0085-spec-update.md).
#
# The v5 upgrade guide's sanctioned pattern (same shape `tf-migrate` produces
# for `cloudflare_zone_settings_override`) is a two-phase migration gated on
# a real v4 apply between the phases:
#
#   - Phase 1 (THIS PR, Task 0085a): stay on `cloudflare ~> 4.52`, drop the
#     v4-typed state entry via `removed { lifecycle { destroy = false } }`.
#     The live Cloudflare custom-domain resource is NOT touched — only the
#     Terraform state file in S3 is mutated. Expected plan diff:
#       Plan: 0 to add, 0 to change, 1 to forget.
#     After post-merge apply, `stage.kuyil.example.com` and `prod.kuyil.example.com`
#     continue to serve from their existing Workers (immutable IDs
#     052eaece5e989d5a7280b6c206e562c42950e3a6 and
#     31e5f2ed1b1e4a5700e8ae0678846a0d753840e1) but are no longer tracked.
#
#   - Phase 2 (Task 0085b, separate PR after 0085a's apply lands on both
#     envs): bump `required_providers.cloudflare.version` to `~> 5.0`,
#     replace the fenced block below with a v5
#     `resource "cloudflare_workers_custom_domain" "console"`, and use an
#     `import {}` block keyed by env to re-adopt the live resources by their
#     known immutable IDs.

removed {
  from = cloudflare_workers_domain.console
  lifecycle {
    destroy = false
  }
}

# REMOVED IN 0085a, REPLACED IN 0085b
# The original v4 resource block is fenced (not deleted) so the diff is
# obviously a state-only drop and the v5 replacement in 0085b is easy to
# diff against the v4 shape. Do not uncomment this block — uncommenting it
# under the ~> 4.52 pin would re-create the state entry on the next apply
# and undo Phase 1. Phase 2 replaces it with the v5 resource type, not by
# reviving this block.
#
# resource "cloudflare_workers_domain" "console" {
#   count = local.has_custom_domain ? 1 : 0
#
#   account_id  = var.cloudflare_account_id
#   zone_id     = local.zone_id
#   hostname    = local.console_custom_domain
#   service     = local.worker_name
#   environment = "production"
# }

# --- Outputs (non-secret) ---

output "zone_id" {
  description = "Cloudflare zone ID"
  value       = local.zone_id
}

output "zone_name" {
  description = "Cloudflare zone name"
  value       = local.zone_name
}

output "zone_status" {
  description = "Cloudflare zone activation status"
  value       = local.zone_status
}

output "console_custom_domain" {
  description = "Console custom domain hostname"
  value       = local.console_custom_domain
}

output "worker_name" {
  description = "Worker service name bound to the custom domain"
  value       = local.worker_name
}

output "worker_custom_domain_id" {
  description = "Cloudflare Workers custom domain attachment ID (placeholder during 0085a — the resource is intentionally untracked between Phase 1 state drop and Phase 2 v5 re-import; downstream consumers should not read this value during the 0085a → 0085b window)."
  value       = local.has_custom_domain ? "pending_v5_reimport_task_0085b" : "not_configured"
}
