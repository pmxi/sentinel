import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { basename, isAbsolute } from "node:path";

export class TestDatabase {
  constructor(path) {
    assert(path && isAbsolute(path) && /^sent_test_[a-zA-Z0-9_-]+\.sqlite$/.test(basename(path)), "Set an absolute local SENT_TEST_DATABASE_PATH named sent_test_*.sqlite");
    this.path = path;
  }
  async connect() {
    this.db = new DatabaseSync(this.path);
    this.db.exec("pragma foreign_keys=on; pragma busy_timeout=5000");
  }
  async query(sql, values = []) {
    const bindings=[];
    sql=sql.replace(/\$(\d+)/g,(_,n)=>{
      const value=values[Number(n)-1];
      bindings.push(value instanceof Date?value.toISOString():value);
      return "?";
    });
    const statement=this.db.prepare(sql);
    return { rows:statement.columns().length?statement.all(...bindings):(statement.run(...bindings),[]) };
  }
  async signal(ids) {
    const insert=this.db.prepare("insert into sent_live_changes(kind,message_id) values('message',?)");
    for(const id of ids)insert.run(id);
  }
  async end() { this.db?.close(); }
}
