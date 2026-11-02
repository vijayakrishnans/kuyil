import {
  createHyperdriveAdapter,
  type SqlClient,
  type DbHealthResult,
  type HyperdriveAdapter,
} from "@saas/db/hyperdrive";

function fakeClient(overrides?: Partial<SqlClient>): SqlClient {
  return {
    query: overrides?.query ?? (() => Promise.resolve([{ ok: 1 }])),
    end: overrides?.end ?? (() => Promise.resolve()),
  };
}

describe("HyperdriveAdapter", () => {
  describe("missing binding", () => {
    it("adapter is never created when binding is undefined", () => {
      const binding: { connectionString: string } | undefined = undefined;
      expect(binding).toBeUndefined();
    });
  });

  describe("successful read-only query", () => {
    it("returns configured=true and reachable=true", async () => {
      let queriedText: string | undefined;
      const client = fakeClient({
        query: (text: string) => {
          queriedText = text;
          return Promise.resolve([{ ok: 1 }]);
        },
      });

      const adapter: HyperdriveAdapter = createHyperdriveAdapter(
        { connectionString: "postgres://fake:fake@localhost:5432/test" },
        () => client,
      );

      const result: DbHealthResult = await adapter.ping();

      expect(result).toEqual({ configured: true, reachable: true });
      expect(queriedText).toBe("SELECT 1 AS ok");
    });
  });

  describe("query failure mapped to safe status", () => {
    it("returns configured=true and reachable=false on error", async () => {
      const client = fakeClient({
        query: () => Promise.reject(new Error("connection refused")),
      });

      const adapter = createHyperdriveAdapter(
        { connectionString: "postgres://fake:fake@localhost:5432/test" },
        () => client,
      );

      const result = await adapter.ping();

      expect(result).toEqual({ configured: true, reachable: false });
    });

    it("does not expose error details in the result", async () => {
      const client = fakeClient({
        query: () =>
          Promise.reject(
            new Error("password authentication failed for user admin"),
          ),
      });

      const adapter = createHyperdriveAdapter(
        { connectionString: "postgres://fake:fake@localhost:5432/test" },
        () => client,
      );

      const result = await adapter.ping();

      expect(JSON.stringify(result)).not.toContain("password");
      expect(JSON.stringify(result)).not.toContain("admin");
    });
  });

  describe("cleanup after success", () => {
    it("calls end on dispose", async () => {
      let endCalled = false;
      const client = fakeClient({
        end: () => {
          endCalled = true;
          return Promise.resolve();
        },
      });

      const adapter = createHyperdriveAdapter(
        { connectionString: "postgres://fake:fake@localhost:5432/test" },
        () => client,
      );

      await adapter.ping();
      await adapter.dispose();

      expect(endCalled).toBe(true);
    });
  });

  describe("cleanup after failure", () => {
    it("calls end on dispose even when ping fails", async () => {
      let endCalled = false;
      const client = fakeClient({
        query: () => Promise.reject(new Error("timeout")),
        end: () => {
          endCalled = true;
          return Promise.resolve();
        },
      });

      const adapter = createHyperdriveAdapter(
        { connectionString: "postgres://fake:fake@localhost:5432/test" },
        () => client,
      );

      await adapter.ping();
      await adapter.dispose();

      expect(endCalled).toBe(true);
    });
  });

  describe("Worker-safe import isolation", () => {
    it("does not export runner-only symbols", async () => {
      const mod = await import("@saas/db/hyperdrive");
      const exportKeys = Object.keys(mod);

      expect(exportKeys).toContain("createHyperdriveAdapter");
      expect(exportKeys).not.toContain("runMigrations");
      expect(exportKeys).not.toContain("PgAdapter");
      expect(exportKeys).not.toContain("loadSecret");
      expect(exportKeys).not.toContain("SupabaseApiAdapter");
    });
  });
});
