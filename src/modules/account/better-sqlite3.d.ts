declare module 'better-sqlite3' {
  interface Statement {
    get(...args: unknown[]): unknown;
  }

  class Database {
    constructor(filename: string);
    prepare(sql: string): Statement;
  }

  export default Database;
}
