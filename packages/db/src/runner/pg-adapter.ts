import type { MigrationEntry } from "../types.js";
import type { AppliedMigration, MigrationAdapter } from "./types.js";

export class PgAdapter implements MigrationAdapter {
  private client: import("pg").Client | null = null;
  private connectionUri: string;

  constructor(connectionUri: string) {
    this.connectionUri = connectionUri;
  }

  async connect(): Promise<void> {
    const { Client } = await import("pg");
    this.client = new Client({
      connectionString: this.connectionUri,
      ssl: { rejectUnauthorized: false },
    });
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }

  async acquireAdvisoryLock(lockId: number): Promise<boolean> {
    const res = await this.query(
      `SELECT pg_try_advisory_lock($1)`,
      [lockId],
    );
    const row = res.rows[0] as { pg_try_advisory_lock: boolean } | undefined;
    return row?.pg_try_advisory_lock ?? false;
  }

  async releaseAdvisoryLock(lockId: number): Promise<void> {
    await this.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
  }

  async getAppliedMigrations(): Promise<AppliedMigration[]> {
    const res = await this.query(
      `SELECT id, context, checksum, applied_at::text as applied_at
       FROM _migrations.applied ORDER BY id`,
    );
    return res.rows as unknown as AppliedMigration[];
  }

  async beginTransaction(): Promise<void> {
    await this.query("BEGIN");
  }

  async commitTransaction(): Promise<void> {
    await this.query("COMMIT");
  }

  async rollbackTransaction(): Promise<void> {
    await this.query("ROLLBACK");
  }

  async executeSql(sql: string): Promise<void> {
    await this.query(sql);
  }

  async recordMigration(entry: MigrationEntry): Promise<void> {
    await this.query(
      `INSERT INTO _migrations.applied (id, context, checksum)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [entry.id, entry.context, entry.checksum],
    );
  }

  private async query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    if (!this.client) {
      throw new Error("PgAdapter: not connected");
    }
    return this.client.query(text, values) as Promise<{ rows: Record<string, unknown>[] }>;
  }
}
