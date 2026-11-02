// Supabase credentials from the ENVIRONMENT (de-AWS): the supabase terraform
// component wires its outputs into the workspace's project/env secret rung
// (composition wire-secrets step), and orun resolves the keys this runner
// declares in its component secretEnv into the job env — SUPABASE_PROJECT_REF,
// SUPABASE_DB_PASSWORD, SUPABASE_DB_URL. No Secrets Manager, no AWS SDK.

export interface SupabaseSecret {
  project_ref: string;
  project_url: string;
  database_host: string;
  database_port: string;
  database_name: string;
  database_user: string;
  database_password: string;
  connection_uri: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set — declare it in the component's secretEnv (wired from the supabase component's outputs)`,
    );
  }
  return value;
}

/** Assembles the credential document from the wired env vars. The derived
 * fields (host/port/db/user) follow the same convention the supabase
 * component's payload always used. */
export function loadSecretFromEnv(): SupabaseSecret {
  const projectRef = requireEnv("SUPABASE_PROJECT_REF");
  const password = requireEnv("SUPABASE_DB_PASSWORD");
  const host = `db.${projectRef}.supabase.co`;
  const connectionUri =
    process.env["SUPABASE_DB_URL"]?.trim() ||
    `postgresql://postgres:${encodeURIComponent(password)}@${host}:5432/postgres`;
  return {
    project_ref: projectRef,
    project_url: `https://${projectRef}.supabase.co`,
    database_host: host,
    database_port: "5432",
    database_name: "postgres",
    database_user: "postgres",
    database_password: password,
    connection_uri: connectionUri,
  };
}

/** Direct or pooler connection URI. When a pooler region is provided, use the
 * Supabase session pooler to avoid IPv6 connectivity issues with the direct
 * database host — the pooler has IPv4 addresses and supports session-level
 * advisory locks and transactions. */
export function loadConnectionUriFromEnv(poolerRegion?: string): string {
  const secret = loadSecretFromEnv();
  if (poolerRegion) {
    const poolerHost = `aws-0-${poolerRegion}.pooler.supabase.com`;
    const user = `postgres.${secret.project_ref}`;
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(secret.database_password)}@${poolerHost}:6543/${secret.database_name}`;
  }
  return secret.connection_uri;
}
