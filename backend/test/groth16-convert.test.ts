import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { convertGroth16, encodeG1 } from "../src/groth16-convert.js";

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/groth16",
);

for (const circuit of ["deposit_v2", "transfer_v2", "withdraw_v2"]) {
  const dir = join(root, circuit);
  test(
    `TypeScript converter matches the Arkworks vectors for ${circuit}`,
    {
      skip:
        !existsSync(join(dir, "proof.bin")) &&
        "circuit build vectors are not present",
    },
    () => {
      const out = mkdtempSync(join(tmpdir(), "supercuts-convert-"));
      convertGroth16(
        join(dir, "verification-key.json"),
        join(dir, "proof.json"),
        join(dir, "public.json"),
        out,
      );
      for (const file of [
        "verifying-key.bin",
        "proof.bin",
        "public-inputs.bin",
      ])
        assert.deepEqual(
          readFileSync(join(out, file)),
          readFileSync(join(dir, file)),
          file,
        );
    },
  );
}

test("converter rejects malformed points instead of encoding them", () => {
  assert.throws(() => encodeG1(["1", "2", "5"]), /affine/);
  assert.throws(() => encodeG1(["0", "0", "1"]), /infinity/);
  assert.throws(() => encodeG1(["x", "2", "1"]), /decimal/);
  assert.throws(() => encodeG1([(2n ** 254n).toString(), "2", "1"]), /outside/);
});
