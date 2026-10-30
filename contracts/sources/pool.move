module supercuts_pool::pool;

use std::bcs;
use std::hash;
use std::type_name;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::groth16::{Self, PreparedVerifyingKey};
use sui::table::{Self, Table};

const E_BAD_LENGTH: u64 = 0;
const E_BAD_AMOUNT: u64 = 1;
const E_ROOT_MISMATCH: u64 = 2;
const E_INDEX_MISMATCH: u64 = 3;
const E_TREE_EXHAUSTED: u64 = 4;
const E_PROOF_INVALID: u64 = 5;
const E_NOTE_SPENT: u64 = 6;
const E_DEAL_CONSUMED: u64 = 7;
const E_EXPIRED: u64 = 8;
const E_ROOT_UNKNOWN: u64 = 9;
const E_BAD_TRANSITION: u64 = 10;

const STATEMENT_VERSION: u8 = 1;
const KIND_DEPOSIT: u8 = 1;
const KIND_TRANSFER: u8 = 2;
const KIND_WITHDRAW: u8 = 3;
const TREE_CAPACITY: u64 = 1048576;

public struct Pool<phantom T> has key {
    id: UID,
    custody: Balance<T>,
    domain: vector<u8>,
    coin_type_hash: vector<u8>,
    verifier_version: u32,
    root: vector<u8>,
    next_leaf: u64,
    accepted_roots: Table<vector<u8>, bool>,
    spent_notes: Table<vector<u8>, bool>,
    consumed_deals: Table<vector<u8>, bool>,
    deposit_vk: PreparedVerifyingKey,
    transfer_vk: PreparedVerifyingKey,
    withdraw_vk: PreparedVerifyingKey,
}

public struct DepositEvent has copy, drop {
    old_root: vector<u8>,
    new_root: vector<u8>,
    leaf_index: u64,
    note_commitment: vector<u8>,
}

public struct TransferEvent has copy, drop {
    old_root: vector<u8>,
    new_root: vector<u8>,
    first_leaf_index: u64,
    deal_commitment: vector<u8>,
    deal_nullifier: vector<u8>,
    input_nullifier: vector<u8>,
    payment_commitment: vector<u8>,
    change_commitment: vector<u8>,
}

public struct WithdrawEvent has copy, drop {
    root: vector<u8>,
    note_nullifier: vector<u8>,
    recipient: address,
    amount: u64,
}

/// Creates one immutable-verifier pool. The creator chooses the keys once; callers
/// cannot replace them in a settlement call. `domain` and `initial_root` are 32 bytes.
public fun create<T>(
    domain: vector<u8>,
    initial_root: vector<u8>,
    verifier_version: u32,
    deposit_verifying_key: vector<u8>,
    transfer_verifying_key: vector<u8>,
    withdraw_verifying_key: vector<u8>,
    ctx: &mut TxContext,
) {
    assert_32(&domain);
    assert_32(&initial_root);
    assert!(verifier_version > 0, E_BAD_TRANSITION);
    let curve = groth16::bn254();
    let deposit_vk = groth16::prepare_verifying_key(&curve, &deposit_verifying_key);
    let transfer_vk = groth16::prepare_verifying_key(&curve, &transfer_verifying_key);
    let withdraw_vk = groth16::prepare_verifying_key(&curve, &withdraw_verifying_key);
    let mut accepted_roots = table::new(ctx);
    accepted_roots.add(copy initial_root, true);
    let pool = Pool<T> {
        id: object::new(ctx),
        custody: balance::zero(),
        domain,
        coin_type_hash: coin_type_hash<T>(),
        verifier_version,
        root: initial_root,
        next_leaf: 0,
        accepted_roots,
        spent_notes: table::new(ctx),
        consumed_deals: table::new(ctx),
        deposit_vk,
        transfer_vk,
        withdraw_vk,
    };
    transfer::share_object(pool)
}

