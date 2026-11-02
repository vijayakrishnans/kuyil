import postgres from "postgres";

export interface SqlRow {
  [column: string]: unknown;
}

export interface SqlExecutorResult<T extends SqlRow = SqlRow> {
  rows: T[];
  rowCount: number;
}

export interface SqlExecutor {
  execute<T extends SqlRow = SqlRow>(
    text: string,
    params?: unknown[],
  ): Promise<SqlExecutorResult<T>>;
}

export interface TransactionalSqlExecutor extends SqlExecutor {
  transaction<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

export interface SqlExecutorFactory {
  create(binding: { connectionString: string }): SqlExecutor & { dispose(): Promise<void> };
}

// NOTE: Per-request client. A module-scoped reuse pool was attempted (task 0134)
// but the Cloudflare Workers runtime rejects reusing a postgres client/socket
// opened in one request from another ("Cannot perform I/O on behalf of a
// different request"), which broke membership/billing on stage and the
// self-heal retry did not reliably recover. Reverted to per-request creation.
// Any future reuse attempt MUST be canary-verified on stage before rollout.
export function createSqlExecutor(
  binding: { connectionString: string },
  clientFactory?: (connectionString: string) => postgres.Sql,
): TransactionalSqlExecutor & { dispose(): Promise<void> } {
  const factory =
    clientFactory ??
    ((cs: string) =>
      postgres(cs, {
        max: 5,
        fetch_types: false,
        prepare: true,
      }));

  const sql = factory(binding.connectionString);

  return {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      const result = await sql.unsafe(text, (params ?? []) as never[]);
      return {
        rows: result as unknown as T[],
        rowCount: result.length,
      };
    },

    async transaction<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      return sql.begin(async (txSql) => {
        const txExecutor: SqlExecutor = {
          async execute<R extends SqlRow = SqlRow>(
            text: string,
            params?: unknown[],
          ): Promise<SqlExecutorResult<R>> {
            const result = await txSql.unsafe(text, (params ?? []) as never[]);
            return {
              rows: result as unknown as R[],
              rowCount: result.length,
            };
          },
        };
        return fn(txExecutor);
      }) as Promise<T>;
    },

    async dispose(): Promise<void> {
      try {
        await sql.end({ timeout: 3 });
      } catch {
        // Disposal failure must not leak errors.
      }
    },
  };
}
