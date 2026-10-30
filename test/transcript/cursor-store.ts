/**
 * Builds synthetic Cursor chat stores with the running runtime's own SQLite
 * engine, so the pure page reader is checked against real engine output
 * rather than against bytes this repository wrote by hand.
 */
import { createHash } from "node:crypto";
import type { StageListener } from "./cursor-stage-trace.js";

interface Statement {
  run(...values: unknown[]): unknown;
}
interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  close(): unknown;
}

async function open(path: string, onStage?: StageListener): Promise<Database> {
  const bun = "bun:sqlite";
  const node = "node:sqlite";
  if ("Bun" in globalThis) {
    onStage?.("import", "start");
    const { Database } = (await import(bun)) as { Database: new (path: string) => Database };
    onStage?.("import", "end");
    onStage?.("open", "start");
    return new Database(path);
  }
  onStage?.("import", "start");
  const { DatabaseSync } = (await import(node)) as {
    DatabaseSync: new (path: string) => Database;
  };
  onStage?.("import", "end");
  onStage?.("open", "start");
  return new DatabaseSync(path);
}

/** Runs statements against a new database file and closes it. */
export async function writeDatabase(path: string, statements: readonly string[]): Promise<void> {
  const db = await open(path);
  try {
    for (const sql of statements) db.exec(sql);
  } finally {
    db.close();
  }
}

export const blobId = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** A root blob: protobuf field 1 repeated with each 32-byte message ID, then an opaque field. */
export function rootBlob(ids: readonly string[]): Uint8Array {
  const parts = ids.flatMap((id) => [0x0a, 0x20, ...Buffer.from(id, "hex")]);
  return Uint8Array.from([...parts, 0x50, 0x01]);
}

export interface CursorStore {
  readonly agentId: string;
  readonly messages: readonly unknown[];
  /** Earlier roots kept in the store, as message-index lists. */
  readonly earlierRoots?: readonly (readonly number[])[];
  readonly encryptionKey?: string;
  /** Raw blobs stored under their SHA-256, such as hand-built earlier roots. */
  readonly extraBlobs?: readonly Uint8Array[];
  /** Stage boundaries for the opt-in issue #388 trace; absent for ordinary use. */
  readonly onStage?: StageListener;
}

/** Writes the store in WAL mode and checkpoints it, leaving an empty or absent WAL. */
export async function writeCursorStore(path: string, store: CursorStore): Promise<string[]> {
  const { onStage } = store;
  onStage?.("preprocess", "start");
  const blobs = new Map<string, Uint8Array>();
  const ids = store.messages.map((message) => {
    const data = new TextEncoder().encode(JSON.stringify(message));
    const id = blobId(data);
    blobs.set(id, data);
    return id;
  });
  for (const indexes of store.earlierRoots ?? []) {
    const data = rootBlob(indexes.map((index) => ids[index] ?? ""));
    blobs.set(blobId(data), data);
  }
  for (const data of store.extraBlobs ?? []) blobs.set(blobId(data), data);
  const root = rootBlob(ids);
  const latest = blobId(root);
  blobs.set(latest, root);
  const meta = {
    agentId: store.agentId,
    latestRootBlobId: latest,
    name: "New Agent",
    mode: "default",
    isRunEverything: false,
    createdAt: 1789643942579,
    blobEncryptionKey: store.encryptionKey ?? "00".repeat(32),
  };
  onStage?.("preprocess", "end");
  const db = await open(path, onStage);
  try {
    onStage?.("open", "end");
    onStage?.("journal-mode", "start");
    db.exec("PRAGMA journal_mode=WAL");
    onStage?.("journal-mode", "end");
    onStage?.("schema", "start");
    db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    onStage?.("schema", "end");
    onStage?.("inserts", "start");
    const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
    for (const [id, data] of blobs) insert.run(id, data);
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      "0",
      Buffer.from(JSON.stringify(meta)).toString("hex"),
    );
    onStage?.("inserts", "end");
    // Cursor closes with an empty WAL; some system SQLite builds keep the WAL at close.
    onStage?.("checkpoint", "start");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    onStage?.("checkpoint", "end");
  } finally {
    try {
      onStage?.("close", "start");
    } finally {
      db.close();
    }
    onStage?.("close", "end");
  }
  return ids;
}