public fun deposit<T>(
    pool: &mut Pool<T>,
    coin: Coin<T>,
    note_commitment: vector<u8>,
    new_root: vector<u8>,
    new_index: u64,
    proof: vector<u8>,
) {
    assert_32(&note_commitment);
    assert_32(&new_root);
    let amount = coin.value();
    assert!(amount > 0, E_BAD_AMOUNT);
    assert!(pool.next_leaf < TREE_CAPACITY, E_TREE_EXHAUSTED);
    assert!(new_index == pool.next_leaf + 1, E_BAD_TRANSITION);
    let statement = deposit_statement(pool, amount, &note_commitment, &new_root, new_index);
    verify(&pool.deposit_vk, statement, proof);
    let old_root = pool.root;
    let leaf_index = pool.next_leaf;
    pool.custody.join(coin.into_balance());
    advance(pool, copy new_root, new_index);
    event::emit(DepositEvent { old_root, new_root, leaf_index, note_commitment })
}

public fun transfer_private<T>(
    pool: &mut Pool<T>,
    clock: &Clock,
    deal_commitment: vector<u8>,
    deal_nullifier: vector<u8>,
    input_nullifier: vector<u8>,
    payment_commitment: vector<u8>,
    change_commitment: vector<u8>,
    expiry_ms: u64,
    new_root: vector<u8>,
    new_index: u64,
    proof: vector<u8>,
) {
    assert_32(&deal_commitment);
    assert_32(&deal_nullifier);
    assert_32(&input_nullifier);
    assert_32(&payment_commitment);
    assert_32(&change_commitment);
    assert_32(&new_root);
    assert!(clock.timestamp_ms() < expiry_ms, E_EXPIRED);
    assert!(pool.next_leaf <= TREE_CAPACITY - 2, E_TREE_EXHAUSTED);
    assert!(new_index == pool.next_leaf + 2, E_BAD_TRANSITION);
    assert!(!pool.consumed_deals.contains(copy deal_nullifier), E_DEAL_CONSUMED);
    assert!(!pool.spent_notes.contains(copy input_nullifier), E_NOTE_SPENT);
    let statement = transfer_statement(
        pool, &deal_commitment, &deal_nullifier, &input_nullifier,
        &payment_commitment, &change_commitment, expiry_ms, &new_root, new_index,
    );
    verify(&pool.transfer_vk, statement, proof);
    let old_root = pool.root;
    let first_leaf_index = pool.next_leaf;
    pool.consumed_deals.add(copy deal_nullifier, true);
    pool.spent_notes.add(copy input_nullifier, true);
    advance(pool, copy new_root, new_index);
    event::emit(TransferEvent {
        old_root, new_root, first_leaf_index, deal_commitment, deal_nullifier,
        input_nullifier, payment_commitment, change_commitment,
    })
}

public fun withdraw<T>(
    pool: &mut Pool<T>,
    root: vector<u8>,
    note_nullifier: vector<u8>,
    recipient: address,
    amount: u64,
    proof: vector<u8>,
    ctx: &mut TxContext,
) {
    assert_32(&root);
    assert_32(&note_nullifier);
    assert!(amount > 0, E_BAD_AMOUNT);
    assert!(pool.accepted_roots.contains(copy root), E_ROOT_UNKNOWN);
    assert!(!pool.spent_notes.contains(copy note_nullifier), E_NOTE_SPENT);
    let statement = withdraw_statement(pool, &root, &note_nullifier, recipient, amount);
    verify(&pool.withdraw_vk, statement, proof);
    pool.spent_notes.add(copy note_nullifier, true);
    let payment = coin::from_balance(pool.custody.split(amount), ctx);
    transfer::public_transfer(payment, recipient);
    event::emit(WithdrawEvent { root, note_nullifier, recipient, amount })
}

fun verify(vk: &PreparedVerifyingKey, statement: vector<u8>, proof: vector<u8>) {
    let digest = hash::sha2_256(statement);
    let inputs = digest_public_inputs(&digest);
    let public_inputs = groth16::public_proof_inputs_from_bytes(inputs);
    let proof_points = groth16::proof_points_from_bytes(proof);
    assert!(groth16::verify_groth16_proof(&groth16::bn254(), vk, &public_inputs, &proof_points), E_PROOF_INVALID)
}

