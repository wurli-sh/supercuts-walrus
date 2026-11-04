import { fail } from "./errors.js";
import type { EncryptedSellerSnapshot } from "./seller-state.js";
import type { SignedCapabilityRegistration } from "./capability.js";

/** Server-only PostgREST access. The service-role key must never reach a buyer tool. */
export class SellerDatabase {
  constructor(private readonly origin: string, private readonly serviceKey: string, private readonly http: typeof fetch = fetch) {
    const url = new URL(origin);
    if (url.protocol !== "https:") fail("SELLER_DB_INVALID", "Supabase URL must use HTTPS");
    if (!serviceKey) fail("SELLER_DB_INVALID", "Supabase service key is required");
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.http(new URL(`/rest/v1/${path}`, this.origin), {
      ...init,
      headers: { apikey: this.serviceKey, Authorization: `Bearer ${this.serviceKey}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) { await response.arrayBuffer(); fail("SELLER_DB_UNAVAILABLE", `Supabase returned ${response.status}`); }
    const body = await response.text();
    return body ? JSON.parse(body) as unknown : undefined;
  }

  async getSnapshot(sellerId: string): Promise<{ payload: EncryptedSellerSnapshot; revision: number } | undefined> {
    const rows = await this.request(`seller_state?seller_id=eq.${encodeURIComponent(sellerId)}&select=payload,revision`) as Array<{ payload: EncryptedSellerSnapshot; revision: number }>;
    return rows[0];
  }

  async putSnapshot(snapshot: EncryptedSellerSnapshot, expectedRevision?: number): Promise<number> {
    if (expectedRevision === undefined) {
      await this.request("seller_state?on_conflict=seller_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ seller_id: snapshot.sellerId, payload: snapshot, revision: 0, updated_at: new Date().toISOString() }) });
      return 0;
    }
    const rows = await this.request(`seller_state?seller_id=eq.${encodeURIComponent(snapshot.sellerId)}&revision=eq.${expectedRevision}&select=revision`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ payload: snapshot, revision: expectedRevision + 1, updated_at: new Date().toISOString() }) }) as Array<{ revision: number }>;
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.revision !== expectedRevision + 1) fail("SELLER_STATE_CONFLICT", "another seller instance updated the durable snapshot");
    return expectedRevision + 1;
  }

  async listCatalog(): Promise<Array<Record<string, unknown>>> {
    return await this.request("seller_catalog?select=seller_id,capability_id,manifest,blob_id,signature,transport_public_key,preview,updated_at&order=capability_id.asc") as Array<Record<string, unknown>>;
  }

  async listDirectory(now = Date.now(), offset = 0): Promise<SignedCapabilityRegistration[]> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) fail("SELLER_DIRECTORY_INVALID", "directory offset is invalid");
    const rows = await this.request(`seller_directory?expires_at=gt.${now}&select=registration&order=capability_id.asc&limit=100&offset=${offset}`) as Array<{ registration: SignedCapabilityRegistration }>;
    return rows.map((row) => row.registration);
  }

  async putDirectory(registration: SignedCapabilityRegistration): Promise<void> {
    const manifest = registration.manifest;
    const existing = await this.request(`seller_directory?capability_id=eq.${encodeURIComponent(manifest.capabilityId)}&select=seller_id,registration`) as Array<{ seller_id: string; registration: SignedCapabilityRegistration }>;
    if (existing[0] && existing[0].seller_id !== manifest.sellerId)
      fail("SELLER_DIRECTORY_CONFLICT", "capability ID belongs to another seller");
    await this.request("seller_directory?on_conflict=capability_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ capability_id: manifest.capabilityId, seller_id: manifest.sellerId, registration, endpoint_origin: new URL(manifest.endpoint).origin, expires_at: manifest.expiresAt, updated_at: new Date().toISOString() }) });
  }

  async putCatalog(row: { seller_id: string; capability_id: string; manifest: unknown; blob_id: string; signature: string; transport_public_key: string; preview: unknown }): Promise<void> {
    await this.request("seller_catalog?on_conflict=capability_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }) });
  }

  async addEvent(row: { run_id: string; seller_id: string; stage: string; status: string; details: Record<string, unknown> }): Promise<void> {
    await this.request("seller_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...row, created_at: new Date().toISOString() }) });
  }

  async listEvents(runId: string): Promise<Array<Record<string, unknown>>> {
    return await this.request(`seller_events?run_id=eq.${encodeURIComponent(runId)}&select=seller_id,stage,status,details,created_at&order=id.asc`) as Array<Record<string, unknown>>;
  }

  async listPaymentClaims(): Promise<Array<{ digest: string; request_id: string; seller_id: string }>> {
    return await this.request("seller_payment_claims?select=digest,request_id,seller_id&order=digest.asc") as Array<{ digest: string; request_id: string; seller_id: string }>;
  }

  async claimPayment(digest: string, requestId: string, sellerId: string): Promise<void> {
    const inserted = await this.request("seller_payment_claims?on_conflict=digest&select=digest,request_id,seller_id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ digest, request_id: requestId, seller_id: sellerId }) }) as Array<{ digest: string; request_id: string; seller_id: string }>;
    if (Array.isArray(inserted) && inserted.length === 1) return;
    const existing = await this.request(`seller_payment_claims?digest=eq.${encodeURIComponent(digest)}&select=request_id,seller_id`) as Array<{ request_id: string; seller_id: string }>;
    if (existing[0]?.request_id !== requestId || existing[0]?.seller_id !== sellerId) fail("PAYMENT_CONSUMED", "payment digest is already claimed by another resource");
  }
}
