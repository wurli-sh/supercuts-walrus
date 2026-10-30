#[test_only]
module supercuts_pool::statement_tests;

use std::hash;
use supercuts_pool::pool;

public struct TEST has drop {}

fun repeated(byte: u8): vector<u8> {
    let mut result = vector[];
    let mut i = 0u64;
    while (i < 32) { result.push_back(byte); i = i + 1 };
    result
}

#[test]
fun digest_limb_encoding_matches_rust() {
    let digest = x"448934bfc2b0bba6dcf39f9fcaacf0e7d42cfed555427bd674a797313feec7b8";
    assert!(pool::digest_public_inputs(&digest) == x"e7f0acca9f9ff3dca6bbb0c2bf34894400000000000000000000000000000000b8c7ee3f3197a774d67b4255d5fe2cd400000000000000000000000000000000");
}

#[test]
fun complete_vectors_match_rust() {
    let deposit = pool::encode_deposit(
        &repeated(0x11), &repeated(0x22), &repeated(0x33), 1, 100,
        &repeated(0x44), &repeated(0x55), 0, &repeated(0x66), 1,
    );
    assert!(hash::sha2_256(deposit) == x"448934bfc2b0bba6dcf39f9fcaacf0e7d42cfed555427bd674a797313feec7b8");

    let transfer = pool::encode_transfer(
        &repeated(0x11), &repeated(0x22), &repeated(0x33), 1,
        &repeated(0x44), &repeated(0x45), &repeated(0x46), &repeated(0x47),
        &repeated(0x48), 1900000000000, &repeated(0x55), 1, &repeated(0x66), 3,
    );
    assert!(hash::sha2_256(transfer) == x"1278a4506a4ea9285bd36179bacb5c8f0109b54ddc7d2493b7ad77862034ecd0");

    let withdraw = pool::encode_withdraw(
        &repeated(0x11), &repeated(0x22), &repeated(0x33), 1,
        &repeated(0x55), &repeated(0x46), @0x7777777777777777777777777777777777777777777777777777777777777777, 60,
    );
    assert!(hash::sha2_256(withdraw) == x"58d50fd516eba11b7d30d4eaae0d3be41ce4cec60195daf3177d27709c978f05");
}

#[test]
fun statements_have_frozen_lengths() {
    let mut ctx = tx_context::dummy();
    let pool = pool::new_for_testing<TEST>(repeated(0x11), repeated(0x55), &mut ctx);
    let deposit = pool::deposit_statement(&pool, 100, &repeated(0x44), &repeated(0x66), 1);
    let transfer = pool::transfer_statement(
        &pool, &repeated(0x44), &repeated(0x45), &repeated(0x46),
        &repeated(0x47), &repeated(0x48), 1900000000000, &repeated(0x66), 2,
    );
    let withdraw = pool::withdraw_statement(&pool, &repeated(0x55), &repeated(0x46), @0x77, 60);
    assert!(deposit.length() == 226);
    assert!(transfer.length() == 354);
    assert!(withdraw.length() == 210);
    assert!(hash::sha2_256(deposit).length() == 32);
    pool::destroy_for_testing(pool)
}

#[test, expected_failure(abort_code = 0, location = supercuts_pool::pool)]
fun malformed_digest_rejected() {
    pool::digest_public_inputs(&vector[1, 2, 3]);
}

