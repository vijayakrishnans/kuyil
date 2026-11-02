# --- Self-healing adoption (AWS-free state seeding) ---
#
# Same pattern as cloudflare-kv/terraform/adopt.tf: when the platform state
# does not yet track the Supabase project but the organization already has one
# under this name, import it by ref at plan time instead of colliding with the
# duplicate-name guard. Fresh products resolve to id = "" and create normally;
# a resource already in state short-circuits the lookup.
#
# Cutover caveat: database_password is config-driven (random_password). After
# adoption the first apply RESETS the database password to the newly generated
# one and publishes it through the job-output secrets — db-migrate, hyperdrive
# and the worker fleet re-wire from those in the same run, but anything still
# consuming the pre-adoption credentials breaks until that run converges.

data "external" "adopt_project" {
  program = ["bash", "-c", <<-EOT
    set -euo pipefail
    name="$(jq -r .name)"
    state_file="$(mktemp)"
    trap 'rm -f "$state_file"' EXIT
    code="$(curl -s -o "$state_file" -w '%%{http_code}' \
      -u "$TF_HTTP_USERNAME:$TF_HTTP_PASSWORD" "$TF_HTTP_ADDRESS" || echo 000)"
    if [ "$code" = "200" ] && jq -e \
        '[.resources[]? | select(.type == "supabase_project" and .name == "this")] | length > 0' \
        "$state_file" >/dev/null 2>&1; then
      jq -n '{id: ""}'
      exit 0
    fi
    resp="$(curl -fsS --retry 3 -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
      "https://api.supabase.com/v1/projects")"
    # The org id reaches this job as TF_VAR_supabaseOrgId (the component maps
    # the SUPABASE_ORG_ID secret to the terraform variable); plain
    # SUPABASE_ORG_ID exists only in older wirings. Accept either; with
    # neither set, match by name alone.
    org="$${TF_VAR_supabaseOrgId:-$${SUPABASE_ORG_ID:-}}"
    printf '%s' "$resp" | jq -c --arg n "$name" --arg org "$org" \
      '{id: ([.[] | select(.name == $n and ($org == "" or .organization_id == $org)) | .id] | first // "")}'
  EOT
  ]
  query = {
    name = local.project_name
  }
}

import {
  for_each = toset(compact([data.external.adopt_project.result.id]))
  to       = supabase_project.this
  id       = each.value
}
