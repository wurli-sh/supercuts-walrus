pragma circom 2.2.3;

include "lib/statement_digest.circom";
include "lib/protocol_v2.circom";

template Deposit(depth) {
    signal input statement[226];
    signal input digestHigh;
    signal input digestLow;
    signal input ownerAx;
    signal input ownerAy;
    signal input spendSecret;
    signal input salt;
    signal input appendSiblings[depth];
    component digest = StatementDigest(226);
    for (var i = 0; i < 226; i++) digest.statement[i] <== statement[i];
    digest.digestHigh <== digestHigh;
    digest.digestLow <== digestLow;
    component header = StatementHeader(1);
    for (var i = 0; i < 106; i++) header.statement[i] <== statement[i];
    component amount = DecodeU64(226, 106);
    component noteCommitment = DecodeField(226, 114);
    component oldRoot = DecodeField(226, 146);
    component oldIndex = DecodeU64(226, 178);
    component newRoot = DecodeField(226, 186);
    component newIndex = DecodeU64(226, 218);
    for (var i = 0; i < 226; i++) {
        amount.statement[i] <== statement[i];
        noteCommitment.statement[i] <== statement[i];
        oldRoot.statement[i] <== statement[i];
        oldIndex.statement[i] <== statement[i];
        newRoot.statement[i] <== statement[i];
        newIndex.statement[i] <== statement[i];
    }
    component amountZero = IsZero(); amountZero.in <== amount.value; amountZero.out === 0;
    component secretZero = IsZero(); secretZero.in <== spendSecret; secretZero.out === 0;
    newIndex.value === oldIndex.value + 1;
    component indexRange = Num2Bits(depth); indexRange.in <== oldIndex.value;
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
    note.out === noteCommitment.value;
    component append = MerkleAppend(depth);
    append.oldRoot <== oldRoot.value;
    append.index <== oldIndex.value;
    append.leaf <== note.out;
    for (var i = 0; i < depth; i++) append.siblings[i] <== appendSiblings[i];
    append.resultingRoot === newRoot.value;
}

component main {public [digestHigh, digestLow]} = Deposit(20);
