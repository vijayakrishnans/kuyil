import {
  createSqlExecutor,
  type SqlRow,
} from "@saas/db/hyperdrive";

describe("SqlExecutor", () => {
  describe("parameterized query execution", () => {
    it("passes parameters to the underlying client", async () => {
      let capturedQuery: string | undefined;
      let capturedParams: unknown[] | undefined;

      const fakeSql = Object.assign(
        () => {
          throw new Error("tagged template not supported");
        },
        {
          unsafe: (text: string, params: unknown[]) => {
            capturedQuery = text;
            capturedParams = params;
            return Promise.resolve([{ id: "u-001", name: "test" }]);
          },
          end: () => Promise.resolve(),
        },
      );

      const executor = createSqlExecutor(
        { connectionString: "postgres://fake:fake@localhost/test" },
        () => fakeSql as never,
      );

      const result = await executor.execute(
        "SELECT * FROM users WHERE id = $1 AND status = $2",
        ["u-001", "active"],
      );

      expect(capturedQuery).toBe("SELECT * FROM users WHERE id = $1 AND status = $2");
      expect(capturedParams).toEqual(["u-001", "active"]);
      expect(result.rows).toEqual([{ id: "u-001", name: "test" }]);
      expect(result.rowCount).toBe(1);

      await executor.dispose();
    });

    it("defaults to empty params array when none provided", async () => {
      let capturedParams: unknown[] | undefined;

      const fakeSql = Object.assign(
        () => {
          throw new Error("tagged template not supported");
        },
        {
          unsafe: (_text: string, params: unknown[]) => {
            capturedParams = params;
            return Promise.resolve([]);
          },
          end: () => Promise.resolve(),
        },
      );

      const executor = createSqlExecutor(
        { connectionString: "postgres://fake:fake@localhost/test" },
        () => fakeSql as never,
      );

      await executor.execute("SELECT 1");

      expect(capturedParams).toEqual([]);

      await executor.dispose();
    });
  });

  describe("typed row results", () => {
    it("returns typed rows matching the generic parameter", async () => {
      interface UserRow extends SqlRow {
        id: string;
        email: string;
      }

      const fakeSql = Object.assign(
        () => {
          throw new Error("tagged template not supported");
        },
        {
          unsafe: () =>
            Promise.resolve([
              { id: "u-001", email: "test@example.com" },
              { id: "u-002", email: "other@example.com" },
            ]),
          end: () => Promise.resolve(),
        },
      );

      const executor = createSqlExecutor(
        { connectionString: "postgres://fake:fake@localhost/test" },
        () => fakeSql as never,
      );

      const result = await executor.execute<UserRow>("SELECT * FROM users");

      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]!.id).toBe("u-001");
      expect(result.rows[0]!.email).toBe("test@example.com");
      expect(result.rowCount).toBe(2);

      await executor.dispose();
    });
  });

  describe("error propagation", () => {
    it("throws SQL errors to callers (repository handles them)", async () => {
      const fakeSql = Object.assign(
        () => {
          throw new Error("tagged template not supported");
        },
        {
          unsafe: () => Promise.reject(new Error("connection refused")),
          end: () => Promise.resolve(),
        },
      );

      const executor = createSqlExecutor(
        { connectionString: "postgres://fake:fake@localhost/test" },
        () => fakeSql as never,
      );

      await expect(executor.execute("SELECT 1")).rejects.toThrow("connection refused");

      await executor.dispose();
    });
  });

  describe("dispose safety", () => {
    it("swallows dispose errors silently", async () => {
      const fakeSql = Object.assign(
        () => {
          throw new Error("tagged template not supported");
        },
        {
          unsafe: () => Promise.resolve([]),
          end: () => Promise.reject(new Error("already closed")),
        },
      );

      const executor = createSqlExecutor(
        { connectionString: "postgres://fake:fake@localhost/test" },
        () => fakeSql as never,
      );

      await expect(executor.dispose()).resolves.toBeUndefined();
    });
  });

  describe("transaction support", () => {
    it("transaction callback receives a working executor", async () => {
      const queries: string[] = [];

      const fakeSql = Object.assign(
        () => {
          throw new Error("tagged template not supported");
        },
        {
          unsafe: (text: string, _params: unknown[]) => {
            queries.push(text);
            return Promise.resolve([{ ok: true }]);
          },
          begin: (fn: (txSql: unknown) => Promise<unknown>) => {
            const txSql = {
              unsafe: (text: string, _params: unknown[]) => {
                queries.push(`TX:${text}`);
                return Promise.resolve([{ id: "row-1" }]);
              },
            };
            return fn(txSql);
          },
          end: () => Promise.resolve(),
        },
      );

      const executor = createSqlExecutor(
        { connectionString: "postgres://fake:fake@localhost/test" },
        () => fakeSql as never,
      );

      const result = await executor.transaction(async (txExec) => {
        const r = await txExec.execute("INSERT INTO foo VALUES ($1)", ["bar"]);
        return r.rows;
      });

      expect(result).toEqual([{ id: "row-1" }]);
      expect(queries).toContain("TX:INSERT INTO foo VALUES ($1)");

      await executor.dispose();
    });

    it("successful transaction commits (resolves)", async () => {
      const fakeSql = Object.assign(
        () => {
          throw new Error("tagged template not supported");
        },
        {
          unsafe: () => Promise.resolve([]),
          begin: async (fn: (txSql: unknown) => Promise<unknown>) => {
            const txSql = { unsafe: () => Promise.resolve([]) };
            return fn(txSql);
          },
          end: () => Promise.resolve(),
        },
      );

      const executor = createSqlExecutor(
        { connectionString: "postgres://fake:fake@localhost/test" },
        () => fakeSql as never,
      );

      const result = await executor.transaction(async () => "committed");
      expect(result).toBe("committed");

      await executor.dispose();
    });

    it("thrown callback rejects and rolls back", async () => {
      let rolledBack = false;

      const fakeSql = Object.assign(
        () => {
          throw new Error("tagged template not supported");
        },
        {
          unsafe: () => Promise.resolve([]),
          begin: async (fn: (txSql: unknown) => Promise<unknown>) => {
            const txSql = { unsafe: () => Promise.resolve([]) };
            try {
              return await fn(txSql);
            } catch (err) {
              rolledBack = true;
              throw err;
            }
          },
          end: () => Promise.resolve(),
        },
      );

      const executor = createSqlExecutor(
        { connectionString: "postgres://fake:fake@localhost/test" },
        () => fakeSql as never,
      );

      await expect(
        executor.transaction(async () => {
          throw new Error("business logic failed");
        }),
      ).rejects.toThrow("business logic failed");

      expect(rolledBack).toBe(true);

      await executor.dispose();
    });

    it("normal execute behavior is unchanged with transaction support", async () => {
      const fakeSql = Object.assign(
        () => {
          throw new Error("tagged template not supported");
        },
        {
          unsafe: (_text: string, _params: unknown[]) => Promise.resolve([{ val: 1 }]),
          begin: () => Promise.resolve(null),
          end: () => Promise.resolve(),
        },
      );

      const executor = createSqlExecutor(
        { connectionString: "postgres://fake:fake@localhost/test" },
        () => fakeSql as never,
      );

      const result = await executor.execute("SELECT 1 AS val");
      expect(result.rows).toEqual([{ val: 1 }]);
      expect(result.rowCount).toBe(1);

      await executor.dispose();
    });

    it("disposal remains safe after transaction usage", async () => {
      const fakeSql = Object.assign(
        () => {
          throw new Error("tagged template not supported");
        },
        {
          unsafe: () => Promise.resolve([]),
          begin: async (fn: (txSql: unknown) => Promise<unknown>) => {
            const txSql = { unsafe: () => Promise.resolve([]) };
            return fn(txSql);
          },
          end: () => Promise.reject(new Error("already closed")),
        },
      );

      const executor = createSqlExecutor(
        { connectionString: "postgres://fake:fake@localhost/test" },
        () => fakeSql as never,
      );

      await executor.transaction(async () => "ok");
      await expect(executor.dispose()).resolves.toBeUndefined();
    });
  });

  describe("Worker-safe export surface", () => {
    it("exports executor alongside existing hyperdrive symbols", async () => {
      const mod = await import("@saas/db/hyperdrive");
      const keys = Object.keys(mod);

      expect(keys).toContain("createSqlExecutor");
      expect(keys).toContain("createHyperdriveAdapter");
      expect(keys).not.toContain("runMigrations");
      expect(keys).not.toContain("PgAdapter");
      expect(keys).not.toContain("loadSecret");
    });

    it("exports TransactionalSqlExecutor type", async () => {
      const mod = await import("@saas/db/hyperdrive");
      const executor = mod.createSqlExecutor(
        { connectionString: "postgres://fake:fake@localhost/test" },
        () => Object.assign(() => { throw new Error("no"); }, { unsafe: () => Promise.resolve([]), begin: () => Promise.resolve(null), end: () => Promise.resolve() }) as never,
      );
      // Verify transaction method exists on the returned executor
      expect(typeof executor.transaction).toBe("function");
      await executor.dispose();
    });
  });
});
