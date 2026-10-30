pragma circom 2.2.3;

include "lib/statement_digest.circom";
include "lib/protocol.circom";

template Withdraw(depth) {
    signal input statement[210];
    signal input digestHigh;
    signal input digestLow;
    signal input ownerAx;
    signal input ownerAy;
    signal input spendSecret;
    signal input salt;
    signal input leafIndex;
    signal input pathElements[depth];
    component digest = StatementDigest(210);
    for (var i = 0; i < 210; i++) digest.statement[i] <== statement[i];
    digest.digestHigh <== digestHigh;
    digest.digestLow <== digestLow;
    component header = StatementHeader(3);
    for (var i = 0; i < 106; i++) header.statement[i] <== statement[i];
    component root = DecodeField(210, 106);
    component nullifier = DecodeField(210, 138);
    component recipientHi = BytesToNum(16);
    component recipientLo = BytesToNum(16);
    for (var i = 0; i < 16; i++) {
        recipientHi.bytes[i] <== statement[170 + i];
        recipientLo.bytes[i] <== statement[186 + i];
    }
    component amount = DecodeU64(210, 202);
    for (var i = 0; i < 210; i++) {
        root.statement[i] <== statement[i];
        nullifier.statement[i] <== statement[i];
        amount.statement[i] <== statement[i];
    }
    component amountZero = IsZero(); amountZero.in <== amount.value; amountZero.out === 0;
    component secretZero = IsZero(); secretZero.in <== spendSecret; secretZero.out === 0;
    component leafRange = Num2Bits(depth); leafRange.in <== leafIndex;
    component spendTag = Poseidon(2);
    spendTag.inputs[0] <== 2006;
    spendTag.inputs[1] <== spendSecret;
    component note = Poseidon(7);
    note.inputs[0] <== 2010;
    note.inputs[1] <== header.deployment;
    note.inputs[2] <== amount.value;
    note.inputs[3] <== ownerAx;
    note.inputs[4] <== ownerAy;
    note.inputs[5] <== spendTag.out;
    note.inputs[6] <== salt;
    component noteNull = Poseidon(4);
    noteNull.inputs[0] <== 2011;
    noteNull.inputs[1] <== header.deployment;
    noteNull.inputs[2] <== spendSecret;
    noteNull.inputs[3] <== note.out;
    noteNull.out === nullifier.value;
    component membership = MerkleRoot(depth);
    membership.leaf <== note.out;
    membership.index <== leafIndex;
    for (var i = 0; i < depth; i++) membership.siblings[i] <== pathElements[i];
    membership.root === root.value;
    component recipientHiRange = Num2Bits(128); recipientHiRange.in <== recipientHi.value;
    component recipientLoRange = Num2Bits(128); recipientLoRange.in <== recipientLo.value;
}

component main {public [digestHigh, digestLow]} = Withdraw(20);

