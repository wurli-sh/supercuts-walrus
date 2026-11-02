pragma circom 2.2.3;

include "lib/statement_digest.circom";
include "lib/protocol_v2.circom";

// A relayer can submit this proof. The proof binds the payout, exit amount,
// consumed note and private change to the same current tree transition.
template WithdrawV2(depth) {
    signal input statement[291];
    signal input digestHigh;
    signal input digestLow;
    signal input ownerAx;
    signal input ownerAy;
    signal input inputAmount;
    signal input spendSecret;
    signal input salt;
    signal input leafIndex;
    signal input pathElements[depth];
    signal input changeAmount;
    signal input changeSpendSecret;
    signal input changeSalt;
    signal input appendSiblings[depth];

    component digest = StatementDigest(291);
    for (var i = 0; i < 291; i++) digest.statement[i] <== statement[i];
    digest.digestHigh <== digestHigh;
    digest.digestLow <== digestLow;
    component header = StatementHeader(3);
    for (var i = 0; i < 106; i++) header.statement[i] <== statement[i];
    component root = DecodeField(291, 106);
    component nullifier = DecodeField(291, 138);
    component amount = DecodeU64(291, 202);
    component changeCommitment = DecodeField(291, 211);
    component oldIndex = DecodeU64(291, 243);
    component newRoot = DecodeField(291, 251);
    component newIndex = DecodeU64(291, 283);
    for (var i = 0; i < 291; i++) {
        root.statement[i] <== statement[i];
        nullifier.statement[i] <== statement[i];
        amount.statement[i] <== statement[i];
        changeCommitment.statement[i] <== statement[i];
        oldIndex.statement[i] <== statement[i];
        newRoot.statement[i] <== statement[i];
        newIndex.statement[i] <== statement[i];
    }
    component amountZero = IsZero(); amountZero.in <== amount.value; amountZero.out === 0;
    component secretZero = IsZero(); secretZero.in <== spendSecret; secretZero.out === 0;
    component changeSecretZero = IsZero(); changeSecretZero.in <== changeSpendSecret; changeSecretZero.out === 0;
    component inputRange = Num2Bits(64); inputRange.in <== inputAmount;
    component changeRange = Num2Bits(64); changeRange.in <== changeAmount;
    inputAmount === amount.value + changeAmount;
    // mode 0 is the standard 1,000,000 MIST exit; mode 1 reveals an exact exit.
    signal exactExit;
    exactExit <== statement[210];
    exactExit * (exactExit - 1) === 0;
    (1 - exactExit) * (amount.value - 1000000) === 0;
    newIndex.value === oldIndex.value + 1;
    component recipientHi = BytesToNum(16);
    component recipientLo = BytesToNum(16);
    for (var i = 0; i < 16; i++) {
        recipientHi.bytes[i] <== statement[170 + i];
        recipientLo.bytes[i] <== statement[186 + i];
    }
    component recipientHiRange = Num2Bits(128); recipientHiRange.in <== recipientHi.value;
    component recipientLoRange = Num2Bits(128); recipientLoRange.in <== recipientLo.value;
    component spendTag = Poseidon(2);
    spendTag.inputs[0] <== 2006;
    spendTag.inputs[1] <== spendSecret;
    component note = Poseidon(7);
    note.inputs[0] <== 2010;
    note.inputs[1] <== header.deployment;
    note.inputs[2] <== inputAmount;
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
    component changeTag = Poseidon(2);
    changeTag.inputs[0] <== 2006;
    changeTag.inputs[1] <== changeSpendSecret;
    component change = Poseidon(7);
    change.inputs[0] <== 2010;
    change.inputs[1] <== header.deployment;
    change.inputs[2] <== changeAmount;
    change.inputs[3] <== ownerAx;
    change.inputs[4] <== ownerAy;
    change.inputs[5] <== changeTag.out;
    change.inputs[6] <== changeSalt;
    change.out === changeCommitment.value;
    component append = MerkleAppend(depth);
    append.oldRoot <== root.value;
    append.index <== oldIndex.value;
    append.leaf <== change.out;
    for (var i = 0; i < depth; i++) append.siblings[i] <== appendSiblings[i];
    append.resultingRoot === newRoot.value;
}

component main {public [digestHigh, digestLow]} = WithdrawV2(20);