fun advance<T>(pool: &mut Pool<T>, new_root: vector<u8>, new_index: u64) {
    assert!(pool.root.length() == 32, E_ROOT_MISMATCH);
    assert!(pool.next_leaf < new_index, E_INDEX_MISMATCH);
    pool.root = copy new_root;
    pool.next_leaf = new_index;
    if (!pool.accepted_roots.contains(copy new_root)) pool.accepted_roots.add(new_root, true)
}

fun common_values(
    kind: u8, domain: &vector<u8>, pool_id: &vector<u8>,
    coin_type_hash: &vector<u8>, verifier_version: u32,
): vector<u8> {
    assert_32(domain);
    assert_32(pool_id);
    assert_32(coin_type_hash);
    let mut bytes = b"SCUT";
    bytes.push_back(STATEMENT_VERSION);
    bytes.push_back(kind);
    bytes.append(*domain);
    bytes.append(*pool_id);
    bytes.append(*coin_type_hash);
    append_u32_be(&mut bytes, verifier_version);
    bytes
}

public fun deposit_statement<T>(
    pool: &Pool<T>, amount: u64, note_commitment: &vector<u8>,
    new_root: &vector<u8>, new_index: u64,
): vector<u8> {
    encode_deposit(
        &pool.domain, &object::id_bytes(pool), &pool.coin_type_hash, pool.verifier_version,
        amount, note_commitment, &pool.root, pool.next_leaf, new_root, new_index,
    )
}

public fun encode_deposit(
    domain: &vector<u8>, pool_id: &vector<u8>, coin_type_hash: &vector<u8>,
    verifier_version: u32, amount: u64, note_commitment: &vector<u8>,
    old_root: &vector<u8>, old_index: u64, new_root: &vector<u8>, new_index: u64,
): vector<u8> {
    let mut bytes = common_values(KIND_DEPOSIT, domain, pool_id, coin_type_hash, verifier_version);
    append_u64_be(&mut bytes, amount);
    bytes.append(*note_commitment);
    append_transition(&mut bytes, old_root, old_index, new_root, new_index);
    bytes
}

public fun transfer_statement<T>(
    pool: &Pool<T>, deal_commitment: &vector<u8>, deal_nullifier: &vector<u8>,
    input_nullifier: &vector<u8>, payment_commitment: &vector<u8>,
    change_commitment: &vector<u8>, expiry_ms: u64,
    new_root: &vector<u8>, new_index: u64,
): vector<u8> {
    encode_transfer(
        &pool.domain, &object::id_bytes(pool), &pool.coin_type_hash, pool.verifier_version,
        deal_commitment, deal_nullifier, input_nullifier, payment_commitment,
        change_commitment, expiry_ms, &pool.root, pool.next_leaf, new_root, new_index,
    )
}

public fun encode_transfer(
    domain: &vector<u8>, pool_id: &vector<u8>, coin_type_hash: &vector<u8>,
    verifier_version: u32, deal_commitment: &vector<u8>, deal_nullifier: &vector<u8>,
    input_nullifier: &vector<u8>, payment_commitment: &vector<u8>,
    change_commitment: &vector<u8>, expiry_ms: u64, old_root: &vector<u8>,
    old_index: u64, new_root: &vector<u8>, new_index: u64,
): vector<u8> {
    let mut bytes = common_values(KIND_TRANSFER, domain, pool_id, coin_type_hash, verifier_version);
    bytes.append(*deal_commitment);
    bytes.append(*deal_nullifier);
    bytes.append(*input_nullifier);
    bytes.append(*payment_commitment);
    bytes.append(*change_commitment);
    append_u64_be(&mut bytes, expiry_ms);
    append_transition(&mut bytes, old_root, old_index, new_root, new_index);
    bytes
}

public fun withdraw_statement<T>(
    pool: &Pool<T>, root: &vector<u8>, note_nullifier: &vector<u8>,
    recipient: address, amount: u64,
): vector<u8> {
    encode_withdraw(
        &pool.domain, &object::id_bytes(pool), &pool.coin_type_hash, pool.verifier_version,
        root, note_nullifier, recipient, amount,
    )
}

