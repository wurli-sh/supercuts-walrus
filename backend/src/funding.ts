import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fail } from "./errors.js";
import { Phase3App } from "./phase3.js";
import { writeClient } from "./sui.js";

const amount = (value: string, name: string): bigint => /^[0-9]+$/.test(value) ? BigInt(value) : fail("FUNDING_INPUT_INVALID", `${name} must be unsigned MIST`);
const POOL_DEPOSIT_DENOMINATIONS = [10_000_000n, 100_000_000n] as const;

const standardPoolDeposit = (shortfall: bigint): bigint => {
  if (shortfall === 0n) return 0n;
  const denomination = POOL_DEPOSIT_DENOMINATIONS.find((candidate) => candidate >= shortfall);
  return denomination ?? fail("FUNDING_PLAN_UNSUPPORTED", `shielded funding needs ${shortfall} MIST, above the largest supported single deposit of ${POOL_DEPOSIT_DENOMINATIONS.at(-1)} MIST`);
};

export interface FundingPlan {
  address: string; publicBalanceMist: string; shieldedBalanceMist: string; publicPaymentMist: string;
  shieldedPaymentMist: string; gasReserveMist: string; changeReserveMist: string; poolDepositMist: string;
  requiredPublicMist: string; publicShortfallMist: string; faucetRequired: boolean; depositRequired: boolean;
}

export function calculateFundingPlan(input: { address: string; publicBalance: bigint; shieldedBalance: bigint; publicPayment: bigint; shieldedPayment: bigint; gasReserve: bigint; changeReserve: bigint }): FundingPlan {
  const shieldedTarget = input.shieldedPayment > 0n ? input.shieldedPayment + input.changeReserve : 0n;
  const poolShortfall = shieldedTarget > input.shieldedBalance ? shieldedTarget - input.shieldedBalance : 0n;
  const poolDeposit = standardPoolDeposit(poolShortfall);
  const requiredPublic = input.publicPayment + poolDeposit + input.gasReserve;
  const publicShortfall = requiredPublic > input.publicBalance ? requiredPublic - input.publicBalance : 0n;
  return { address: input.address, publicBalanceMist: input.publicBalance.toString(), shieldedBalanceMist: input.shieldedBalance.toString(), publicPaymentMist: input.publicPayment.toString(), shieldedPaymentMist: input.shieldedPayment.toString(), gasReserveMist: input.gasReserve.toString(), changeReserveMist: input.changeReserve.toString(), poolDepositMist: poolDeposit.toString(), requiredPublicMist: requiredPublic.toString(), publicShortfallMist: publicShortfall.toString(), faucetRequired: publicShortfall > 0n, depositRequired: poolDeposit > 0n };
}

export async function prepareFunding(home: string, values: { publicPayment: string; shieldedPayment: string; gasReserve?: string; changeReserve?: string }): Promise<FundingPlan> {
  const publicPayment = amount(values.publicPayment, "public payment"), shieldedPayment = amount(values.shieldedPayment, "shielded payment");
  const gasReserve = amount(values.gasReserve ?? "100000000", "gas reserve"), changeReserve = amount(values.changeReserve ?? "1000000", "change reserve");
  const app = new Phase3App(home);
  try {
    if (app.profile.role !== "buyer" || app.profile.mock) fail("LIVE_PROFILE_REQUIRED", "funding requires a live buyer role home");
    const doctor = await app.execute("doctor", {}), address = String(doctor.data.signer ?? "");
    if (shieldedPayment > 0n && doctor.data.shieldedProofs !== "ready") fail("SHIELDED_PROOFS_UNAVAILABLE", String((doctor.data.shieldedFixes as string[] | undefined)?.[0] ?? "shielded proving artifacts are not installed"));
    const endpoint = app.profile.live?.writeGrpcEndpoint ?? fail("LIVE_PROFILE_INVALID", "buyer write RPC is missing");
    const [{ balance }, shielded] = await Promise.all([writeClient(endpoint).getBalance({ owner: address, coinType: "0x2::sui::SUI" }), app.execute("wallet.balance", {})]);
    return calculateFundingPlan({ address, publicBalance: BigInt(balance.balance), shieldedBalance: BigInt(String(shielded.data.available ?? "0")), publicPayment, shieldedPayment, gasReserve, changeReserve });
  } finally { app.close(); }
}

export async function executeFunding(home: string, values: { publicPayment: string; shieldedPayment: string; gasReserve?: string; changeReserve?: string; operationId: string; requestFaucet: boolean; confirmed: boolean }): Promise<Record<string, unknown>> {
  if (!values.confirmed) fail("FUNDING_CONFIRMATION_REQUIRED", "funding execution requires --confirm after reviewing the plan");
  let plan = await prepareFunding(home, values);
  if (plan.faucetRequired) {
    if (!values.requestFaucet) fail("BUYER_FUNDING_REQUIRED", `buyer needs ${plan.publicShortfallMist} additional MIST; rerun with --request-faucet --confirm or fund ${plan.address} manually`);
    try { execFileSync("sui", ["client", "faucet", "--url", "https://faucet.testnet.sui.io", "--address", plan.address], { stdio: ["ignore", process.stderr, process.stderr] }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("SUI_CLI_MISSING", `the Sui CLI is not installed; request Testnet SUI for ${plan.address} at https://faucet.sui.io, then rerun funding execute without --request-faucet`);
      throw error;
    }
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      plan = await prepareFunding(home, values);
      if (!plan.faucetRequired) break;
    }
    if (plan.faucetRequired) fail("FAUCET_ALLOCATION_INSUFFICIENT", `the public faucet allocation did not reach the required ${plan.requiredPublicMist} MIST; wait for finality and inspect funding status before requesting another allocation`);
  }
  if (!plan.depositRequired) return { funded: true, faucetRequested: values.requestFaucet, deposit: "not-required", plan };
  if (!values.operationId) fail("ARGUMENT_REQUIRED", "funding execute requires --operation-id for safe retry");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (process.stdin.isTTY) {
      const answer = (await rl.question(`Deposit ${plan.poolDepositMist} MIST into the experimental Testnet pool? type yes: `)).trim().toLowerCase();
      if (answer !== "yes") fail("FUNDING_CANCELLED", "pool deposit was not confirmed");
    }
  } finally { rl.close(); }
  const app = new Phase3App(home);
  try {
    const deposit = await app.execute("wallet.deposit", { amount: plan.poolDepositMist, "operation-id": values.operationId, authorize: true });
    return { funded: true, faucetRequested: values.requestFaucet, deposit: deposit.data, plan: await prepareFunding(home, values) };
  } finally { app.close(); }
}
