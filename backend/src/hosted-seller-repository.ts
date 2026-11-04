import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { fail } from "./errors.js";
import type { SellerSnapshot } from "./seller-state.js";

type Envelope = { nonce: string; tag: string; ciphertext: string };
type StoredRecord = { kind: string; recordId: string; plaintextHash: string; ciphertext: Envelope };
type StoredArtifact = { artifactKey: string; plaintextHash: string; ciphertext: Envelope };

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function keyBytes(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) fail("SELLER_STATE_KEY_INVALID", "seller wrapping key must contain 32 bytes");
  return key;
}
function seal(key: Buffer, aad: string, bytes: Buffer): Envelope {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}
function open(key: Buffer, aad: string, value: Envelope): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.nonce, "base64url"));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]);
  } catch (error) { return fail("SELLER_STATE_DECRYPT_FAILED", "hosted seller row could not be authenticated", error); }
}
const encodeRow = (row: Record<string, unknown>): Buffer => Buffer.from(JSON.stringify(Object.fromEntries(
  Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? { __sellerBytes: Buffer.from(value).toString("base64url") } : value]))));
const decodeRow = (bytes: Buffer): Record<string, unknown> => JSON.parse(bytes.toString(), (_key, value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) && "__sellerBytes" in value
    ? Buffer.from(String((value as Record<string, unknown>).__sellerBytes), "base64url") : value) as Record<string, unknown>;

