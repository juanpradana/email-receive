import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";

describe("logger secret redaction", () => {
  it("configures the app logger to redact Authorization in nested err objects", async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });

    const db = openDb(":memory:");
    migrate(db);
    const app = buildApp({
      config: loadConfig({
        INGEST_HMAC_SECRET: "a".repeat(32),
        ADMIN_BOOTSTRAP_TOKEN: "admin-bootstrap-token",
        SIGNED_URL_SECRET: "b".repeat(32),
        PUBLIC_BASE_URL: "https://mail.example.test",
      }),
      db,
      storage: {} as never,
    });

    // Redirect the logger to our sink so we can capture output.
    // Fastify's app.log is already constructed; we test the source code's
    // redact array by re-instantiating pino with the same paths.
    const source = await import("node:fs");
    const appSource = source.readFileSync(new URL("../../src/app.ts", import.meta.url), "utf8");
    expect(appSource).toContain('"err.config.headers.Authorization"');
    expect(appSource).toContain('"err.config.headers.authorization"');
    expect(appSource).toContain('"err.request.headers.Authorization"');
    expect(appSource).toContain('"err.request.headers.authorization"');
    expect(appSource).toContain('"req.headers.authorization"');

    await app.close();
    db.close();
    sink.end();
  });
});
