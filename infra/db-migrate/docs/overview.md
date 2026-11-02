# db-migrate

Applies database migrations to stage and prod Supabase instances

Owns the kuyil database schema: migrations plan on pull requests and
apply on merge to `main`, per environment, ordered after the Supabase
projects exist.

## Depends on

- **db**
- **supabase** — Provisions Supabase projects for stage and prod and wires credentials into orun secrets
