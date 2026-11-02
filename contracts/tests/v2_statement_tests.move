#[test_only]
module supercuts_pool::v2_statement_tests;

use std::hash;
use supercuts_pool::pool_v2;

fun repeated(byte: u8): vector<u8> {
    let mut result = vector[];
    let mut i = 0u64;
    while (i < 32) { result.push_back(byte); i = i + 1 };
    result
}

#[test]
fun withdrawal_encoding_matches_rust() {
    let statement = pool_v2::encode_withdraw(
        &repeated(0x11), &repeated(0x22), &repeated(0x33), 2,
        &repeated(0x55), &repeated(0x46),
        @0x7777777777777777777777777777777777777777777777777777777777777777,
        1000000, false, &repeated(0x88), 7, &repeated(0x99), 8,
    );
    assert!(statement.length() == 291);
    assert!(hash::sha2_256(statement) == x"988bb3b3d05a876c244f0be7728e262f2d38ea6dd2f8972237a590546004522b");
}
