import type { QueryClient, QueryKey } from "@tanstack/solid-query";
import { createSignal, type Signal } from "solid-js";
import type { CacheResponse, MessagePatch } from "./api";
import { replicaFor } from "./replica";
import type { ConversationSummary, MessageSummary, Tier } from "./shared";

type Mail = MessageSummary & Partial<Pick<MessagePatch, "archived" | "deleted" | "classified">>;
type Page = { messages: Mail[]; pageCount?: number };
type Patch = Pick<MessagePatch, "id" | "threadId"> & Partial<MessagePatch>;
type Change = {
  id?: string;
  threadId?: string;
  action?: string;
  tier?: Tier | null;
  view?: string;
  accountId?: string;
  patch?: Patch;
};
type Entry = { key: QueryKey; before: unknown; after: unknown };
type ReadOperation = { version: number; read: boolean; pending: boolean; failed: boolean };
type ReadHistory = { before: boolean; operations: ReadOperation[] };
const families = new Set(["messages", "message", "thread", "search"]);
function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}
const versions = new WeakMap<
  QueryClient,
  { next: number; fields: Map<string, Map<string, number>>; reads: Map<string, ReadHistory> }
>();
function versionState(client: QueryClient) {
  let value = versions.get(client);
  if (!value) {
    value = { next: 0, fields: new Map(), reads: new Map() };
    versions.set(client, value);
  }
  return value;
}
const states = new WeakMap<
  QueryClient,
  {
    timer?: ReturnType<typeof setTimeout>;
    until: number;
    prefetchUntil: number;
    pending: number;
    keys: Map<string, QueryKey>;
    clock: Signal<number>;
  }
>();
function state(client: QueryClient) {
  let value = states.get(client);
  if (!value) {
    value = { until: 0, prefetchUntil: 0, pending: 0, keys: new Map(), clock: createSignal(0) };
    states.set(client, value);
  }
  return value;
}
export const quietUntil = (client: QueryClient) => {
  const value = state(client);
  value.clock[0]();
  return value.pending ? Infinity : value.until;
};
export const prefetchQuietUntil = (client: QueryClient) => state(client).prefetchUntil;
function reconcile(client: QueryClient, keys: QueryKey[]) {
  const value = state(client);
  value.until = Date.now() + 1500;
  value.clock[1]((tick) => tick + 1);
  for (const key of keys) value.keys.set(JSON.stringify(key), key);
  clearTimeout(value.timer);
  value.timer = setTimeout(() => {
    if (value.pending) return;
    value.until = 0;
    value.clock[1]((tick) => tick + 1);
    const keys = [...value.keys.values()];
    value.keys.clear();
    for (const queryKey of keys)
      void client.invalidateQueries({
        queryKey,
        exact: true,
        refetchType: ["messages", "search"].includes(String(queryKey[0])) ? "active" : "none",
      });
  }, 1500);
}
export function inView(item: Mail, view = "all") {
  if (Boolean(item.deleted) !== (view === "trash")) return false;
  if (view === "sent") return item.direction === "outbound";
  if (["l1", "l2", "l3", "unclassified"].includes(view)) {
    if (item.archived || item.direction !== "inbound") return false;
    if (view === "unclassified")
      return item.classified === false || (item.classified === undefined && item.tier === null);
    return (
      item.tier === Number(view.slice(1)) ||
      (view === "l1" &&
        (item.classified === false || (item.classified === undefined && item.tier === null)))
    );
  }
  return true;
}
function entities(client: QueryClient) {
  const result = new Map<string, Mail>();
  for (const query of client.getQueryCache().getAll()) {
    const data = query.state.data as Mail | Page | undefined;
    if (!data || !["message", "thread"].includes(String(query.queryKey[0]))) continue;
    for (const item of "messages" in data ? data.messages : [data]) result.set(item.id, item);
  }
  return result;
}
function inverse(current: unknown, before: unknown, after: unknown, field?: string): unknown {
  if (Object.is(before, after)) return current;
  if (
    (field === "unreadCount" || field === "messageCount") &&
    typeof before === "number" &&
    typeof after === "number" &&
    typeof current === "number"
  )
    return Math.max(0, current + before - after);
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current)) {
    const rows = [...before, ...after];
    if (!rows.every((item) => item && typeof item.id === "string"))
      return equal(current, after) ? before : current;
    const identity = (item: Record<string, unknown>) =>
      typeof item.messageCount === "number" ? item.threadId : item.id;
    const result = current.flatMap((item) => {
      const old = before.find((row) => identity(row) === identity(item)),
        next = after.find((row) => identity(row) === identity(item));
      if (!old && next) return [];
      if (old && !next) return [old];
      return [old && next ? inverse(item, old, next) : item];
    });
    for (const [index, item] of before.entries())
      if (
        !after.some((row) => identity(row) === identity(item)) &&
        !result.some((row) => identity(row) === identity(item))
      )
        result.splice(Math.min(index, result.length), 0, item);
    return result;
  }
  if (
    before &&
    after &&
    current &&
    typeof before === "object" &&
    typeof after === "object" &&
    typeof current === "object"
  ) {
    const result = { ...current } as Record<string, unknown>;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const previous = (before as Record<string, unknown>)[key],
        next = (after as Record<string, unknown>)[key];
      const restored = inverse(result[key], previous, next, key);
      if (restored === undefined && !(key in before)) delete result[key];
      else result[key] = restored;
    }
    if (typeof result.unreadCount === "number") result.read = result.unreadCount === 0;
    return result;
  }
  return Object.is(current, after) ? before : current;
}
const newest = (items: Mail[]) =>
  [...items].sort(
    (a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id),
  )[0];
