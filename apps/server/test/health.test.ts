import { databaseIsReady, type SentServices } from "@sent/core";
import type { HealthResponse } from "@sent/shared";
import { expect, it, vi } from "vitest";
import { buildServer } from "../src/app.ts";

vi.mock("@sent/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sent/core")>()),
  databaseIsReady: vi.fn(),
}));

it.each([true, false])("serves public JSON health when database readiness is %s", async (ready) => {
  vi.mocked(databaseIsReady).mockResolvedValue(ready);
  const healthy = {
    status: "ok",
    workerHeartbeat: "2026-11-19T20:00:00.000Z",
    failedMutations: 0,
    classificationFailures: 0,
    sync: {
      accounts: 1,
      needsReauth: 0,
      oldestSuccessfulSyncAt: "2026-11-19T20:00:00.000Z",
      stale: 0,
      fresh: true,
    },
  } satisfies Omit<HealthResponse, "database">;
  const repository = { health: vi.fn().mockResolvedValue(healthy) };
  const app = await buildServer({
    services: { repository } as unknown as SentServices,
    sessionSecret: "health-test-session-secret-long-enough",
    passwordHash: "not-used",
    serveWeb: false,
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual(
      ready
        ? { ...healthy, database: true }
        : {
            status: "degraded",
            database: false,
            workerHeartbeat: null,
            failedMutations: 0,
            classificationFailures: 0,
            sync: {
              accounts: 0,
              needsReauth: 0,
              oldestSuccessfulSyncAt: null,
              stale: 0,
              fresh: false,
            },
          },
    );
    expect(repository.health).toHaveBeenCalledTimes(ready ? 1 : 0);
  } finally {
    await app.close();
  }
});
