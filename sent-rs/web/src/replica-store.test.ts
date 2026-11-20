// @vitest-environment node
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RECENT_BODY_DAYS, recentBodyCutoff } from "./replica-policy";
import { ReplicaStore } from "./replica-store";
import {
  MAX_BODY_BYTES,
  MAX_BODY_CACHE_BYTES,
  type ReplicaDelta,
  type ReplicaRow,
} from "./replica-types";

let sqlite: Awaited<ReturnType<typeof sqlite3InitModule>>, store: ReplicaStore;
function row(id: string, patch: Partial<ReplicaRow> = {}): ReplicaRow {
  return {
    id,
    threadId: id,
    account: { id: "owner", provider: "microsoft", email: "owner@test", displayName: "Owner" },
    subject: id,
    from: [{ name: "Sender", address: "sender@test" }],
    snippet: "Text",
    receivedAt: `2026-09-22T12:00:00.000Z`,
    sortReceivedAt: `2026-09-22T12:00:00.000000Z`,
    read: false,
    flagged: false,
    direction: "inbound",
    tier: null,
    modelTier: null,
    reasoning: null,
    aiSummary: null,
    attachmentCount: 0,
    syncPending: false,
    to: [],
    cc: [],
    bcc: [],
    sentAt: null,
    textBody: "",
    htmlBody: null,
    plainText: null,
    attachments: [],
    internetMessageId: null,
    archived: false,
    deleted: false,
    classified: false,
    bodyVersion: "v1",
    bodyAvailable: false,
    ...patch,
  };
}
function delta(upserts: ReplicaRow[] = [], deletions: string[] = []): ReplicaDelta {
  return { upserts, deletions, accounts: [], cursor: "next" };
}
function seed(rows: ReplicaRow[]) {
  store.stage(rows);
  store.commitStage("initial");
}
beforeAll(async () => {
  sqlite = await sqlite3InitModule();
});
beforeEach(() => {
  store = new ReplicaStore(new sqlite.oo1.DB(":memory:", "c"));
});
afterEach(() => {
  vi.restoreAllMocks();
  store.db.close();
});
describe("real SQLite replica", () => {
  it("background-caches the inclusive recent window and expires only unopened older bodies", () => {
    const now = Date.UTC(2026, 10, 20);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const dated = (id: string, days: number) => {
      const value = new Date(now - days * 86400000).toISOString();
      return row(id, {
        receivedAt: value,
        sortReceivedAt: value.replace(/(\.\d{3})Z$/, "$1000Z"),
        bodyAvailable: true,
        textBody: `Body ${id}`,
      });
    };
    const recent = dated("recent", 1),
      boundary = dated("boundary", RECENT_BODY_DAYS),
      old = dated("old", RECENT_BODY_DAYS + 1);
    expect(boundary.sortReceivedAt).toBe(recentBodyCutoff(now));
    seed([recent, boundary, old]);
    expect(new Set(store.recentBodies())).toEqual(new Set(["recent", "boundary"]));
    store.bodies([recent, boundary], false);
    expect(store.recentBodies()).toEqual([]);
    expect(store.detail("old")?.hasBody).toBe(false);
    store.opened(["recent"]);
    store.bodies([old], true);
    vi.mocked(Date.now).mockReturnValue(now + (RECENT_BODY_DAYS + 1) * 86400000);
    store.recentBodies();
    expect(store.detail("boundary")?.hasBody).toBe(false);
    expect(store.detail("recent")?.hasBody).toBe(true);
    expect(store.detail("old")?.hasBody).toBe(true);
    expect(store.count()).toBe(3);
  });
  it("stops retrying missing, oversized and superseded background bodies until their version changes", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 20));
    seed([row("a"), row("b"), row("c")]);
    store.bodies([], false, ["a"]);
    store.bodies([row("b", { bodyAvailable: false })], false);
    store.bodies(
      [row("c", { bodyVersion: "stale", bodyAvailable: true, textBody: "Stale" })],
      false,
    );
    expect(store.recentBodies()).toEqual([]);
    expect(store.detail("c")?.hasBody).toBe(false);
    expect(store.db.selectValue("select body_version from messages where id='c'")).toBe("v1");
    store.delta(delta([row("a", { bodyVersion: "v2" })]));
    expect(store.recentBodies()).toEqual(["a"]);
  });
  it("measures physical row and body pages including indexes and free pages", () => {
    seed([row("a")]);
    const empty = store.storageStats();
    store.bodies([row("a", { bodyAvailable: true, textBody: "x".repeat(16384) })]);
    const full = store.storageStats();
    expect(full.bodyCount).toBe(1);
    expect(full.bodyPayloadBytes).toBe(16384);
    expect(full.bodyAllocatedBytes).toBeGreaterThan(empty.bodyAllocatedBytes);
    expect(full.databaseBytes).toBe(
      full.rowAllocatedBytes + full.bodyAllocatedBytes + full.freeBytes,
    );
  });
  it("does not evict recent background bodies to meet the older-body cache budget", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 20));
    const rows = Array.from({ length: 129 }, (_, index) =>
      row(String(index), { bodyAvailable: true, textBody: "x".repeat(MAX_BODY_BYTES) }),
    );
    seed(rows);
    store.bodies(rows, false);
    expect(store.db.selectValue("select count(*) from bodies")).toBe(129);
    expect(store.storageStats().bodyPayloadBytes).toBeGreaterThan(MAX_BODY_CACHE_BYTES);
  });
  it("uses ordered early limits and one covering aggregate query for every view", () => {
    seed([
      row("a"),
      row("b", { direction: "outbound" }),
      row("c", { tier: 2, classified: true }),
      row("d", { tier: 3, classified: true }),
      row("e", { deleted: true }),
    ]);
    for (const view of ["l1", "l2", "l3", "unclassified", "all", "sent", "trash"]) {
      for (const accountId of [undefined, "owner"]) {
        const { profile } = store.profileList({ view, accountId });
        expect(profile.statements).toHaveLength(2);
        const plans = JSON.stringify(store.queryPlans({ view, accountId }));
        expect(plans).toContain("USING INDEX messages_order");
        expect(plans).toContain("COVERING INDEX messages_thread");
        expect(plans).not.toContain("TEMP B-TREE");
      }
    }
    expect(
      store.profileList({ view: "all", accountId: "missing" }).profile.statements,
    ).toHaveLength(1);
  });
  it("keeps compact headers lossless across reopen and scopes representatives before pagination", () => {
    const first = row("a", {
      reasoning: "Keep offline reasons",
      aiSummary: "Keep offline summaries",
      attachments: [
        {
          id: "attachment",
          filename: "a.txt",
          contentType: "text/plain",
          size: 5,
          inline: false,
          contentId: null,
        },
      ],
    });
    seed([
      first,
      row("z", {
        threadId: "a",
        account: { ...first.account, id: "other" },
        receivedAt: "2026-10-01T00:00:00.000Z",
        sortReceivedAt: "2026-10-01T00:00:00.000000Z",
        from: [{ name: "New name", address: "SENDER@test" }],
        read: true,
      }),
      row("b"),
    ]);
    const detail = store.detail("a")?.message;
    expect(detail).toMatchObject(first);
    expect(store.db.selectValue("select count(*) from accounts")).toBe(2);
    expect(String(store.db.selectValue("select data from messages where id='a'"))).not.toContain(
      '"subject":',
    );
    store = new ReplicaStore(store.db);
    expect(store.detail("a")?.message).toEqual(detail);
    const page = store.list({ view: "all", accountId: "owner", limit: 1 });
    expect(page.messages[0]?.id).toBe("b");
    const next = store.list({
      view: "all",
      accountId: "owner",
      limit: 1,
      cursor: page.nextCursor ?? undefined,
    });
    expect(next.messages[0]).toMatchObject({
      id: "a",
      messageCount: 2,
      unreadCount: 1,
      participants: [{ name: "New name", address: "SENDER@test" }],
    });
    expect(next.messages[0]).not.toHaveProperty("textBody");
    expect(next.messages[0]).not.toHaveProperty("to");
    expect(store.storageStats().freeBytes).toBe(0);
  });
  it("stores binary body payloads without charging compressed bytes to the policy budget", () => {
    seed([row("a")]);
    const packed = new Uint8Array([1, 2, 3]);
    store.bodies(
      [row("a", { bodyAvailable: true, textBody: "Raw content" })],
      false,
      ["a"],
      new Map([["a", packed]]),
    );
    expect(store.detail("a")).toMatchObject({ hasBody: true, packedBody: packed });
    expect(store.storageStats().bodyPayloadBytes).toBe(11);
    expect(store.db.selectValue("select typeof(data) from bodies")).toBe("blob");
    expect(store.storageDetails()).toHaveProperty("bodyStorage");
  });
  it("recovers unfinished optimistic writes and invalidates incompatible schemas", () => {
    seed([row("a")]);
    store.begin("pending", { id: "a", action: "archive" });
    expect(store.list({ view: "l1" }).messages).toEqual([]);
    store = new ReplicaStore(store.db);
    expect(store.list({ view: "l1" }).messages[0]?.id).toBe("a");
    store.db.exec("pragma user_version=99");
    store = new ReplicaStore(store.db);
    expect(store.cursor()).toBeUndefined();
    expect(store.count()).toBe(0);
  });
  it("evicts old bodies at the total cache limit", () => {
    const rows = Array.from({ length: 129 }, (_, index) =>
      row(String(index), {
        receivedAt: "2000-01-01T00:00:00.000Z",
        sortReceivedAt: "2000-01-01T00:00:00.000000Z",
        bodyAvailable: true,
        textBody: "x".repeat(MAX_BODY_BYTES),
      }),
    );
    seed(rows);
    store.bodies(rows);
    expect(Number(store.db.selectValue("select sum(bytes) from bodies"))).toBeLessThanOrEqual(
      MAX_BODY_CACHE_BYTES,
    );
    expect(store.db.selectValue("select count(*) from bodies")).toBe(128);
  });
  it("groups every view, sorts and pages by stable identities, aggregates outside the view", () => {
    seed([
      row("a"),
      row("b", { threadId: "a", tier: 2, classified: true, read: true }),
      row("c", { tier: 3, classified: true }),
      row("d", { archived: true }),
      row("e", { deleted: true }),
      row("f", { direction: "outbound" }),
      row("g", {
        account: { id: "other", provider: "gmail", email: "other@test", displayName: "Other" },
      }),
    ]);
    expect(store.list({ view: "l1", accountId: "owner" }).messages.map((x) => x.id)).toEqual(["a"]);
    expect(store.list({ view: "l2" }).messages[0]).toMatchObject({
      id: "b",
      messageCount: 2,
      unreadCount: 1,
      read: false,
    });
    expect(store.list({ view: "l3" }).messages.map((x) => x.id)).toEqual(["c"]);
    expect(store.list({ view: "trash" }).messages.map((x) => x.id)).toEqual(["e"]);
    expect(store.list({ view: "sent" }).messages.map((x) => x.id)).toEqual(["f"]);
    const all = store.list({ view: "all", limit: 2 }),
      next = store.list({ view: "all", limit: 2, cursor: all.nextCursor ?? undefined });
    expect(all.messages.map((x) => x.id)).toEqual(["g", "f"]);
    expect(next.messages.map((x) => x.id)).toEqual(["d", "c"]);
    expect(() => store.list({ view: "all", cursor: "foreign" })).toThrow("restart");
  });
  it("keeps live rows while staging, then applies deletions and immutable cursor atomically", () => {
    seed([row("old")]);
    store.resetStage();
    store.stage([row("new")]);
    expect(store.count()).toBe(1);
    expect(store.detail("old")).toBeDefined();
    store.delta(delta([row("new", { read: true })]), true);
    store.commitStage("snapshot");
    expect(store.detail("old")).toBeUndefined();
    expect(store.detail("new")?.message.read).toBe(true);
    expect(store.cursor()).toBe("snapshot");
    store.delta(delta([], ["new"]));
    expect(store.count()).toBe(0);
    expect(store.list({ view: "all" }).messages).toEqual([]);
    expect(store.cursor()).toBe("next");
  });
  it("archives and rolls back or undoes even after reconciliation erased the journal", () => {
    const a = row("a");
    seed([a, row("b", { threadId: "a", tier: 2, classified: true })]);
    store.begin("archive", { threadId: "a", view: "l1", action: "archive" });
    expect(store.list({ view: "l1" }).messages).toEqual([]);
    expect(store.list({ view: "l2" }).messages[0]?.id).toBe("b");
    store.settle("archive", false);
    expect(store.list({ view: "l1" }).messages[0]?.id).toBe("a");
    store.begin("again", { id: "a", action: "archive" });
    store.settle("again", true);
    store.delta(delta([row("a", { archived: true })]));
    store.settle("again", false, { patches: [a] });
    expect(store.list({ view: "l1" }).messages[0]?.id).toBe("a");
  });
  it("replays overlapping field operations without clobbering later intent", () => {
    seed([row("a")]);
    store.begin("first", { id: "a", action: "mark_read" });
    store.begin("second", { id: "a", action: "mark_unread" });
    store.begin("flag", { id: "a", action: "flag" });
    store.settle("first", false);
    store.settle("flag", true);
    expect(store.detail("a")?.message).toMatchObject({ read: false, flagged: true });
    store.settle("second", false);
    expect(store.detail("a")?.message).toMatchObject({ read: false, flagged: true });
    store.begin("read", { id: "a", action: "mark_read" });
    store.settle("read", true);
    store.begin("bad", { id: "a", action: "mark_unread" });
    store.settle("bad", false);
    expect(store.detail("a")?.message.read).toBe(true);
  });
  it("lazily caches bounded versioned bodies and invalidates stale content", () => {
    seed([row("a")]);
    expect(store.detail("a")?.hasBody).toBe(false);
    store.bodies([row("a", { bodyAvailable: true, textBody: "Cached" })]);
    expect(store.detail("a")?.message.textBody).toBe("Cached");
    store.delta(delta([row("a", { read: true })]));
    expect(store.detail("a")?.message).toMatchObject({ textBody: "Cached", read: true });
    store.delta(delta([row("a", { bodyVersion: "v2" })]));
    expect(store.detail("a")?.hasBody).toBe(false);
    store.bodies([
      row("a", {
        bodyVersion: "v2",
        bodyAvailable: true,
        textBody: "x".repeat(MAX_BODY_BYTES + 1),
      }),
    ]);
    expect(store.detail("a")?.hasBody).toBe(false);
    store.bodies([row("a", { bodyVersion: "v2", bodyAvailable: true, textBody: "Small" })]);
    store.delta(delta([], ["a"]));
    expect(store.detail("a")).toBeUndefined();
    expect(store.db.selectValue("select count(*) from bodies")).toBe(0);
  });
  it("rolls back a failed transaction rather than publishing a partial delta", () => {
    seed([row("a")]);
    expect(() =>
      store.delta(
        delta([row("b"), row("broken", { account: null as unknown as ReplicaRow["account"] })]),
      ),
    ).toThrow();
    expect(store.count()).toBe(1);
    expect(store.cursor()).toBe("initial");
  });
});
