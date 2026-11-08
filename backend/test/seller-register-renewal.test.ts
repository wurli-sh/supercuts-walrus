import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkRegistrationOutput, writeRegistration } from "../src/seller-register.js";

const registration = (capabilityId: string, expiresAt: number) => ({ manifest: { capabilityId, expiresAt }, manifestBlobId: "blob" });

test("a new registration file is created owner-only", () => {
  const out = join(mkdtempSync(join(tmpdir(), "supercuts-reg-")), "registration.json");
  assert.deepEqual(checkRegistrationOutput(out, "cap-a"), { renewing: false });
  writeRegistration(out, registration("cap-a", 1), false);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).manifest.capabilityId, "cap-a");
  assert.equal(statSync(out).mode & 0o777, 0o600);
});

test("re-registering the same capability renews it and keeps the previous registration", () => {
  const out = join(mkdtempSync(join(tmpdir(), "supercuts-reg-")), "registration.json");
  writeFileSync(out, JSON.stringify(registration("cap-a", 1)), { mode: 0o600 });
  assert.deepEqual(checkRegistrationOutput(out, "cap-a"), { renewing: true });
  writeRegistration(out, registration("cap-a", 2), true);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).manifest.expiresAt, 2);
  assert.equal(JSON.parse(readFileSync(`${out}.previous`, "utf8")).manifest.expiresAt, 1);
  assert.equal(statSync(out).mode & 0o777, 0o600);
});

test("an output file for another capability or unreadable content is refused before publishing", () => {
  const out = join(mkdtempSync(join(tmpdir(), "supercuts-reg-")), "registration.json");
  writeFileSync(out, JSON.stringify(registration("cap-b", 1)), { mode: 0o600 });
  assert.throws(() => checkRegistrationOutput(out, "cap-a"), (error: Error & { code?: string }) => error.code === "REGISTRATION_EXISTS" && /cap-b/.test(error.message));
  writeFileSync(out, "not json", { mode: 0o600 });
  assert.throws(() => checkRegistrationOutput(out, "cap-a"), (error: Error & { code?: string }) => error.code === "REGISTRATION_EXISTS");
});