public fun encode_withdraw(
    domain: &vector<u8>, pool_id: &vector<u8>, coin_type_hash: &vector<u8>,
    verifier_version: u32, root: &vector<u8>, note_nullifier: &vector<u8>,
    recipient: address, amount: u64,
): vector<u8> {
    let mut bytes = common_values(KIND_WITHDRAW, domain, pool_id, coin_type_hash, verifier_version);
    bytes.append(*root);
    bytes.append(*note_nullifier);
    let recipient_bytes = bcs::to_bytes(&recipient);
    assert!(recipient_bytes.length() == 32, E_BAD_LENGTH);
    bytes.append(recipient_bytes);
    append_u64_be(&mut bytes, amount);
    bytes
}

public fun digest_public_inputs(digest: &vector<u8>): vector<u8> {
    assert!(digest.length() == 32, E_BAD_LENGTH);
    let mut result = vector[];
    let mut half = 0;
    while (half < 2) {
        let mut index = 16;
        while (index > 0) {
            index = index - 1;
            result.push_back(digest[half * 16 + index]);
        };
        let mut padding = 0u64;
        while (padding < 16) { result.push_back(0); padding = padding + 1 };
        half = half + 1;
    };
    result
}

fun append_transition(
    bytes: &mut vector<u8>, old_root: &vector<u8>, old_index: u64,
    new_root: &vector<u8>, new_index: u64,
) {
    bytes.append(*old_root);
    append_u64_be(bytes, old_index);
    bytes.append(*new_root);
    append_u64_be(bytes, new_index)
}

fun append_u32_be(bytes: &mut vector<u8>, value: u32) {
    let mut shift = 4;
    while (shift > 0) { shift = shift - 1; bytes.push_back(((value >> (shift * 8)) & 255) as u8) }
}

fun append_u64_be(bytes: &mut vector<u8>, value: u64) {
    let mut shift = 8;
    while (shift > 0) { shift = shift - 1; bytes.push_back(((value >> (shift * 8)) & 255) as u8) }
}

fun coin_type_hash<T>(): vector<u8> {
    hash::sha2_256(type_name::with_original_ids<T>().into_string().into_bytes())
}

fun assert_32(bytes: &vector<u8>) { assert!(bytes.length() == 32, E_BAD_LENGTH) }

public fun root<T>(pool: &Pool<T>): &vector<u8> { &pool.root }
public fun next_leaf<T>(pool: &Pool<T>): u64 { pool.next_leaf }
public fun balance<T>(pool: &Pool<T>): u64 { pool.custody.value() }
public fun verifier_version<T>(pool: &Pool<T>): u32 { pool.verifier_version }
public fun note_is_spent<T>(pool: &Pool<T>, nullifier: vector<u8>): bool { pool.spent_notes.contains(nullifier) }
public fun deal_is_consumed<T>(pool: &Pool<T>, nullifier: vector<u8>): bool { pool.consumed_deals.contains(nullifier) }

#[test_only]
public fun new_for_testing<T>(domain: vector<u8>, initial_root: vector<u8>, ctx: &mut TxContext): Pool<T> {
    assert_32(&domain);
    assert_32(&initial_root);
    let mut accepted_roots = table::new(ctx);
    accepted_roots.add(copy initial_root, true);
    Pool<T> {
        id: object::new(ctx), custody: balance::zero(), domain,
        coin_type_hash: coin_type_hash<T>(), verifier_version: 1,
        root: initial_root, next_leaf: 0, accepted_roots,
        spent_notes: table::new(ctx), consumed_deals: table::new(ctx),
        deposit_vk: groth16::pvk_from_bytes(vector[], vector[], vector[], vector[]),
        transfer_vk: groth16::pvk_from_bytes(vector[], vector[], vector[], vector[]),
        withdraw_vk: groth16::pvk_from_bytes(vector[], vector[], vector[], vector[]),
    }
}

#[test_only]
public fun destroy_for_testing<T>(pool: Pool<T>) {
    let Pool {
        id, custody, domain: _, coin_type_hash: _, verifier_version: _, root, next_leaf: _,
        mut accepted_roots, spent_notes, consumed_deals, deposit_vk: _, transfer_vk: _, withdraw_vk: _,
    } = pool;
    custody.destroy_zero();
    accepted_roots.remove(root);
    accepted_roots.destroy_empty();
    spent_notes.destroy_empty();
    consumed_deals.destroy_empty();
    id.delete()
}

