import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fail } from "./errors.js";

export type OperationStatus = "draft" | "reserved" | "proof_persisted" | "broadcast" | "finalized" | "confirmed" | "delivered" | "unresolved";
const statuses = new Set<OperationStatus>(["draft", "reserved", "proof_persisted", "broadcast", "finalized", "confirmed", "delivered", "unresolved"]);

export interface StoredOperation { id: string; status: OperationStatus; payloadHash: string; txDigest?: string; updatedAt: number; }
export interface StoredMessage { id: string; sessionId: string; sequence: number; ciphertextHash: string; blobId?: string; }

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
  readonly #key: Buffer;
  constructor(path: string, key: Buffer) {
    if (key.length !== 32) fail("STATE_KEY_INVALID", "role-store key must contain exactly 32 bytes");
    this.#key = Buffer.from(key);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if ((statSync(directory).mode & 0o077) !== 0) fail("STATE_DIRECTORY_PERMISSIONS", `${directory} must not be group/world accessible`);
    if (existsSync(path) && (statSync(path).mode & 0o077) !== 0) fail("STATE_PERMISSIONS", `${path} must not be group/world accessible`);
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
      CREATE UNIQUE INDEX IF NOT EXISTS deliveries_payment_key ON deliveries(payment_key);
      CREATE TABLE IF NOT EXISTS x402_challenges (request_id TEXT PRIMARY KEY, nonce TEXT NOT NULL, requirements_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery_jobs (request_id TEXT PRIMARY KEY, status TEXT NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS notes (commitment TEXT PRIMARY KEY, operation_id TEXT, role TEXT NOT NULL, leaf_index TEXT, nullifier TEXT, spent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS memory_jobs (operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, fact_hash TEXT NOT NULL, blob_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settlement_plans (plan_hash TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, plan_json TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settlement_execution_bindings (operation_id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL UNIQUE, binding_hash TEXT NOT NULL, binding_json TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(plan_hash) REFERENCES settlement_plans(plan_hash));
      CREATE TABLE IF NOT EXISTS settlement_agreement_bindings (session_id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL UNIQUE, binding_hash TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(plan_hash) REFERENCES settlement_plans(plan_hash));
      CREATE TABLE IF NOT EXISTS settlement_decision_traces (plan_hash TEXT PRIMARY KEY, mandate_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL, risk_level TEXT NOT NULL, reason_codes TEXT NOT NULL, citations TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(plan_hash) REFERENCES settlement_plans(plan_hash));
    `);
    const memoryColumns = this.db.prepare("PRAGMA table_info(memory_jobs)").all() as Array<{ name: string }>;
    if (!memoryColumns.some((column) => column.name === "fact_hash")) this.db.exec("ALTER TABLE memory_jobs ADD COLUMN fact_hash TEXT");
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }

  close(): void { this.db.close(); }

  putSecret(name: string, value: Uint8Array): void {
    const encrypted = encrypt(this.#key, Buffer.from(value), `secret:${name}`);
    this.db.prepare("INSERT OR REPLACE INTO secrets(name, nonce, tag, value) VALUES (?, ?, ?, ?)")
      .run(name, encrypted.nonce, encrypted.tag, encrypted.value);
  }
  putSecretOnce(name: string, value: Uint8Array): void {
    const existing = this.getSecret(name);
    if (existing) {
      if (!existing.equals(Buffer.from(value))) fail("SECRET_ID_CONFLICT", `secret ${name} already contains different bytes`);
      return;
    }
    this.putSecret(name, value);
  }
  getSecret(name: string): Buffer | undefined {
    const row = this.db.prepare("SELECT nonce, tag, value FROM secrets WHERE name = ?").get(name) as Ciphertext | undefined;
    return row ? decrypt(this.#key, row, `secret:${name}`) : undefined;
  }

  beginOperation(id: string, payloadHash: string): void {
    const existing = this.getOperation(id);
    if (existing) {
      if (existing.payloadHash !== payloadHash) fail("OPERATION_ID_CONFLICT", `operation ${id} already has a different payload`);
      return;
    }
    this.db.prepare("INSERT INTO operations(id, status, payload_hash, updated_at) VALUES (?, 'draft', ?, ?)").run(id, payloadHash, Date.now());
  }
  getOperation(id: string): StoredOperation | undefined {
    const row = this.db.prepare("SELECT id, status, payload_hash, tx_digest, updated_at FROM operations WHERE id = ?").get(id) as
      { id: string; status: OperationStatus; payload_hash: string; tx_digest: string | null; updated_at: number } | undefined;
    return row ? { id: row.id, status: row.status, payloadHash: row.payload_hash, ...(row.tx_digest ? { txDigest: row.tx_digest } : {}), updatedAt: row.updated_at } : undefined;
  }
  transitionOperation(id: string, next: OperationStatus, txDigest?: string): void {
    if (!statuses.has(next)) fail("OPERATION_STATUS_INVALID", `unknown operation status ${next}`);
    const row = this.db.prepare("SELECT status, tx_digest FROM operations WHERE id = ?").get(id) as { status?: OperationStatus; tx_digest: string | null } | undefined;
    const current: OperationStatus = row?.status ?? fail("OPERATION_NOT_FOUND", `operation ${id} does not exist`);
    if (row?.tx_digest && txDigest && row.tx_digest !== txDigest) fail("OPERATION_DIGEST_CONFLICT", "operation cannot transition with a different transaction digest");
    if (current === next) return;
    const allowed: Record<OperationStatus, OperationStatus[]> = {
      draft: ["reserved", "unresolved"], reserved: ["proof_persisted", "unresolved"],
      proof_persisted: ["broadcast", "unresolved"], broadcast: ["finalized", "unresolved"],
      finalized: ["confirmed", "unresolved"], confirmed: ["delivered", "unresolved"], delivered: [],
      unresolved: ["broadcast", "finalized", "confirmed"],
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
      if (this.getOperation(operationId)?.status === "draft") this.transitionOperation(operationId, "reserved");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  claimOnce(scope: string, value: string, result?: string): boolean {
    const info = this.db.prepare("INSERT OR IGNORE INTO replay_ledger(scope, value, result) VALUES (?, ?, ?)").run(scope, value, result ?? null);
    return info.changes === 1;
  }

  prepareMessage(message: StoredMessage): void {
    const existing = this.getMessage(message.id);
    if (existing) {
      if (existing.sessionId !== message.sessionId || existing.sequence !== message.sequence || existing.ciphertextHash !== message.ciphertextHash) {
        fail("MESSAGE_ID_CONFLICT", `message ${message.id} already identifies different ciphertext`);
      }
      return;
    }
    try {
      this.db.prepare("INSERT INTO messages(id, session_id, sequence, ciphertext_hash, blob_id) VALUES (?, ?, ?, ?, NULL)")
        .run(message.id, message.sessionId, message.sequence, message.ciphertextHash);
    } catch (error) { fail("MESSAGE_SEQUENCE_CONFLICT", "session sequence is already occupied", error); }
  }
  attachMessageBlob(id: string, ciphertextHash: string, blobId: string): void {
    const row = this.getMessage(id) ?? fail("MESSAGE_NOT_FOUND", `message ${id} was not prepared`);
    if (row.ciphertextHash !== ciphertextHash) fail("CIPHERTEXT_TAMPERED", "uploaded ciphertext differs from the durable message");
    if (row.blobId && row.blobId !== blobId) fail("MESSAGE_BLOB_CONFLICT", "message already resolved to another blob");
    this.db.prepare("UPDATE messages SET blob_id = ? WHERE id = ?").run(blobId, id);
  }
  getMessage(id: string): StoredMessage | undefined {
    const row = this.db.prepare("SELECT id, session_id, sequence, ciphertext_hash, blob_id FROM messages WHERE id = ?").get(id) as
      { id: string; session_id: string; sequence: number; ciphertext_hash: string; blob_id: string | null } | undefined;
    return row ? { id: row.id, sessionId: row.session_id, sequence: row.sequence, ciphertextHash: row.ciphertext_hash, ...(row.blob_id ? { blobId: row.blob_id } : {}) } : undefined;
  }

  putNote(commitment: string, role: "input" | "payment" | "change", operationId?: string, leafIndex?: bigint, nullifier?: string): void {
    const existing = this.db.prepare("SELECT operation_id, role, leaf_index, nullifier FROM notes WHERE commitment = ?").get(commitment) as { operation_id: string | null; role: string; leaf_index: string | null; nullifier: string | null } | undefined;
    const values = { operationId: operationId ?? null, role, leafIndex: leafIndex?.toString() ?? null, nullifier: nullifier ?? null };
    if (existing && (existing.operation_id !== values.operationId || existing.role !== role || (existing.leaf_index && values.leafIndex && existing.leaf_index !== values.leafIndex) || (existing.nullifier && values.nullifier && existing.nullifier !== values.nullifier))) fail("NOTE_ID_CONFLICT", "note commitment is already associated with different recovery data");
    this.db.prepare("INSERT INTO notes(commitment, operation_id, role, leaf_index, nullifier, spent) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(commitment) DO UPDATE SET leaf_index=COALESCE(notes.leaf_index, excluded.leaf_index), nullifier=COALESCE(notes.nullifier, excluded.nullifier)")
      .run(commitment, values.operationId, role, values.leafIndex, values.nullifier);
  }
  markNoteSpent(nullifier: string): void { this.db.prepare("UPDATE notes SET spent = 1 WHERE nullifier = ?").run(nullifier); }
  hasUnspentNote(commitment: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS found FROM notes WHERE commitment = ? AND spent = 0").get(commitment));
  }
}