/** Direct Postgres connection used only by owner-side migration and seller processes. */
export class HostedSellerRepository {
  readonly #pool: Pool;
  constructor(connectionString: string, private readonly wrappingKey: string) {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.searchParams.get("sslmode") === "disable" || url.searchParams.get("sslmode") === "no-verify")
      fail("SELLER_DB_INVALID", "SUPABASE_DB_URL must be a credentialed Postgres URL with verified TLS");
    // Use parsed fields so URL options cannot override the TLS policy.
    this.#pool = new Pool({ host: url.hostname, port: url.port ? Number(url.port) : 5432,
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)), ssl: { rejectUnauthorized: true }, max: 4 });
    keyBytes(wrappingKey);
  }
  async close(): Promise<void> { await this.#pool.end(); }

  async verifyLegacyCollections(catalog: Array<Record<string, unknown>>, claims: Array<{ digest: string; request_id: string; seller_id: string }>): Promise<void> {
    const remoteCatalog = await this.#pool.query<{ capability_id: string; seller_id: string; blob_id: string; signature: string; transport_public_key: string }>(
      "SELECT capability_id,seller_id,blob_id,signature,transport_public_key FROM public.seller_catalog ORDER BY capability_id");
    const reduced = catalog.map((row) => ({ capability_id: row.capability_id, seller_id: row.seller_id, blob_id: row.blob_id, signature: row.signature, transport_public_key: row.transport_public_key }));
    if (JSON.stringify(remoteCatalog.rows) !== JSON.stringify(reduced)) fail("SELLER_IMPORT_MISMATCH", "direct Postgres catalog differs from snapshot source");
    const remoteClaims = await this.#pool.query<{ digest: string; request_id: string; seller_id: string }>("SELECT digest,request_id,seller_id FROM public.seller_payment_claims ORDER BY digest");
    if (JSON.stringify(remoteClaims.rows) !== JSON.stringify(claims)) fail("SELLER_IMPORT_MISMATCH", "direct Postgres payment claims differ from snapshot source");
  }

  /** Durable intent; the caller performs the network action after this returns. */
  async claimOperation(sellerId: string, operationId: string, action: string, inputHash: string): Promise<"prepared" | "unresolved" | "confirmed"> {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(operationId) || !/^[0-9a-f]{64}$/.test(inputHash) || !action)
      fail("SELLER_REQUEST_INVALID", "operation identity is invalid");
    const result = await this.#pool.query<{ action: string; input_hash: string; status: "prepared" | "unresolved" | "confirmed" }>(
      "INSERT INTO public.seller_operation_intents(seller_id,operation_id,action,input_hash,status) VALUES($1,$2,$3,$4,'prepared') ON CONFLICT(seller_id,operation_id) DO UPDATE SET updated_at=seller_operation_intents.updated_at RETURNING action,input_hash,status",
      [sellerId, operationId, action, inputHash]);
    const row = result.rows[0]!;
    if (row.action !== action || row.input_hash !== inputHash) fail("OPERATION_ID_CONFLICT", "operation ID already identifies another seller action");
    return row.status;
  }

  async transitionOperation(sellerId: string, operationId: string, status: "unresolved" | "confirmed", evidenceHash?: string): Promise<void> {
    if (evidenceHash !== undefined && !/^[0-9a-f]{64}$/.test(evidenceHash)) fail("SELLER_REQUEST_INVALID", "operation evidence hash is invalid");
    if (status === "confirmed" && !evidenceHash) fail("SELLER_REQUEST_INVALID", "confirmed operation needs finalized evidence");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ status: string; evidence_hash: string | null }>("SELECT status,evidence_hash FROM public.seller_operation_intents WHERE seller_id=$1 AND operation_id=$2 FOR UPDATE", [sellerId, operationId]);
      const row = result.rows[0] ?? fail("OPERATION_NOT_FOUND", "seller operation intent is missing");
      if (row.status === "confirmed" && (status !== "confirmed" || row.evidence_hash !== evidenceHash)) fail("OPERATION_DIGEST_CONFLICT", "confirmed operation evidence cannot change");
      if (row.status !== "confirmed") await client.query("UPDATE public.seller_operation_intents SET status=$3,evidence_hash=$4,updated_at=now() WHERE seller_id=$1 AND operation_id=$2", [sellerId, operationId, status, evidenceHash ?? null]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  /** Payment digest and request ID are both unique across all hosted sellers. */
  async claimPayment(digest: string, requestId: string, sellerId: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ digest: string; request_id: string; seller_id: string }>(
        "INSERT INTO public.seller_payment_claims(digest,request_id,seller_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING digest,request_id,seller_id", [digest, requestId, sellerId]);
      if (!result.rows.length) {
        const existing = await client.query<{ digest: string; request_id: string; seller_id: string }>("SELECT digest,request_id,seller_id FROM public.seller_payment_claims WHERE digest=$1 OR request_id=$2", [digest, requestId]);
        if (existing.rows.length !== 1 || existing.rows[0]!.digest !== digest || existing.rows[0]!.request_id !== requestId || existing.rows[0]!.seller_id !== sellerId) fail("PAYMENT_CONSUMED", "payment digest or request ID is already claimed");
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  /** Import is one transaction. Replays must match the original source exactly. */
  async importSnapshot(snapshot: SellerSnapshot, sourceRevision: number): Promise<{ records: number; artifacts: number; sourceHash: string }> {
    if (snapshot.version !== 1 || !/^0x[0-9a-f]{64}$/i.test(snapshot.sellerId)) fail("SELLER_STATE_INVALID", "seller snapshot identity is invalid");
    const sellerId = snapshot.sellerId, wrapping = keyBytes(this.wrappingKey);
    const stateKey = Buffer.from(snapshot.files["state.key"], "base64url");
    if (stateKey.length !== 32) fail("SELLER_STATE_KEY_INVALID", "imported role key must contain 32 bytes");
    const profile = Buffer.from(snapshot.files["profile.json"], "base64url"), mandate = Buffer.from(snapshot.files["mandate.json"], "base64url");
    const sourceHash = hash(Buffer.from(JSON.stringify(snapshot)));
    const temporary = mkdtempSync(join(tmpdir(), "supercuts-seller-import-"));
    const sqlitePath = join(temporary, "state.sqlite");
    writeFileSync(sqlitePath, Buffer.from(snapshot.files["state.sqlite"], "base64url"), { mode: 0o600, flag: "wx" });
    const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
    let records: StoredRecord[] = [];
    try {
      // The owner-only temporary file is removed before any database connection.
      const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
      for (const { name } of tables) {
        const columns = sqlite.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all() as Array<{ name: string; pk: number }>;
        const pk = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
        const rows = sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() as Array<Record<string, unknown>>;
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index]!, bytes = encodeRow(row), recordId = pk.length ? JSON.stringify(pk.map((column) => row[column.name])) : `row:${index}`;
          records.push({ kind: name, recordId, plaintextHash: hash(bytes), ciphertext: seal(wrapping, `seller:${sellerId}:row:${name}:${recordId}`, bytes) });
        }
      }
    } finally { sqlite.close(); rmSync(temporary, { recursive: true, force: true }); }
    records = records.sort((a, b) => a.kind.localeCompare(b.kind) || a.recordId.localeCompare(b.recordId));
    const artifacts: StoredArtifact[] = Object.entries(snapshot.artifacts).sort(([a], [b]) => a.localeCompare(b)).map(([artifactKey, encoded]) => {
      const bytes = Buffer.from(encoded, "base64url");
      return { artifactKey, plaintextHash: hash(bytes), ciphertext: seal(wrapping, `seller:${sellerId}:artifact:${artifactKey}`, bytes) };
    });
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ source_hash: string; source_revision: string }>("SELECT source_hash,source_revision FROM public.seller_roles WHERE seller_id=$1 FOR UPDATE", [sellerId]);
      if (current.rows.length) {
        if (current.rows[0]!.source_hash !== sourceHash || Number(current.rows[0]!.source_revision) !== sourceRevision) fail("SELLER_STATE_CONFLICT", "import source differs from the existing seller rows");
      } else {
        await client.query("INSERT INTO public.seller_roles(seller_id,profile_ciphertext,mandate_ciphertext,wrapped_state_key,source_revision,source_hash) VALUES($1,$2,$3,$4,$5,$6)", [sellerId, seal(wrapping, `seller:${sellerId}:profile`, profile), seal(wrapping, `seller:${sellerId}:mandate`, mandate), seal(wrapping, `seller:${sellerId}:state-key`, stateKey), sourceRevision, sourceHash]);
      }
      await this.insertRecords(client, sellerId, records, artifacts);
      const count = await client.query<{ records: string; artifacts: string }>("SELECT (SELECT count(*) FROM public.seller_records WHERE seller_id=$1)::text AS records,(SELECT count(*) FROM public.seller_artifacts WHERE seller_id=$1)::text AS artifacts", [sellerId]);
      if (Number(count.rows[0]?.records) !== records.length || Number(count.rows[0]?.artifacts) !== artifacts.length) fail("SELLER_IMPORT_MISMATCH", "Postgres row count differs from snapshot");
      await client.query("COMMIT");
      return { records: records.length, artifacts: artifacts.length, sourceHash };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  private async insertRecords(client: PoolClient, sellerId: string, records: StoredRecord[], artifacts: StoredArtifact[]): Promise<void> {
    for (const row of records) {
      const result = await client.query<{ plaintext_hash: string }>("INSERT INTO public.seller_records(seller_id,kind,record_id,plaintext_hash,ciphertext) VALUES($1,$2,$3,$4,$5) ON CONFLICT(seller_id,kind,record_id) DO UPDATE SET plaintext_hash=seller_records.plaintext_hash RETURNING plaintext_hash", [sellerId, row.kind, row.recordId, row.plaintextHash, row.ciphertext]);
      if (result.rows[0]?.plaintext_hash !== row.plaintextHash) fail("SELLER_IMPORT_MISMATCH", "existing seller row differs from snapshot");
    }
    for (const row of artifacts) {
      const result = await client.query<{ plaintext_hash: string }>("INSERT INTO public.seller_artifacts(seller_id,artifact_key,plaintext_hash,ciphertext) VALUES($1,$2,$3,$4) ON CONFLICT(seller_id,artifact_key) DO UPDATE SET plaintext_hash=seller_artifacts.plaintext_hash RETURNING plaintext_hash", [sellerId, row.artifactKey, row.plaintextHash, row.ciphertext]);
      if (result.rows[0]?.plaintext_hash !== row.plaintextHash) fail("SELLER_IMPORT_MISMATCH", "existing seller artifact differs from snapshot");
    }
  }

  /** Readback authenticates every encrypted row and returns only safe counts. */
  async verifyImport(sellerId: string): Promise<{ sourceHash: string; records: Record<string, number>; artifacts: number }> {
    const wrapping = keyBytes(this.wrappingKey);
    const role = await this.#pool.query<{ source_hash: string; profile_ciphertext: Envelope; mandate_ciphertext: Envelope; wrapped_state_key: Envelope }>("SELECT source_hash,profile_ciphertext,mandate_ciphertext,wrapped_state_key FROM public.seller_roles WHERE seller_id=$1", [sellerId]);
    if (role.rows.length !== 1) fail("SELLER_STATE_MISSING", "seller role was not imported");
    const value = role.rows[0]!;
    for (const [kind, envelope] of [["profile", value.profile_ciphertext], ["mandate", value.mandate_ciphertext], ["state-key", value.wrapped_state_key]] as const) open(wrapping, `seller:${sellerId}:${kind}`, envelope);
    const rows = await this.#pool.query<StoredRecord & { kind: string; record_id: string; plaintext_hash: string }>("SELECT kind,record_id,plaintext_hash,ciphertext FROM public.seller_records WHERE seller_id=$1", [sellerId]);
    const counts: Record<string, number> = {};
    for (const row of rows.rows) {
      const bytes = open(wrapping, `seller:${sellerId}:row:${row.kind}:${row.record_id}`, row.ciphertext);
      if (hash(bytes) !== row.plaintext_hash) fail("SELLER_IMPORT_MISMATCH", "seller row hash differs after readback");
      decodeRow(bytes); counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    }
    const artifacts = await this.#pool.query<StoredArtifact & { artifact_key: string; plaintext_hash: string }>("SELECT artifact_key,plaintext_hash,ciphertext FROM public.seller_artifacts WHERE seller_id=$1", [sellerId]);
    for (const row of artifacts.rows) if (hash(open(wrapping, `seller:${sellerId}:artifact:${row.artifact_key}`, row.ciphertext)) !== row.plaintext_hash) fail("SELLER_IMPORT_MISMATCH", "seller artifact hash differs after readback");
    return { sourceHash: value.source_hash, records: counts, artifacts: artifacts.rows.length };
  }
}
