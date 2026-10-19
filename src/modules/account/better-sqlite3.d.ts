declare module 'better-sqlite3' {
  interface Statement {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }

  class Database {
    constructor(filename: string);
    prepare(sql: string): Statement;
    exec(sql: string): this;
    close(): void;
  }

  export default Database;
}
