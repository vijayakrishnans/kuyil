import type { MigrationEntry } from "../types.js";
import type { AppliedMigration, MigrationAdapter } from "./types.js";

const SUPABASE_API_BASE = "https://api.supabase.com";

export class SupabaseApiAdapter implements MigrationAdapter {
  private projectRef: string;
  private accessToken: string;

  constructor(projectRef: string, accessToken: string) {
    this.projectRef = projectRef;
    this.accessToken = accessToken;
  }

  async connect(): Promise<void> { /* stateless HTTP — no persistent connection */ }
  async disconnect(): Promise<void> { /* no-op */ }

  // Advisory locks are session-scoped and can't be held across HTTP calls.
  // Idempotent ON CONFLICT DO NOTHING in recordMigration protects against
  // duplicate application when concurrent runners are unlikely.
  async acquireAdvisoryLock(_lockId: number): Promise<boolean> { return true; }
  async releaseAdvisoryLock(_lockId: number): Promise<void> { /* no-op */ }

  async getAppliedMigrations(): Promise<AppliedMigration[]> {
    try {
      const rows = await this.query(
        `SELECT id, context, checksum, applied_at::text AS applied_at
         FROM _migrations.applied ORDER BY id`,
      );
      return rows as unknown as AppliedMigration[];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Table doesn't exist yet — first-ever run.
      if (msg.includes("does not exist")) {
        return [];
      }
      throw err;
    }
  }

  // Transactions: each step is sent immediately in autocommit mode.
  // The migration SQL and record insertion are sent as separate calls.
  // Migrations must be idempotent; the runner's ON CONFLICT DO NOTHING
  // in recordMigration ensures safe re-runs.
  async beginTransaction(): Promise<void> { /* no-op */ }
  async commitTransaction(): Promise<void> { /* no-op */ }
  async rollbackTransaction(): Promise<void> { /* no-op */ }

  async executeSql(sql: string): Promise<void> {
    await this.query(sql);
  }

  async recordMigration(entry: MigrationEntry): Promise<void> {
    const id = entry.id.replace(/'/g, "''");
    const context = entry.context.replace(/'/g, "''");
    const checksum = entry.checksum.replace(/'/g, "''");
    await this.query(
      `INSERT INTO _migrations.applied (id, context, checksum)
       VALUES ('${id}', '${context}', '${checksum}')
       ON CONFLICT (id) DO NOTHING`,
    );
  }

  private async query(sql: string): Promise<Record<string, unknown>[]> {
    const url = `${SUPABASE_API_BASE}/v1/projects/${this.projectRef}/database/query`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    });

    if (!response.ok) {
      const body = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(body) as { message?: string; error?: string };
        message = parsed.message ?? parsed.error ?? body;
      } catch {
        message = body || message;
      }
      throw new Error(message);
    }

    const data = await response.json();
    return Array.isArray(data) ? data as Record<string, unknown>[] : [];
  }
}
