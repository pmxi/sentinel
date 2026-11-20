import type { ConversationSummary, MailAddress } from "@sent/shared";
import type { Database, SqlValue } from "@sqlite.org/sqlite-wasm";
import type { CacheResponse } from "./api";
import { recentBodyCutoff } from "./replica-policy";
import {
  MAX_BODY_BYTES,
  MAX_BODY_CACHE_BYTES,
  type ReplicaChange,
  type ReplicaDelta,
  type ReplicaDetail,
  type ReplicaList,
  type ReplicaRow,
} from "./replica-types";

const columns =
  "id text primary key, thread_id text not null, account_id text not null, received_at text not null, read integer not null, archived integer not null, deleted integer not null, classified integer not null, tier integer, direction text not null, body_version text not null, data text not null";
function condition(view: string) {
  const live = `deleted=${view === "trash" ? 1 : 0}`;
  if (view === "sent") return `${live} and direction='outbound'`;
  if (["l1", "l2", "l3", "unclassified"].includes(view)) {
    const tier =
      view === "unclassified"
        ? "classified=0"
        : view === "l1"
          ? "(tier=1 or classified=0)"
          : `tier=${Number(view.slice(1))}`;
    return `${live} and archived=0 and direction='inbound' and ${tier}`;
  }
  return live;
}
export class ReplicaStore {
  constructor(readonly db: Database) {
    if (Number(db.selectValue("pragma user_version")) !== 2) {
      this.run(
        "drop table if exists messages; drop table if exists staging; drop table if exists bodies; drop table if exists meta; drop table if exists base; drop table if exists operations;",
      );
    }
    this.run(`create table if not exists messages(${columns}); create table if not exists staging(${columns});
      create index if not exists messages_thread on messages(thread_id,deleted,received_at);
      create index if not exists messages_order on messages(received_at desc,id desc);
      create index if not exists messages_mailbox on messages(deleted,direction,archived,tier,classified,account_id,thread_id,received_at desc,id desc);
      create table if not exists bodies(id text primary key, version text not null, data text not null, bytes integer not null, touched integer not null, opened integer not null, received_at text not null);
      create index if not exists bodies_age on bodies(received_at,opened,bytes,id,touched);
      create table if not exists meta(key text primary key,value text not null);
      create table if not exists base(id text primary key,data text not null);
      create table if not exists operations(seq integer primary key autoincrement,token text not null,id text not null,patch text not null,status text not null);
      pragma user_version=2;`);
    this.transaction(() => {
      this.run("update operations set status='failed' where status='pending'");
      for (const { id } of this.rows<{ id: string }>("select id from base")) this.recompute(id);
    });
  }
  private run(sql: string, bind: SqlValue[] = []) {
    this.db.exec({ sql, bind });
  }
  private rows<T>(sql: string, bind: SqlValue[] = []): T[] {
    return this.db.exec({ sql, bind, rowMode: "object", returnValue: "resultRows" }) as T[];
  }
  private transaction<T>(operation: () => T): T {
    this.run("begin immediate");
    try {
      const value = operation();
      this.run("commit");
      return value;
    } catch (error) {
      this.run("rollback");
      throw error;
    }
  }
  private put(row: ReplicaRow, table = "messages") {
    const data = { ...row, textBody: "", htmlBody: null, plainText: null, bodyAvailable: false };
    this.run(`insert or replace into ${table} values(?,?,?,?,?,?,?,?,?,?,?,?)`, [
      row.id,
      row.threadId,
      row.account.id,
      row.sortReceivedAt,
      Number(row.read),
      Number(Boolean(row.archived)),
      Number(Boolean(row.deleted)),
      Number(Boolean(row.classified)),
      row.tier,
      row.direction,
      row.bodyVersion,
      JSON.stringify(data),
    ]);
  }
  cursor() {
    return this.db.selectValue("select value from meta where key='cursor'") as string | undefined;
  }
  resetStage() {
    this.run("delete from staging");
  }
  stage(rows: ReplicaRow[]) {
    this.transaction(() => {
      for (const row of rows) this.put(row, "staging");
    });
  }
  commitStage(cursor: string) {
    this.transaction(() => {
      this.run(
        "delete from messages; insert into messages select * from staging; delete from staging; delete from base; delete from operations;",
      );
      this.setCursor(cursor);
      this.pruneBodies();
    });
  }
  private setCursor(cursor: string) {
    this.run("insert or replace into meta values('cursor',?)", [cursor]);
  }
  delta(delta: ReplicaDelta, staging = false) {
    const table = staging ? "staging" : "messages";
    this.transaction(() => {
      for (const id of delta.deletions) {
        this.run(`delete from ${table} where id=?`, [id]);
        if (!staging) this.run("delete from bodies where id=?", [id]);
      }
      for (const row of delta.upserts) this.put(row, table);
      if (!staging) {
        this.run("delete from base; delete from operations;");
        this.setCursor(delta.cursor);
        this.pruneBodies();
      }
    });
  }
  private pruneBodies() {
    this.run(
      "delete from bodies where not exists(select 1 from messages m where m.id=bodies.id and m.body_version=bodies.version)",
    );
    this.run(
      "delete from meta where key like 'bodySkipped:%' and not exists(select 1 from messages m where meta.key='bodySkipped:'||m.id and meta.value=m.body_version)",
    );
    this.run(
      "delete from meta where key like 'bodyOpened:%' and not exists(select 1 from messages m where meta.key='bodyOpened:'||m.id)",
    );
    this.trimBodies();
  }
  private trimBodies() {
    const cutoff = recentBodyCutoff();
    this.run("delete from bodies where opened=0 and received_at<?", [cutoff]);
    while (
      Number(
        this.db.selectValue("select coalesce(sum(bytes),0) from bodies where received_at<?", [
          cutoff,
        ]),
      ) > MAX_BODY_CACHE_BYTES
    )
      this.run(
        "delete from bodies where id=(select id from bodies where received_at<? order by touched,id limit 1)",
        [cutoff],
      );
  }
  recentBodies() {
    this.trimBodies();
    return this.rows<{ id: string }>(
      "select m.id from messages m left join bodies b on b.id=m.id and b.version=m.body_version left join meta s on s.key='bodySkipped:'||m.id and s.value=m.body_version where m.received_at>=? and b.id is null and s.key is null order by m.received_at desc,m.id desc limit 16",
      [recentBodyCutoff()],
    ).map((row) => row.id);
  }
  storageStats() {
    const allocated = this.rows<{ name: string; bytes: number }>(
      "select name,sum(pgsize) bytes from dbstat group by name",
    );
    const bodyNames = new Set([
      "bodies",
      ...this.rows<{ name: string }>(
        "select name from sqlite_schema where type='index' and tbl_name='bodies'",
      ).map((row) => row.name),
    ]);
    const bodyAllocatedBytes = allocated
      .filter((row) => bodyNames.has(row.name))
      .reduce((total, row) => total + Number(row.bytes), 0);
    const rowAllocatedBytes = allocated
      .filter((row) => !bodyNames.has(row.name))
      .reduce((total, row) => total + Number(row.bytes), 0);
    const pageSize = Number(this.db.selectValue("pragma page_size"));
    return {
      databaseBytes: Number(this.db.selectValue("pragma page_count")) * pageSize,
      rowAllocatedBytes,
      bodyAllocatedBytes,
      freeBytes: Number(this.db.selectValue("pragma freelist_count")) * pageSize,
      rows: this.count(),
      bodyCount: Number(this.db.selectValue("select count(*) from bodies")),
      bodyPayloadBytes: Number(this.db.selectValue("select coalesce(sum(bytes),0) from bodies")),
      recentBodyCount: Number(
        this.db.selectValue(
          "select count(*) from bodies b join messages m on m.id=b.id where m.received_at>=?",
          [recentBodyCutoff()],
        ),
      ),
      olderBodyCount: Number(
        this.db.selectValue(
          "select count(*) from bodies b join messages m on m.id=b.id where m.received_at<?",
          [recentBodyCutoff()],
        ),
      ),
    };
  }
  private headers(sql: string, bind: SqlValue[] = []): ReplicaRow[] {
    return this.rows<{ data: string }>(sql, bind).map((row) => JSON.parse(row.data));
  }
  private header(id: string) {
    return this.headers("select data from messages where id=?", [id])[0];
  }
  private members(id: string, trash: boolean) {
    return this.headers(
      "select data from messages where thread_id=? and deleted=? order by received_at desc,id desc",
      [id, Number(trash)],
    );
  }
  list(input: { view: string; accountId?: string; cursor?: string; limit?: number }): ReplicaList {
    let after: { receivedAt: string; id: string } | undefined;
    if (input.cursor) {
      if (!input.cursor.startsWith("local:")) throw new Error("Replica pagination must restart");
      after = JSON.parse(atob(input.cursor.slice(6)));
      if (typeof after?.receivedAt !== "string" || typeof after.id !== "string")
        throw new Error("Invalid local cursor");
    }
    const limit = Math.max(1, Math.min(100, input.limit ?? 75));
    const rows = this.headers(
      `with ranked as(select id,thread_id,received_at,row_number() over(partition by thread_id order by received_at desc,id desc) rank from messages indexed by messages_mailbox where ${condition(input.view)} and (? is null or account_id=?)),page as materialized(select id,received_at from ranked where rank=1 and (? is null or (received_at,id)<(?,?)) order by received_at desc,id desc limit ?) select m.data from page join messages m on m.id=page.id order by page.received_at desc,page.id desc`,
      [
        input.accountId ?? null,
        input.accountId ?? null,
        after?.receivedAt ?? null,
        after?.receivedAt ?? null,
        after?.id ?? null,
        limit + 1,
      ],
    );
    const more = rows.length > limit;
    rows.length = Math.min(rows.length, limit);
    const messages = rows.map((row) => {
      const members = this.members(row.threadId, input.view === "trash"),
        people = new Map<string, MailAddress>();
      for (const message of members)
        for (const person of message.from)
          if (!people.has(person.address.toLowerCase()))
            people.set(person.address.toLowerCase(), person);
      const unreadCount = members.filter((message) => !message.read).length;
      const result: ConversationSummary = {
        ...row,
        read: unreadCount === 0,
        messageCount: members.length,
        unreadCount,
        participants: [...people.values()].sort((a, b) =>
          a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
        ),
      };
      return result;
    });
    const last = rows.at(-1);
    return {
      messages,
      nextCursor:
        more && last
          ? `local:${btoa(JSON.stringify({ receivedAt: last.sortReceivedAt, id: last.id }))}`
          : null,
    };
  }
  detail(id: string, opened = false): ReplicaDetail | undefined {
    if (opened) this.opened([id]);
    const row = this.header(id);
    if (!row) return;
    const body = this.rows<{ data: string }>("select data from bodies where id=? and version=?", [
      id,
      row.bodyVersion,
    ])[0];
    if (body)
      this.run(
        "update bodies set touched=?,opened=max(opened,?) where id=? and (touched<? or opened<?)",
        [Date.now(), Number(opened), id, Date.now() - 60_000, Number(opened)],
      );
    return { message: { ...row, ...(body ? JSON.parse(body.data) : {}) }, hasBody: Boolean(body) };
  }
  thread(id: string, trash: boolean, opened = false) {
    const members = this.members(id, trash);
    if (opened) this.opened(members.map((row) => row.id));
    return members.reverse().map((row) => this.detail(row.id) as ReplicaDetail);
  }
  opened(ids: string[]) {
    this.transaction(() => {
      for (const id of ids) {
        this.run(
          "insert or ignore into meta select 'bodyOpened:'||id,'1' from messages where id=?",
          [id],
        );
        this.run("update bodies set opened=1,touched=? where id=? and(opened=0 or touched<?)", [
          Date.now(),
          id,
          Date.now() - 60000,
        ]);
      }
    });
  }
  bodies(rows: ReplicaRow[], opened = true, requested = rows.map((row) => row.id)) {
    this.transaction(() => {
      const returned = new Set(rows.map((row) => row.id));
      for (const id of requested)
        if (!returned.has(id))
          this.run(
            "insert or replace into meta select 'bodySkipped:'||id,body_version from messages where id=?",
            [id],
          );
      for (const row of rows) {
        const existing = this.header(row.id);
        if (existing && existing.bodyVersion !== row.bodyVersion) {
          this.run("insert or replace into meta values(?,?)", [
            `bodySkipped:${row.id}`,
            existing.bodyVersion,
          ]);
          continue;
        }
        if (!row.bodyAvailable) {
          this.run("insert or replace into meta values(?,?)", [
            `bodySkipped:${row.id}`,
            row.bodyVersion,
          ]);
          continue;
        }
        const fields = { textBody: row.textBody, htmlBody: row.htmlBody, plainText: row.plainText };
        const bytes = new TextEncoder().encode(
          row.textBody + (row.htmlBody ?? "") + (row.plainText ?? ""),
        ).byteLength;
        if (bytes > MAX_BODY_BYTES) {
          this.run("insert or replace into meta values(?,?)", [
            `bodySkipped:${row.id}`,
            row.bodyVersion,
          ]);
          continue;
        }
        this.run("delete from meta where key=?", [`bodySkipped:${row.id}`]);
        this.run(
          "insert into bodies values(?,?,?,?,?,?,?) on conflict(id) do update set version=excluded.version,data=excluded.data,bytes=excluded.bytes,touched=excluded.touched,opened=max(bodies.opened,excluded.opened),received_at=excluded.received_at",
          [
            row.id,
            row.bodyVersion,
            JSON.stringify(fields),
            bytes,
            Date.now(),
            Number(
              opened ||
                Boolean(
                  this.db.selectValue("select value from meta where key=?", [
                    `bodyOpened:${row.id}`,
                  ]),
                ),
            ),
            row.sortReceivedAt,
          ],
        );
      }
      this.trimBodies();
    });
  }
  begin(token: string, change: ReplicaChange) {
    this.transaction(() => {
      const rows = change.id
        ? this.headers("select data from messages where id=?", [change.id])
        : this.headers(
            `select data from messages where thread_id=? and ${condition(change.view ?? "all")} and (? is null or account_id=?)`,
            [change.threadId ?? "", change.accountId ?? null, change.accountId ?? null],
          );
      for (const row of rows) {
        this.run("insert or ignore into base values(?,?)", [row.id, JSON.stringify(row)]);
        const patch: Record<string, unknown> = { ...change.patch, syncPending: true };
        if (["mark_read", "mark_unread"].includes(change.action ?? ""))
          patch.read = change.action === "mark_read";
        if (["flag", "unflag"].includes(change.action ?? ""))
          patch.flagged = change.action === "flag";
        if (change.action === "archive") patch.archived = true;
        if (change.action === "delete") patch.deleted = true;
        if ("tier" in change) {
          patch.tier = change.tier ?? row.modelTier;
          patch.classified = patch.tier !== null;
          patch.modelTier = row.modelTier;
          patch.reasoning = row.reasoning;
        }
        this.run("insert into operations(token,id,patch,status) values(?,?,?,'pending')", [
          token,
          row.id,
          JSON.stringify(patch),
        ]);
        this.recompute(row.id);
      }
    });
  }
  settle(token: string, success: boolean, response?: CacheResponse) {
    this.transaction(() => {
      const entries = this.rows<{ seq: number; id: string; patch: string }>(
        "select seq,id,patch from operations where token=?",
        [token],
      );
      if (!success && response?.patches)
        for (const patch of response.patches) {
          const base = this.rows<{ data: string }>("select data from base where id=?", [
            patch.id,
          ])[0];
          const row: ReplicaRow | undefined = base ? JSON.parse(base.data) : this.header(patch.id);
          if (!row) continue;
          const updated = { ...row, ...patch };
          if (base)
            this.run("update base set data=? where id=?", [JSON.stringify(updated), patch.id]);
          this.put(updated);
          this.recompute(patch.id);
        }
      for (const entry of entries) {
        const patch = JSON.parse(entry.patch),
          authoritative = response?.patches?.find((row) => row.id === entry.id);
        if (success && authoritative)
          for (const field of Object.keys(patch))
            if (field in authoritative)
              patch[field] = authoritative[field as keyof typeof authoritative];
        this.run("update operations set status=?,patch=? where seq=?", [
          success ? "success" : "failed",
          JSON.stringify(patch),
          entry.seq,
        ]);
        this.recompute(entry.id);
      }
    });
  }
  private recompute(id: string) {
    const base = this.rows<{ data: string }>("select data from base where id=?", [id])[0];
    if (!base) return;
    let row: ReplicaRow = JSON.parse(base.data);
    for (const operation of this.rows<{ patch: string }>(
      "select patch from operations where id=? and status!='failed' order by seq",
      [id],
    ))
      row = { ...row, ...JSON.parse(operation.patch) };
    this.put(row);
  }
  count() {
    return Number(this.db.selectValue("select count(*) from messages"));
  }
}
