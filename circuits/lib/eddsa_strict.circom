pragma circom 2.2.3;

// Adapted from reference-shii/circuits/m5/lib/eddsa_strict.circom (Apache-2.0).
include "circomlib/circuits/eddsaposeidon.circom";
include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/escalarmulany.circom";
include "circomlib/circuits/bitify.circom";

template SubgroupCheck() {
    signal input p[2];
    signal output ok;
    component mul = EscalarMulAny(254);
    var value = 2736030358979909402780800718157159386076813972158567259200215660948447373041;
    for (var i = 0; i < 254; i++) {
        if ((value >> i) & 1 == 1) mul.e[i] <== 1;
        else mul.e[i] <== 0;
    }
    mul.p[0] <== p[0];
    mul.p[1] <== p[1];
    component xZero = IsZero();
    xZero.in <== mul.out[0];
    component yOne = IsEqual();
    yOne.in[0] <== mul.out[1];
    yOne.in[1] <== 1;
    ok <== xZero.out * yOne.out;
    ok === 1;
}

template EddsaStrictVerifier() {
    signal input enabled;
    signal input Ax;
    signal input Ay;
    signal input R8x;
    signal input R8y;
    signal input S;
    signal input M;
    component verifier = EdDSAPoseidonVerifier();
    verifier.enabled <== enabled;
    verifier.Ax <== Ax;
    verifier.Ay <== Ay;
    verifier.R8x <== R8x;
    verifier.R8y <== R8y;
    verifier.S <== S;
    verifier.M <== M;
    component checkA = BabyCheck();
    checkA.x <== Ax;
    checkA.y <== Ay;
    component checkR8 = BabyCheck();
    checkR8.x <== R8x;
    checkR8.y <== R8y;
    component subgroupA = SubgroupCheck();
    subgroupA.p[0] <== Ax;
    subgroupA.p[1] <== Ay;
    component subgroupR8 = SubgroupCheck();
    subgroupR8.p[0] <== R8x;
    subgroupR8.p[1] <== R8y;
    component sZero = IsZero();
    sZero.in <== S;
    sZero.out === 0;
}

