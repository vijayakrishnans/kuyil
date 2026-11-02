import postgres from "postgres";

export interface DbHealthResult {
  configured: boolean;
  reachable: boolean;
}

export interface SqlClient {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface HyperdriveAdapter {
  ping(): Promise<DbHealthResult>;
  dispose(): Promise<void>;
}

function createPostgresClient(connectionString: string): SqlClient {
  const sql = postgres(connectionString, {
    max: 5,
    fetch_types: false,
    prepare: true,
  });

  return {
    async query(text: string): Promise<unknown> {
      return sql.unsafe(text);
    },
    async end(): Promise<void> {
      await sql.end({ timeout: 3 });
    },
  };
}

export function createHyperdriveAdapter(
  binding: { connectionString: string },
  clientFactory?: (connectionString: string) => SqlClient,
): HyperdriveAdapter {
  const factory = clientFactory ?? createPostgresClient;
  const client = factory(binding.connectionString);

  return {
    async ping(): Promise<DbHealthResult> {
      try {
        await client.query("SELECT 1 AS ok");
        return { configured: true, reachable: true };
      } catch {
        return { configured: true, reachable: false };
      }
    },

    async dispose(): Promise<void> {
      try {
        await client.end();
      } catch {
        // Disposal failure must never mask a health response or leak errors.
      }
    },
  };
}