function summary(item: Mail): Mail {
  const keys = [
    "id",
    "threadId",
    "account",
    "subject",
    "from",
    "snippet",
    "receivedAt",
    "read",
    "flagged",
    "direction",
    "tier",
    "modelTier",
    "reasoning",
    "aiSummary",
    "attachmentCount",
    "syncPending",
    "archived",
    "deleted",
    "classified",
  ] as const;
  return Object.fromEntries(
    keys.filter((key) => key in item).map((key) => [key, item[key]]),
  ) as Mail;
}
function apply(client: QueryClient, change: Change): Entry[] {
  const known = entities(client);
  const threadId =
    change.threadId ??
    change.patch?.threadId ??
    (change.id ? known.get(change.id)?.threadId : undefined);
  const targetIds = new Set<string>();
  for (const item of known.values())
    if (
      change.id
        ? item.id === change.id
        : item.threadId === threadId &&
          (!change.accountId || item.account.id === change.accountId) &&
          inView(item, change.view)
    )
      targetIds.add(item.id);
  if (change.id) targetIds.add(change.id);
  for (const id of targetIds) {
    const item = known.get(id);
    if (item && !client.getQueryData(["message", id])) client.setQueryData(["message", id], item);
  }
  const update = (item: Mail): Mail => {
    if (!targetIds.has(item.id)) return item;
    const patch: Partial<Mail> = change.patch ? { ...change.patch } : {};
    if (change.action === "mark_read" || change.action === "mark_unread")
      patch.read = change.action === "mark_read";
    if (change.action === "flag" || change.action === "unflag")
      patch.flagged = change.action === "flag";
    if (change.action === "archive") patch.archived = true;
    if (change.action === "delete") patch.deleted = true;
    if ("tier" in change) {
      patch.tier = change.tier ?? item.modelTier;
      patch.classified = patch.tier !== null;
    }
    return { ...item, ...patch };
  };
  const updated = new Map([...known].map(([id, item]) => [id, update(item)]));
  const changedThreads = new Set(
    [...targetIds].map((id) => updated.get(id)?.threadId).filter((id): id is string => Boolean(id)),
  );
  if (threadId) changedThreads.add(threadId);
  const sources = client
    .getQueriesData<{ messages: ConversationSummary[] }>({ queryKey: ["messages"] })
    .flatMap(([, page]) => page?.messages ?? []);
  const entries: Entry[] = [];
  for (const query of client.getQueryCache().getAll()) {
    const key = query.queryKey,
      family = String(key[0]);
    if (!families.has(family)) continue;
    const before = query.state.data as Mail | Page | undefined;
    if (!before) {
      if (
        (family === "message" && targetIds.has(String(key[1]))) ||
        (family === "thread" && changedThreads.has(String(key[1])))
      )
        void client.cancelQueries({ queryKey: key, exact: true });
      continue;
    }
    let after: Mail | Page = before;
    if (family === "message" && !("messages" in before) && targetIds.has(before.id))
      after = update(before);
    if (family === "thread" && "messages" in before && changedThreads.has(String(key[1]))) {
      const messages = before.messages
        .map(update)
        .filter((item) => Boolean(item.deleted) === Boolean(key[2]));
      for (const item of updated.values())
        if (
          targetIds.has(item.id) &&
          item.threadId === key[1] &&
          Boolean(item.deleted) === Boolean(key[2]) &&
          !messages.some((member) => member.id === item.id)
        )
          messages.push(item);
      after = {
        ...before,
        messages: messages.sort(
          (a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id),
        ),
      };
    }
    if ((family === "messages" || family === "search") && "messages" in before) {
      let messages = before.messages as ConversationSummary[];
      for (const id of changedThreads) {
        const existing = messages.find((row) => row.threadId === id);
        if (
          family === "messages" &&
          key[2] &&
          (existing?.account.id ??
            [...updated.values()].find((item) => item.threadId === id)?.account.id) !== key[2]
        )
          continue;
        const oldMembers = [...known.values()].filter((item) => item.threadId === id);
        const nextMembers = [...updated.values()].filter((item) => item.threadId === id);
        const view = family === "messages" ? String(key[1]) : "all";
        const representative =
          family === "search"
            ? existing && update(existing)
            : newest(nextMembers.filter((item) => inView(item, view)));
        const candidate =
          representative && Boolean(representative.deleted) === (view === "trash")
            ? representative
            : undefined;
        const source = existing ?? sources.find((row) => row.threadId === id);
        if (!source || (!existing && family === "search")) continue;
        const hasAffected =
          oldMembers.some((item) => targetIds.has(item.id)) ||
          (existing && targetIds.has(existing.id));
        if (!hasAffected) continue;
        const trash = view === "trash";
        const counted = (item: Mail) => Boolean(item.deleted) === trash;
        const deltaCount = nextMembers.filter(counted).length - oldMembers.filter(counted).length;
        const deltaUnread =
          nextMembers.filter((item) => counted(item) && !item.read).length -
          oldMembers.filter((item) => counted(item) && !item.read).length;
        const baseCount = existing?.messageCount ?? (trash ? 0 : source.messageCount);
        const baseUnread = existing?.unreadCount ?? (trash ? 0 : source.unreadCount);
        const count = Math.max(0, baseCount + deltaCount),
          unread = Math.max(0, baseUnread + deltaUnread);
        const replacement =
          candidate && count
            ? {
                ...source,
                ...summary(candidate),
                messageCount: count,
                unreadCount: unread,
                read: unread === 0,
              }
            : undefined;
        if (replacement && deltaCount && nextMembers.filter(counted).length === count) {
          const people = new Map<string, MessageSummary["from"][number]>();
          for (const member of [...nextMembers.filter(counted)].sort(
            (a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id),
          ))
            for (const person of member.from)
              if (!people.has(person.address.toLowerCase()))
                people.set(person.address.toLowerCase(), person);
          replacement.participants = [...people]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, person]) => person);
        }
        messages = messages.filter((row) => row.threadId !== id);
        if (replacement) messages.push(replacement);
      }
      after = {
        ...before,
        messages:
          family === "search"
            ? before.messages.flatMap((row) =>
                messages.filter((item) => item.threadId === row.threadId),
              )
            : messages
                .sort(
                  (a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id),
                )
                .slice(0, 75 * (before.pageCount ?? 1)),
      };
    }
    if (equal(before, after)) continue;
    void client.cancelQueries({ queryKey: key, exact: true });
    client.setQueryData(key, after);
    entries.push({ key, before, after });
  }
  return entries;
}
export function serverPatches(client: QueryClient, response?: CacheResponse, version = Infinity) {
  const fields = versionState(client).fields;
  const entries = (response?.patches ?? []).flatMap((patch) =>
    apply(client, {
      id: patch.id,
      patch: Object.fromEntries(
        Object.entries(patch).filter(([key]) => (fields.get(patch.id)?.get(key) ?? 0) <= version),
      ) as Patch,
    }),
  );
  return entries.map((entry) => entry.key);
}
export function optimistic(client: QueryClient, change: Change) {
  const local = replicaFor(client)?.begin(change);
  const value = state(client);
  value.pending++;
  const revisions = versionState(client),
    version = ++revisions.next;
  let readHistory: ReadHistory | undefined, readOperation: ReadOperation | undefined;
  if (change.id && ["mark_read", "mark_unread"].includes(change.action ?? "")) {
    const item = entities(client).get(change.id);
    if (item) {
      readHistory = revisions.reads.get(item.id);
      if (!readHistory?.operations.some((operation) => operation.pending)) {
        readHistory = { before: item.read, operations: [] };
        revisions.reads.set(item.id, readHistory);
      }
      readOperation = {
        version,
        read: change.action === "mark_read",
        pending: true,
        failed: false,
      };
      readHistory.operations.push(readOperation);
    }
  }
  const fields =
    "tier" in change
      ? ["tier", "modelTier", "reasoning", "classified"]
      : change.action === "archive"
        ? ["archived"]
        : change.action === "delete"
          ? ["deleted"]
          : change.action === "flag" || change.action === "unflag"
            ? ["flagged"]
            : ["read"];
  for (const item of entities(client).values()) {
    if (
      change.id
        ? item.id !== change.id
        : item.threadId !== change.threadId ||
          (change.accountId && item.account.id !== change.accountId) ||
          !inView(item, change.view)
    )
      continue;
    const owned = revisions.fields.get(item.id) ?? new Map<string, number>();
    for (const field of fields) owned.set(field, version);
    revisions.fields.set(item.id, owned);
  }
  value.until = Date.now() + 1500;
  value.clock[1]((tick) => tick + 1);
  if (change.action === "archive" || change.action === "delete")
    value.prefetchUntil = Date.now() + 1500;
  const entries = apply(client, change);
  let settled = false;
  const finish = (keys: QueryKey[] = []) => {
    if (!settled) {
      settled = true;
      value.pending--;
    }
    reconcile(client, [...entries.map((entry) => entry.key), ...keys]);
  };
  return {
    commit(response?: CacheResponse) {
      local?.commit(response);
      if (readOperation) readOperation.pending = false;
      finish(serverPatches(client, response, version));
    },
    rollback(response?: CacheResponse) {
      local?.rollback(response);
      if (change.id && readHistory && readOperation) {
        readOperation.pending = false;
        readOperation.failed = true;
        const latest = readHistory.operations.findLast((operation) => !operation.failed);
        revisions.fields.get(change.id)?.set("read", latest?.version ?? 0);
        const item = entities(client).get(change.id);
        const keys = item
          ? apply(client, {
              id: item.id,
              patch: {
                id: item.id,
                threadId: item.threadId,
                read: latest?.read ?? readHistory.before,
              },
            }).map((entry) => entry.key)
          : [];
        finish([...keys, ...serverPatches(client, response, version)]);
        return;
      }
      for (const entry of entries)
        client.setQueryData(entry.key, (current: unknown) =>
          inverse(current, entry.before, entry.after),
        );
      finish(serverPatches(client, response, version));
    },
  };
}
