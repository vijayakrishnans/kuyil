# --- Self-healing adoption (AWS-free state seeding) ---
#
# Same pattern as cloudflare-kv/terraform/adopt.tf: when the platform state
# does not yet track the Hyperdrive config but Cloudflare already has one
# under this name, import it at plan time instead of creating a duplicate.
# Fresh products resolve to id = "" and create normally; a resource already in
# state short-circuits the lookup. Note the origin password still comes from
# config — after adoption the first apply re-asserts the origin credentials
# from SUPABASE_DB_PASSWORD, which is exactly the re-sync the cutover needs.

data "external" "adopt_hyperdrive_config" {
  program = ["bash", "-c", <<-EOT
    set -euo pipefail
    name="$(jq -r .name)"
    state_file="$(mktemp)"
    trap 'rm -f "$state_file"' EXIT
    code="$(curl -s -o "$state_file" -w '%%{http_code}' \
      -u "$TF_HTTP_USERNAME:$TF_HTTP_PASSWORD" "$TF_HTTP_ADDRESS" || echo 000)"
    if [ "$code" = "200" ] && jq -e \
        '[.resources[]? | select(.type == "cloudflare_hyperdrive_config" and .name == "postgres")] | length > 0' \
        "$state_file" >/dev/null 2>&1; then
      jq -n '{id: ""}'
      exit 0
    fi
    resp="$(curl -fsS --retry 3 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/hyperdrive/configs")"
    printf '%s' "$resp" | jq -c --arg n "$name" \
      '{id: ([.result[] | select(.name == $n) | .id] | first // "")}'
  EOT
  ]
  query = {
    name = local.hyperdrive_name
  }
}

import {
  for_each = toset(compact([data.external.adopt_hyperdrive_config.result.id]))
  to       = cloudflare_hyperdrive_config.postgres
  id       = "${var.cloudflare_account_id}/${each.value}"
}
