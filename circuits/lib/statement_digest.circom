pragma circom 2.2.3;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/sha256/sha256.circom";

/// SHA-256 over fixed-width bytes. Bytes are constrained to 8 bits. Circomlib's
/// SHA input is network bit order, while Num2Bits emits least-significant first.
template StatementDigest(nBytes) {
    signal input statement[nBytes];
    signal input digestHigh;
    signal input digestLow;

    component byteBits[nBytes];
    component sha = Sha256(nBytes * 8);
    for (var i = 0; i < nBytes; i++) {
        byteBits[i] = Num2Bits(8);
        byteBits[i].in <== statement[i];
        for (var bit = 0; bit < 8; bit++) {
            sha.in[i * 8 + bit] <== byteBits[i].out[7 - bit];
        }
    }

    var high = 0;
    var low = 0;
    for (var bit = 0; bit < 128; bit++) {
        high = high * 2 + sha.out[bit];
        low = low * 2 + sha.out[128 + bit];
    }
    digestHigh === high;
    digestLow === low;
}

