pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

template BytesToNum(n) {
    signal input bytes[n];
    signal output value;
    var acc = 0;
    for (var i = 0; i < n; i++) acc = acc * 256 + bytes[i];
    value <== acc;
}

template StatementHeader(kind) {
    signal input statement[106];
    signal output deployment;
    signal output verifierVersion;
    statement[0] === 83;
    statement[1] === 67;
    statement[2] === 85;
    statement[3] === 84;
    statement[4] === 1;
    statement[5] === kind;
    component limbs[6];
    component limbRange[6];
    for (var limb = 0; limb < 6; limb++) {
        limbs[limb] = BytesToNum(16);
        for (var i = 0; i < 16; i++) limbs[limb].bytes[i] <== statement[6 + limb * 16 + i];
        limbRange[limb] = Num2Bits(128);
        limbRange[limb].in <== limbs[limb].value;
    }
    component version = BytesToNum(4);
    for (var i = 0; i < 4; i++) version.bytes[i] <== statement[102 + i];
    component versionRange = Num2Bits(32);
    versionRange.in <== version.value;
    component versionZero = IsZero();
    versionZero.in <== version.value;
    versionZero.out === 0;
    component domainHash = Poseidon(8);
    domainHash.inputs[0] <== 2100;
    for (var i = 0; i < 6; i++) domainHash.inputs[i + 1] <== limbs[i].value;
    domainHash.inputs[7] <== version.value;
    deployment <== domainHash.out;
    verifierVersion <== version.value;
}

template MerkleRoot(depth) {
    signal input leaf;
    signal input siblings[depth];
    signal input index;
    signal output root;
    component bits = Num2Bits(depth);
    bits.in <== index;
    signal nodes[depth + 1];
    component branch[depth];
    nodes[0] <== leaf;
    for (var i = 0; i < depth; i++) {
        branch[i] = Poseidon(2);
        branch[i].inputs[0] <== nodes[i] + bits.out[i] * (siblings[i] - nodes[i]);
        branch[i].inputs[1] <== siblings[i] + bits.out[i] * (nodes[i] - siblings[i]);
        nodes[i + 1] <== branch[i].out;
    }
    root <== nodes[depth];
}

template MerkleAppend(depth) {
    signal input oldRoot;
    signal input index;
    signal input leaf;
    signal input siblings[depth];
    signal output resultingRoot;
    component empty = MerkleRoot(depth);
    component filled = MerkleRoot(depth);
    empty.leaf <== 0;
    empty.index <== index;
    filled.leaf <== leaf;
    filled.index <== index;
    for (var i = 0; i < depth; i++) {
        empty.siblings[i] <== siblings[i];
        filled.siblings[i] <== siblings[i];
    }
    empty.root === oldRoot;
    resultingRoot <== filled.root;
}

template DecodeField(statementLength, offset) {
    signal input statement[statementLength];
    signal output value;
    component decoded = BytesToNum(32);
    component canonical = CanonicalBn254Scalar();
    for (var i = 0; i < 32; i++) decoded.bytes[i] <== statement[offset + i];
    for (var i = 0; i < 32; i++) canonical.bytes[i] <== statement[offset + i];
    value <== decoded.value;
}

/// A statement encodes field elements as 32-byte big-endian values.  Merely
/// decoding them into a Circom signal would admit values congruent modulo the
/// BN254 scalar modulus.  Subtract the modulus byte by byte and require a
/// final borrow, which proves the original byte string is strictly smaller.
template CanonicalBn254Scalar() {
    signal input bytes[32];
    signal borrows[33];
    signal differences[32];
    component byteRanges[32];
    component differenceRanges[32];
    component underflows[32];
    var modulus[32] = [
        48, 100, 78, 114, 225, 49, 160, 41,
        184, 80, 69, 182, 129, 129, 88, 93,
        151, 129, 106, 145, 104, 113, 202, 141,
        60, 32, 140, 22, 216, 124, 253, 71
    ];
    borrows[32] <== 0;
    for (var offset = 0; offset < 32; offset++) {
        var i = 31 - offset;
        byteRanges[i] = Num2Bits(8);
        differenceRanges[i] = Num2Bits(8);
        underflows[i] = LessThan(9);
        byteRanges[i].in <== bytes[i];
        underflows[i].in[0] <== bytes[i];
        underflows[i].in[1] <== modulus[i] + borrows[i + 1];
        borrows[i] <== underflows[i].out;
        differences[i] <== bytes[i] - modulus[i] - borrows[i + 1] + 256 * borrows[i];
        differenceRanges[i].in <== differences[i];
    }
    borrows[0] === 1;
}

template DecodeU64(statementLength, offset) {
    signal input statement[statementLength];
    signal output value;
    component decoded = BytesToNum(8);
    for (var i = 0; i < 8; i++) decoded.bytes[i] <== statement[offset + i];
    component range = Num2Bits(64);
    range.in <== decoded.value;
    value <== decoded.value;
}

