module supercuts_audit_policy::auditor;

use std::bcs;

const E_NOT_DESIGNATED_AUDITOR: u64 = 0;

/// Seal calls this entry function while evaluating a decryption request. The
/// encrypted object's identity is the BCS-encoded address of its sole auditor.
entry fun seal_approve(id: vector<u8>, ctx: &TxContext) {
    assert!(is_designated_auditor(&id, ctx.sender()), E_NOT_DESIGNATED_AUDITOR)
}

public fun is_designated_auditor(id: &vector<u8>, sender: address): bool {
    *id == bcs::to_bytes(&sender)
}

#[test]
fun accepts_exact_auditor() {
    let auditor = @0x66;
    assert!(is_designated_auditor(&bcs::to_bytes(&auditor), auditor));
}

#[test]
fun rejects_other_auditor() {
    let auditor = @0x66;
    let outsider = @0x77;
    assert!(!is_designated_auditor(&bcs::to_bytes(&auditor), outsider));
}
