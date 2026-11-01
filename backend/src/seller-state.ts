import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fail } from "./errors.js";

const FILES = ["profile.json", "mandate.json", "state.key", "state.sqlite"] as const;

export interface SellerSnapshot { version: 1; sellerId: string; files: Record<(typeof FILES)[number], string>; artifacts: Record<string, string>; }
export interface EncryptedSellerSnapshot { version: 1; sellerId: string; nonce: string; tag: string; ciphertext: string; }

function keyBytes(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) fail("SELLER_STATE_KEY_INVALID", "seller snapshot key must contain 32 bytes");
  return key;
}

export function encryptSellerSnapshot(snapshot: SellerSnapshot, encodedKey: string): EncryptedSellerSnapshot {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", keyBytes(encodedKey), nonce);
  cipher.setAAD(Buffer.from(`supercuts-seller-state-v1:${snapshot.sellerId}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
  return { version: 1, sellerId: snapshot.sellerId, nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

export function decryptSellerSnapshot(value: EncryptedSellerSnapshot, encodedKey: string): SellerSnapshot {
  try {
    if (value.version !== 1 || !value.sellerId) fail("SELLER_STATE_INVALID", "seller snapshot version or identity is invalid");
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(encodedKey), Buffer.from(value.nonce, "base64url"));
    decipher.setAAD(Buffer.from(`supercuts-seller-state-v1:${value.sellerId}`));
    decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    const snapshot = JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]).toString()) as SellerSnapshot;
    if (snapshot.version !== 1 || snapshot.sellerId !== value.sellerId || !snapshot.artifacts || typeof snapshot.artifacts !== "object" || FILES.some((name) => typeof snapshot.files?.[name] !== "string")) fail("SELLER_STATE_INVALID", "seller snapshot contents are invalid");
    return snapshot;
  } catch (error) { return fail("SELLER_STATE_DECRYPT_FAILED", "seller snapshot could not be authenticated", error); }
}

export async function captureSellerHome(home: string, sellerId: string, artifacts: Record<string, string> = {}): Promise<SellerSnapshot> {
  const db = new DatabaseSync(join(home, "state.sqlite"), { readOnly: true });
  const temporary = join(home, `snapshot-${randomBytes(8).toString("hex")}.sqlite`);
  try {
    await backup(db, temporary);
    const files = {} as SellerSnapshot["files"];
    for (const name of FILES) files[name] = readFileSync(name === "state.sqlite" ? temporary : join(home, name)).toString("base64url");
    return { version: 1, sellerId, files, artifacts };
  } finally { db.close(); if (existsSync(temporary)) { const { unlinkSync } = await import("node:fs"); unlinkSync(temporary); } }
}

export function restoreSellerHome(home: string, snapshot: SellerSnapshot): void {
  if (!snapshot.sellerId || snapshot.version !== 1) fail("SELLER_STATE_INVALID", "seller snapshot identity is invalid");
  mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700);
  for (const name of FILES) writeFileSync(join(home, name), Buffer.from(snapshot.files[name], "base64url"), { mode: 0o600, flag: "wx" });
}
