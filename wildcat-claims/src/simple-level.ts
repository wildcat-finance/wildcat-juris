import levelup, { LevelUp } from 'levelup';
import leveldown from 'leveldown';
import memdown from 'memdown';
import fs from 'fs';
import path from 'path';

const isNotFound = (err: any): boolean =>
  !!err && (err.notFound || err.type === 'NotFoundError' || /not\s*found/i.test(err.message ?? ''));

export type JsonValue =
  | boolean
  | string
  | number
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Minimal JSON key/value store over LevelDB (on disk) or memdown (in-memory).
 * Keys and values are JSON-encoded; missing keys resolve to null.
 */
export default class SimpleLevel {
  private db: LevelUp;

  constructor(name = '.db', dbPath: string = path.join(__dirname, '..')) {
    if (dbPath) {
      if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath, { recursive: true });
      this.db = levelup(leveldown(path.join(dbPath, name)));
    } else {
      this.db = levelup(memdown());
    }
  }

  async put(key: JsonValue, value: JsonValue): Promise<void> {
    await this.db.put(JSON.stringify(key), JSON.stringify(value));
  }

  async get<T = any>(key: JsonValue): Promise<T | null> {
    try {
      const raw = await this.db.get(JSON.stringify(key));
      return JSON.parse(raw.toString()) as T;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  close(): Promise<void> {
    return this.db.close();
  }
}
