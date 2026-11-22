import type { Database, SqlValue } from "@sqlite.org/sqlite-wasm";
import type { CacheResponse } from "./api";
import { unpackDetail } from "./replica-body";
import { recentBodyCutoff } from "./replica-policy";
import { ftsQuery } from "./replica-search";
import {
  MAX_BODY_BYTES,
  MAX_BODY_CACHE_BYTES,
  type ReplicaChange,
  type ReplicaDelta,
  type ReplicaDetail,
  type ReplicaList,
  type ReplicaRow,
} from "./replica-types";
import type { ConversationSummary, MailAddress, SearchResponse, SearchSort } from "./shared";

const columns =
  "id text primary key, thread_id text not null, account_id text not null, received_at text not null, read integer not null, archived integer not null, deleted integer not null, classified integer not null, tier integer, direction text not null, body_version text not null, from_json text not null, data text not null";
const fields = [
  "subject",
  "snippet",
  "flagged",
  "modelTier",
  "reasoning",
  "aiSummary",
  "attachmentCount",
  "syncPending",
  "to",
  "cc",
  "bcc",
  "sentAt",
  "attachments",
  "internetMessageId",
] as const;
function searchableBody(body: Pick<ReplicaRow, "textBody" | "plainText">) {
  return (
    body.textBody +
    (body.plainText && body.plainText !== body.textBody ? `\n${body.plainText}` : "")
  );
}
type StoredRow = {
  id: string;
  thread_id: string;
  account_id: string;
  received_at: string;
  read: number;
  archived: number;
  deleted: number;
  classified: number;
  tier: ReplicaRow["tier"];
  direction: ReplicaRow["direction"];
  body_version: string;
  from_json: string;
  data: string;
};
function condition(view: string, alias = "") {
  const col = (name: string) => `${alias}${name}`;
  const live = `${col("deleted")}=${view === "trash" ? 1 : 0}`;
  if (view === "sent") return `${live} and ${col("direction")}='outbound'`;
  if (view === "inbox") return `${live} and ${col("archived")}=0 and ${col("direction")}='inbound'`;
  if (["l1", "l2", "l3", "unclassified"].includes(view)) {
    const tier =
      view === "unclassified"
        ? `${col("classified")}=0`
        : view === "l1"
          ? `(${col("tier")}=1 or ${col("classified")}=0)`
          : `${col("tier")}=${Number(view.slice(1))}`;
    return `${live} and ${col("archived")}=0 and ${col("direction")}='inbound' and ${tier}`;
  }
  return live;
}
export class ReplicaStore {
  private accounts = new Map<string, ReplicaRow["account"]>();
  private pendingSearch = new Set<string>();
  private warmedSearch = false;
  private searchReadyWarmed = false;
  private searchWarmMs = 0;
  constructor(readonly db: Database) {
    db.createFunction("sent_nfkc", (_context, value) => String(value ?? "").normalize("NFKC"));
    this.run("pragma temp_store=memory; pragma cache_size=-65536");
    if (Number(db.selectValue("pragma user_version")) !== 6) {
      this.run(
        "drop table if exists messages; drop table if exists staging; drop table if exists bodies; drop table if exists meta; drop table if exists base; drop table if exists operations; drop table if exists accounts; drop table if exists search_headers; drop table if exists search_bodies; drop table if exists search_documents; drop table if exists search_documents_content;",
      );
    }
    this.run(`create table if not exists messages(${columns}); create table if not exists staging(${columns});
      create index if not exists messages_thread on messages(thread_id,deleted,received_at desc,id desc,read,from_json);
      create index if not exists messages_order on messages(received_at desc,id desc,deleted,direction,archived,tier,classified,account_id,thread_id);
      create table if not exists accounts(id text primary key,data text not null);
      create table if not exists bodies(id text primary key, version text not null, data text not null, bytes integer not null, touched integer not null, opened integer not null, received_at text not null);
      create index if not exists bodies_age on bodies(received_at,opened,bytes,id,touched);
      create table if not exists meta(key text primary key,value text not null);
      create table if not exists base(id text primary key,data text not null);
      create table if not exists operations(seq integer primary key autoincrement,token text not null,id text not null,patch text not null,status text not null);
      create virtual table if not exists search_documents using fts5(subject,sender,recipients,snippet,body,message_id unindexed,thread_id unindexed,received_at unindexed,content='',contentless_delete=1,contentless_unindexed=1,tokenize='unicode61 remove_diacritics 2');
      create trigger if not exists search_message_delete after delete on messages begin
        delete from search_documents where rowid=old.rowid;
      end;
      create trigger if not exists search_body_delete after delete on bodies begin
        delete from search_documents where rowid=(select rowid from messages where id=old.id);
        insert into search_documents(rowid,subject,sender,recipients,snippet,body,message_id,thread_id,received_at)
          select m.rowid,sent_nfkc(json_extract(m.data,'$[0]')),
            sent_nfkc((select group_concat(coalesce(value->>'name','')||' '||(value->>'address'),' ') from json_each(m.from_json))),
            sent_nfkc((select group_concat(coalesce(value->>'name','')||' '||(value->>'address'),' ') from (
              select value from json_each(m.data,'$[8]') union all select value from json_each(m.data,'$[9]') union all select value from json_each(m.data,'$[10]')))),
            sent_nfkc(json_extract(m.data,'$[1]')),'',m.id,m.thread_id,m.received_at from messages m where m.id=old.id and m.deleted=0;
      end;
      pragma user_version=6;`);
    for (const row of this.rows<{ id: string; data: string }>("select id,data from accounts"))
      this.accounts.set(row.id, JSON.parse(row.data));
    this.transaction(() => {
      this.run("update operations set status='failed' where status='pending'");
      for (const { id } of this.rows<{ id: string }>("select id from base")) this.recompute(id);
    });
    this.warmSearchCache();
  }
  private warmSearchCache(force = false) {
    if ((!force && this.warmedSearch) || !this.count()) return;
    const start = performance.now();
    this.run(`select sum(length(hex(block))) from search_documents_data;
      select sum(length(sz)) from search_documents_docsize;
      select sum(length(c5)+length(c6)+length(c7)) from search_documents_content;
      select count(*) from search_documents_idx;`);
    this.searchWarmMs += performance.now() - start;
    this.warmedSearch = true;
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
      this.accounts.clear();
      for (const row of this.rows<{ id: string; data: string }>("select id,data from accounts"))
        this.accounts.set(row.id, JSON.parse(row.data));
      throw error;
    }
  }
  private put(row: ReplicaRow, table = "messages") {
    if (JSON.stringify(this.accounts.get(row.account.id)) !== JSON.stringify(row.account)) {
      this.run("insert or replace into accounts values(?,?)", [
        row.account.id,
        JSON.stringify(row.account),
      ]);
      this.accounts.set(row.account.id, row.account);
    }
    this.run(
      `insert into ${table} values(?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set thread_id=excluded.thread_id,account_id=excluded.account_id,received_at=excluded.received_at,read=excluded.read,archived=excluded.archived,deleted=excluded.deleted,classified=excluded.classified,tier=excluded.tier,direction=excluded.direction,body_version=excluded.body_version,from_json=excluded.from_json,data=excluded.data`,
      [
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
        JSON.stringify(row.from),
        JSON.stringify(fields.map((field) => row[field])),
      ],
    );
    if (table === "messages") this.indexHeader(row);
  }
  private indexHeader(row: ReplicaRow, bodyText?: string) {
    const id = this.db.selectValue("select rowid from messages where id=?", [row.id]) as number;
    this.run("delete from search_documents where rowid=?", [id]);
    this.pendingSearch.delete(row.id);
    if (bodyText === undefined && !row.deleted) {
      const body = this.db.selectValue("select data from bodies where id=? and version=?", [
        row.id,
        row.bodyVersion,
      ]);
      if (typeof body === "string") bodyText = searchableBody(JSON.parse(body));
      else if (body !== undefined) this.pendingSearch.add(row.id);
    }
    if (!row.deleted)
      this.run(
        "insert into search_documents(rowid,subject,sender,recipients,snippet,body,message_id,thread_id,received_at) values(?,?,?,?,?,?,?,?,?)",
        [
          id,
          row.subject.normalize("NFKC"),
          row.from
            .map((p) => `${p.name ?? ""} ${p.address}`)
            .join(" ")
            .normalize("NFKC"),
          [...row.to, ...row.cc, ...row.bcc]
            .map((p) => `${p.name ?? ""} ${p.address}`)
            .join(" ")
            .normalize("NFKC"),
          (row.snippet ?? "").normalize("NFKC"),
          (bodyText ?? "").normalize("NFKC"),
          row.id,
          row.threadId,
          row.sortReceivedAt,
        ],
      );
  }
  search(text: string, limit = 75, sort: SearchSort = "newest"): SearchResponse {
    const query = ftsQuery(text);
    if (!query) return { messages: [], mode: "lexical" };
    limit = Math.max(1, Math.min(75, Math.floor(limit) || 75));
    const page =
      sort === "newest" ? this.newestMatches(query, limit) : this.rankedMatches(query, limit);
    const rows = page.length
      ? this.headers(
          `select id,thread_id,account_id,received_at,read,archived,deleted,classified,tier,direction,body_version,from_json,json_array(${fields
            .slice(0, 8)
            .map((_, index) => `data->'$[${index}]'`)
            .join(",")}) data from messages where rowid in (${page.map(() => "?").join(",")})`,
          page.map((row) => row.rowid),
        )
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const messages = this.summarize(page.map(({ id }) => byId.get(id) as ReplicaRow));
    return { messages, mode: "lexical" };
  }
  private newestMatches(query: string, limit: number) {
    return this.rows<{ rowid: number; id: string }>(
      "select doc rowid,id from (select rowid doc,message_id id,received_at,row_number() over(partition by thread_id order by received_at desc,message_id desc) thread_rank from search_documents where search_documents match ?) where thread_rank=1 order by received_at desc,id desc limit ?",
      [query, limit],
    );
  }
  private rankedMatches(query: string, limit: number) {
    const sql =
      "select rowid,rank score,message_id id,thread_id,received_at from search_documents where search_documents match ? and rank match 'bm25(8,6,3,2,0.5)' order by rank limit ?";
    type Candidate = {
      rowid: number;
      score: number;
      id: string;
      thread_id: string;
      received_at: string;
    };
    let page: Candidate[] = [];
    for (let size = Math.max(64, limit * 2); ; size *= 2) {
      const hits = this.rows<Candidate>(sql, [query, size]);
      const scores = new Map(hits.map((hit) => [hit.rowid, hit.score]));
      const candidates = [...hits];
      candidates.sort(
        (a, b) =>
          (scores.get(a.rowid) as number) - (scores.get(b.rowid) as number) ||
          (a.received_at < b.received_at
            ? 1
            : a.received_at > b.received_at
              ? -1
              : a.id < b.id
                ? 1
                : a.id > b.id
                  ? -1
                  : 0),
      );
      const threads = new Set<string>();
      page = [];
      for (const candidate of candidates) {
        if (threads.has(candidate.thread_id)) continue;
        threads.add(candidate.thread_id);
        page.push(candidate);
        if (page.length === limit) break;
      }
      if (
        hits.length < size ||
        (page.length === limit &&
          (scores.get(page.at(-1)?.rowid as number) as number) < (hits.at(-1)?.score as number))
      )
        break;
    }
    return page;
  }
  private indexBody(id: string, text: string) {
    const row = this.header(id);
    if (row) this.indexHeader(row, text);
  }
  async restoreSearch() {
    const ids = [...this.pendingSearch];
    for (let start = 0; start < ids.length; start += 32) {
      const batch = ids.slice(start, start + 32);
      const rows = this.rows<{ id: string; data: Uint8Array }>(
        `select id,data from bodies where id in (${batch.map(() => "?").join(",")})`,
        batch,
      );
      for (const id of batch) if (!rows.some((row) => row.id === id)) this.pendingSearch.delete(id);
      const decoded = await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          body: await unpackDetail({
            message: {} as ReplicaRow,
            hasBody: true,
            packedBody: row.data,
          }),
        })),
      );
      this.transaction(() => {
        for (const row of decoded)
          if (row.body) this.indexBody(row.id, searchableBody(row.body.message));
      });
    }
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
      for (const row of this.headers("select * from messages")) this.indexHeader(row);
      this.run("insert into search_documents(search_documents) values('optimize')");
    });
    this.run("vacuum");
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
    const ids = this.rows<{ id: string }>(
      "select m.id from messages m left join bodies b on b.id=m.id and b.version=m.body_version left join meta s on s.key='bodySkipped:'||m.id and s.value=m.body_version where m.received_at>=? and b.id is null and s.key is null order by m.received_at desc,m.id desc limit 16",
      [recentBodyCutoff()],
    ).map((row) => row.id);
    if (!ids.length && !this.searchReadyWarmed) {
      this.warmSearchCache(true);
      const start = performance.now();
      const subject = String(
        this.db.selectValue("select data->>'$[0]' from messages limit 1") ?? "",
      );
      const term = subject.match(/[\p{L}\p{N}]+/u)?.[0];
      if (term) this.search(term, 20);
      this.searchWarmMs += performance.now() - start;
      this.searchReadyWarmed = true;
    }
    return ids;
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
      searchWarmMs: this.searchWarmMs,
      ftsAllocatedBytes: allocated
        .filter((row) => row.name.startsWith("search_"))
        .reduce((total, row) => total + Number(row.bytes), 0),
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
  storageDetails() {
    const columnNames = this.rows<{ name: string }>("pragma table_info(messages)").map(
      (row) => row.name,
    );
    const physical = this.rows<Record<string, number>>(
      `select ${columnNames.map((name) => `sum(length(cast(${name} as blob))) as ${name}`).join(",")} from messages`,
    )[0];
    return {
      ...this.storageStats(),
      tables: this.rows(
        "select name,sum(pgsize) bytes,sum(payload) payload,sum(unused) unused from dbstat group by name order by bytes desc",
      ),
      physicalColumns: physical,
      columns: this.rows<{ name: string; bytes: number }>(
        "select 'messages.'||j.key name,sum(length(cast(j.value as blob))) bytes from messages,json_each(data) j group by j.key order by bytes desc",
      ).map((row) => ({
        ...row,
        name: `messages.${fields[Number(row.name.slice("messages.".length))]}`,
      })),
      bodies: this.rows(
        "select 'bodies.'||j.key name,sum(length(cast(j.value as blob))) bytes from bodies,json_each(case when typeof(data)='text' then data else '{}' end) j group by j.key order by bytes desc",
      ),
      bodyStorage: this.rows(
        "select typeof(data) encoding,count(*) count,sum(length(data)) bytes from bodies group by typeof(data)",
      ),
    };
  }
  profileList(input: Parameters<ReplicaStore["list"]>[0]) {
    return this.profileRead(() => this.list(input));
  }
  profileSearch(text: string, limit = 75, sort: SearchSort = "newest") {
    return this.profileRead(() => this.search(text, limit, sort));
  }
  private profileRead<T>(read: () => T) {
    const statements: { sql: string; bind: SqlValue[]; ms: number; rows: number }[] = [];
    const exec = this.db.exec;
    this.db.exec = ((...args: unknown[]) => {
      const start = performance.now();
      const result = Reflect.apply(exec, this.db, args);
      statements.push({
        sql: String((args[0] as { sql?: string })?.sql ?? args[0]),
        bind: (args[0] as { bind?: SqlValue[] })?.bind ?? [],
        ms: performance.now() - start,
        rows: Array.isArray(result) ? result.length : 0,
      });
      return result;
    }) as Database["exec"];
    const start = performance.now();
    try {
      const result = read();
      const totalMs = performance.now() - start,
        sqlMs = statements.reduce((sum, statement) => sum + statement.ms, 0);
      return { result, profile: { totalMs, sqlMs, jsMs: totalMs - sqlMs, statements } };
    } finally {
      this.db.exec = exec;
    }
  }
  queryPlans(input: Parameters<ReplicaStore["list"]>[0]) {
    const { profile } = this.profileList(input);
    return [
      ...new Map(profile.statements.map((statement) => [statement.sql, statement])).values(),
    ].map((statement) => ({
      sql: statement.sql,
      plan: this.rows(`explain query plan ${statement.sql}`, statement.bind),
    }));
  }
  searchPlans(text: string, limit = 75, sort: SearchSort = "newest") {
    const { profile } = this.profileSearch(text, limit, sort);
    return profile.statements.map((statement) => ({
      sql: statement.sql,
      plan: this.rows(`explain query plan ${statement.sql}`, statement.bind),
    }));
  }
  private headers(sql: string, bind: SqlValue[] = []): ReplicaRow[] {
    return this.rows<StoredRow>(sql, bind).map((row) => {
      const values = JSON.parse(row.data),
        account = this.accounts.get(row.account_id);
      if (!account) throw new Error("Replica account is missing");
      return {
        ...Object.fromEntries(fields.map((field, index) => [field, values[index]])),
        id: row.id,
        threadId: row.thread_id,
        account,
        receivedAt: new Date(row.received_at).toISOString(),
        sortReceivedAt: row.received_at,
        read: Boolean(row.read),
        archived: Boolean(row.archived),
        deleted: Boolean(row.deleted),
        classified: Boolean(row.classified),
        tier: row.tier,
        direction: row.direction,
        bodyVersion: row.body_version,
        from: JSON.parse(row.from_json),
        textBody: "",
        htmlBody: null,
        plainText: null,
        bodyAvailable: false,
      } as ReplicaRow;
    });
  }
  private header(id: string) {
    return this.headers("select * from messages where id=?", [id])[0];
  }
  private members(id: string, trash: boolean) {
    return this.headers(
      "select * from messages where thread_id=? and deleted=? order by received_at desc,id desc",
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
    const account = input.accountId !== undefined ? " and m.account_id=?" : "",
      newerAccount = input.accountId !== undefined ? " and n.account_id=?" : "";
    const rows = this.headers(
      `select m.* from messages m indexed by messages_order where ${condition(input.view, "m.")}${account}${after ? " and (m.received_at,m.id)<(?,?)" : ""} and not exists(select 1 from messages n where n.thread_id=m.thread_id and ${condition(input.view, "n.")}${newerAccount} and (n.received_at,n.id)>(m.received_at,m.id)) order by m.received_at desc,m.id desc limit ?`,
      [
        ...(input.accountId !== undefined ? [input.accountId] : []),
        ...(after ? [after.receivedAt, after.id] : []),
        ...(input.accountId !== undefined ? [input.accountId] : []),
        limit + 1,
      ],
    );
    const more = rows.length > limit;
    rows.length = Math.min(rows.length, limit);
    const messages = this.summarize(rows, input.view === "trash");
    const last = rows.at(-1);
    return {
      messages,
      nextCursor:
        more && last
          ? `local:${btoa(JSON.stringify({ receivedAt: last.sortReceivedAt, id: last.id }))}`
          : null,
    };
  }
  private summarize(rows: ReplicaRow[], trash = false): ConversationSummary[] {
    const aggregates = new Map<
      string,
      { count: number; unread: number; people: Map<string, MailAddress> }
    >();
    if (rows.length)
      for (const member of this.rows<{ thread_id: string; read: number; from_json: string }>(
        `select thread_id,read,from_json from messages where thread_id in (${rows.map(() => "?").join(",")}) and deleted=? order by thread_id,received_at desc,id desc`,
        [...rows.map((row) => row.threadId), Number(trash)],
      )) {
        let aggregate = aggregates.get(member.thread_id);
        if (!aggregate) {
          aggregate = { count: 0, unread: 0, people: new Map() };
          aggregates.set(member.thread_id, aggregate);
        }
        aggregate.count++;
        if (!member.read) aggregate.unread++;
        for (const person of JSON.parse(member.from_json) as MailAddress[])
          if (!aggregate.people.has(person.address.toLowerCase()))
            aggregate.people.set(person.address.toLowerCase(), person);
      }
    const messages = rows.map((row) => {
      const {
        count,
        unread: unreadCount,
        people,
      } = aggregates.get(row.threadId) as {
        count: number;
        unread: number;
        people: Map<string, MailAddress>;
      };
      const result: ConversationSummary = {
        id: row.id,
        threadId: row.threadId,
        account: row.account,
        subject: row.subject,
        from: row.from,
        snippet: row.snippet,
        receivedAt: row.receivedAt,
        flagged: row.flagged,
        direction: row.direction,
        tier: row.tier,
        modelTier: row.modelTier,
        reasoning: row.reasoning,
        aiSummary: row.aiSummary,
        attachmentCount: row.attachmentCount,
        syncPending: row.syncPending,
        read: unreadCount === 0,
        messageCount: count,
        unreadCount,
        participants: [...people.values()].sort((a, b) =>
          a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
        ),
      };
      return result;
    });
    return messages;
  }
  detail(id: string, opened = false): ReplicaDetail | undefined {
    if (opened) this.opened([id]);
    const row = this.header(id);
    if (!row) return;
    const body = this.rows<{ data: string | Uint8Array }>(
      "select data from bodies where id=? and version=?",
      [id, row.bodyVersion],
    )[0];
    if (body)
      this.run(
        "update bodies set touched=?,opened=max(opened,?) where id=? and (touched<? or opened<?)",
        [Date.now(), Number(opened), id, Date.now() - 60_000, Number(opened)],
      );
    return {
      message: { ...row, ...(body && typeof body.data === "string" ? JSON.parse(body.data) : {}) },
      hasBody: Boolean(body),
      ...(body && typeof body.data !== "string" ? { packedBody: body.data } : {}),
    };
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
  bodies(
    rows: ReplicaRow[],
    opened = true,
    requested = rows.map((row) => row.id),
    packed?: Map<string, Uint8Array>,
  ) {
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
            packed?.get(row.id) ?? JSON.stringify(fields),
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
        if (existing) {
          this.indexBody(row.id, searchableBody(row));
        }
      }
      this.trimBodies();
    });
  }
  begin(token: string, change: ReplicaChange) {
    this.transaction(() => {
      const rows = change.id
        ? this.headers("select * from messages where id=?", [change.id])
        : this.headers(
            `select * from messages where thread_id=? and ${condition(change.view ?? "all")} and (? is null or account_id=?)`,
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
