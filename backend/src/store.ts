import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fail } from "./errors.js";

export type OperationStatus = "draft" | "reserved" | "proof_persisted" | "broadcast" | "finalized" | "unresolved";
const statuses = new Set<OperationStatus>(["draft", "reserved", "proof_persisted", "broadcast", "finalized", "unresolved"]);

interface Ciphertext { nonce: Buffer; tag: Buffer; value: Buffer; }

function encrypt(key: Buffer, value: Buffer, aad: string): Ciphertext {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return { nonce, value: Buffer.concat([cipher.update(value), cipher.final()]), tag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, encrypted: Ciphertext, aad: string): Buffer {
  try {
    const cipher = createDecipheriv("aes-256-gcm", key, encrypted.nonce);
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(encrypted.tag);
    return Buffer.concat([cipher.update(encrypted.value), cipher.final()]);
  } catch (error) {
    return fail("STATE_DECRYPT_FAILED", `could not decrypt ${aad}`, error);
  }
}

export class RoleStore {
  readonly db: DatabaseSync;
  constructor(path: string, private readonly key: Buffer) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { if ((statSync(path).mode & 0o077) !== 0) fail("STATE_PERMISSIONS", `${path} must not be group/world accessible`); } catch (error) {
      if (!(error instanceof Error) || !/ENOENT/.test(String(error))) throw error;
    }
    this.db = new DatabaseSync(path);
    // SQLite may create the main database before its first transaction. Ensure
    // the database and any persistent WAL sidecars cannot expose encrypted
    // ciphertext or public operation metadata to another local account.
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, nonce BLOB NOT NULL, tag BLOB NOT NULL, value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, status TEXT NOT NULL, payload_hash TEXT NOT NULL, tx_digest TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (note_commitment TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS replay_ledger (scope TEXT NOT NULL, value TEXT NOT NULL, result TEXT, PRIMARY KEY(scope, value));
      CREATE TABLE IF NOT EXISTS checkpoints (stream TEXT PRIMARY KEY, checkpoint TEXT NOT NULL, cursor BLOB, root TEXT NOT NULL, leaf_index TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, ciphertext_hash TEXT NOT NULL, blob_id TEXT, UNIQUE(session_id, sequence));
      CREATE TABLE IF NOT EXISTS deliveries (request_id TEXT PRIMARY KEY, payment_key TEXT NOT NULL, response BLOB NOT NULL, finalized INTEGER NOT NULL);
    `);
  }

  close(): void { this.db.close(); }

  putSecret(name: string, value: Uint8Array): void {
    const encrypted = encrypt(this.key, Buffer.from(value), `secret:${name}`);
    this.db.prepare("INSERT OR REPLACE INTO secrets(name, nonce, tag, value) VALUES (?, ?, ?, ?)")
      .run(name, encrypted.nonce, encrypted.tag, encrypted.value);
  }
  getSecret(name: string): Buffer | undefined {
    const row = this.db.prepare("SELECT nonce, tag, value FROM secrets WHERE name = ?").get(name) as Ciphertext | undefined;
    return row ? decrypt(this.key, row, `secret:${name}`) : undefined;
  }

  beginOperation(id: string, payloadHash: string): void {
    this.db.prepare("INSERT INTO operations(id, status, payload_hash, updated_at) VALUES (?, 'draft', ?, ?)").run(id, payloadHash, Date.now());
  }
  transitionOperation(id: string, next: OperationStatus, txDigest?: string): void {
    if (!statuses.has(next)) fail("OPERATION_STATUS_INVALID", `unknown operation status ${next}`);
    const row = this.db.prepare("SELECT status FROM operations WHERE id = ?").get(id) as { status?: OperationStatus } | undefined;
    const current: OperationStatus = row?.status ?? fail("OPERATION_NOT_FOUND", `operation ${id} does not exist`);
    const allowed: Record<OperationStatus, OperationStatus[]> = {
      draft: ["reserved", "unresolved"], reserved: ["proof_persisted", "unresolved"],
      proof_persisted: ["broadcast", "unresolved"], broadcast: ["finalized", "unresolved"],
      finalized: [], unresolved: ["broadcast", "finalized"],
    };
    if (!allowed[current].includes(next)) fail("OPERATION_TRANSITION_INVALID", `${current} cannot transition to ${next}`);
    this.db.prepare("UPDATE operations SET status = ?, tx_digest = COALESCE(?, tx_digest), updated_at = ? WHERE id = ?")
      .run(next, txDigest ?? null, Date.now(), id);
  }
  reserveNote(noteCommitment: string, operationId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT operation_id FROM reservations WHERE note_commitment = ?").get(noteCommitment) as { operation_id: string } | undefined;
      if (existing && existing.operation_id !== operationId) fail("NOTE_RESERVED", "note is already reserved by another operation");
      this.db.prepare("INSERT OR IGNORE INTO reservations(note_commitment, operation_id, created_at) VALUES (?, ?, ?)").run(noteCommitment, operationId, Date.now());
      this.transitionOperation(operationId, "reserved");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  claimOnce(scope: string, value: string, result?: string): boolean {
    const info = this.db.prepare("INSERT OR IGNORE INTO replay_ledger(scope, value, result) VALUES (?, ?, ?)").run(scope, value, result ?? null);
    return info.changes === 1;
  }
}
