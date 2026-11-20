import { describe, expect, it, vi } from "vitest";
import {
  calibrateClock,
  MAILBOX_CHANGED_CHANNEL,
  type NewMailDb,
  newMailPhase,
  prepareNewMailFixture,
  publishNewMail,
  removeNewMail,
  validateNewMailTarget,
} from "../src/new-mail.ts";

const fixture = {
  id: "message",
  thread: "thread",
  account: "account",
  email: "owner@example.test",
  date: new Date("2026-11-20T12:00:00Z"),
  subject: "Unique subject",
};
const db = () => ({ query: vi.fn<NewMailDb["query"]>().mockResolvedValue({ rows: [] }) });
describe("new-mail latency", () => {
  it("requires a loopback target and a local sent_bench database before opening connections", () => {
    const target = new URL("http://127.0.0.1:3000");
    expect(() =>
      validateNewMailTarget(target, "postgres://localhost/sent_bench_live"),
    ).not.toThrow();
    for (const database of [
      undefined,
      "postgres://localhost/sent",
      "postgres://shared.invalid/sent_bench",
    ])
      expect(() => validateNewMailTarget(target, database)).toThrow();
    expect(() =>
      validateNewMailTarget(
        new URL("https://production.invalid"),
        "postgres://localhost/sent_bench",
      ),
    ).toThrow();
  });
  it.each([1, 7, 15, 30])(
    "stratifies all %i polling phases without putting the delay inside timing",
    (count) => {
      const phases = Array.from({ length: count }, (_, index) => newMailPhase(index, count));
      expect(new Set(phases).size).toBe(count);
      expect(phases.every((phase) => phase >= 0 && phase < 4000)).toBe(true);
      expect(newMailPhase(-2, count)).toBe(0);
      expect(() => newMailPhase(0, 0)).toThrow();
    },
  );
  it("chooses the minimum-RTT clock midpoint with its uncertainty", async () => {
    const local = [0, 4, 10, 12, 20, 28, 30, 36, 40, 50],
      remote = [102, 111, 124, 133, 145];
    const clock = await calibrateClock(
      async () => remote.shift() as number,
      () => local.shift() as number,
    );
    expect(clock).toEqual({ offset: 100, uncertainty: 1 });
    await expect(calibrateClock(async () => Number.NaN)).rejects.toThrow(
      "Clock calibration failed",
    );
  });
  it("prepares an actually new subject above the seeded mailbox", async () => {
    const connection = db();
    connection.query.mockResolvedValue({
      rows: [{ id: "account", email: "owner@example.test", date: fixture.date }],
    });
    const prepared = await prepareNewMailFixture(connection);
    expect(prepared.subject).toContain(prepared.id);
    expect(prepared.account).toBe("account");
    expect(prepared.date).toEqual(fixture.date);
    connection.query.mockResolvedValue({ rows: [] });
    await expect(prepareNewMailFixture(connection)).rejects.toThrow("Seed the fake mailbox");
  });
  it("times from the first insert and notifies on the same channel within commit", async () => {
    const connection = db(),
      start = vi.fn();
    await publishNewMail(connection, fixture, start);
    expect(connection.query.mock.calls[0]).toEqual(["begin"]);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(
      connection.query.mock.invocationCallOrder[1] as number,
    );
    expect(connection.query).toHaveBeenCalledWith("select pg_notify($1,$2)", [
      MAILBOX_CHANGED_CHANNEL,
      "changed",
    ]);
    expect(connection.query.mock.calls.at(-1)).toEqual(["commit"]);
  });
  it("rolls back failed inserts without publishing or committing", async () => {
    const connection = db();
    connection.query.mockImplementation(async (sql) => {
      if (sql.startsWith("insert into messages")) throw new Error("insert failed");
      return { rows: [] };
    });
    await expect(publishNewMail(connection, fixture)).rejects.toThrow("insert failed");
    expect(connection.query.mock.calls.at(-1)).toEqual(["rollback"]);
    expect(
      connection.query.mock.calls.some(([sql]) => sql.includes("pg_notify") || sql === "commit"),
    ).toBe(false);
  });
  it("rolls back cleanup failure without publishing a partial deletion", async () => {
    const connection = db();
    connection.query.mockRejectedValueOnce(new Error("begin unavailable"));
    await expect(removeNewMail(connection, fixture)).rejects.toThrow("begin unavailable");
    expect(connection.query).toHaveBeenCalledTimes(1);
    connection.query.mockReset().mockImplementation(async (sql) => {
      if (sql.startsWith("delete from threads")) throw new Error("delete failed");
      return { rows: [] };
    });
    await expect(removeNewMail(connection, fixture)).rejects.toThrow("delete failed");
    expect(connection.query.mock.calls.at(-1)).toEqual(["rollback"]);
  });
  it("removes only the generated fixture and notifies after cleanup outside timing", async () => {
    const connection = db();
    await removeNewMail(connection, fixture);
    expect(connection.query).toHaveBeenCalledWith(
      "delete from messages where id=$1 and provider_message_id=$2",
      ["message", "bench-live-message"],
    );
    expect(connection.query).toHaveBeenCalledWith(
      "delete from threads where id=$1 and provider_thread_id=$2",
      ["thread", "bench-live-thread"],
    );
    expect(connection.query.mock.calls.at(-1)).toEqual(["commit"]);
  });
});
