# social-worker runbook

- **Health:** `GET /v1/social/health`.
- **Legal queue access:** set `SOCIAL_ADMINS` (comma-separated `usr_…` ids) in `wrangler.template.jsonc` per environment.
- **Test money on stage:** `POST /v1/social/me/wallet/dev-topup {"amountMinor": 10000}`. It returns 404 in prod.
- **Stuck deposits:** the cron refunds anything past `expires_at`. To force a sweep, trigger the scheduled handler from the Cloudflare dashboard.
- **Ledger audit:** `SELECT transfer_id, SUM(amount_minor) FROM wallet.postings GROUP BY 1 HAVING SUM(amount_minor) <> 0;` must return no rows.
