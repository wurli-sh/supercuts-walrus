import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const base = resolve("build/adversarial-revision");
const config = JSON.parse(readFileSync(resolve(base, "config.json")));
const revisions = [
  { revision: 1, values: JSON.parse(readFileSync(resolve(base, "fixtures/public.json"))), proof: readFileSync(resolve(base, "proofs/transfer/proof.bin")), gas: "100000000" },
  { revision: 2, values: JSON.parse(readFileSync(resolve(base, "fixtures/public-revision2.json"))), proof: readFileSync(resolve(base, "proofs/transfer-revision2/proof.bin")), gas: "110000000" },
];
const vector = (bytes) => `[${[...bytes].join(",")}]`;
const field = (value) => Buffer.from(BigInt(value).toString(16).padStart(64, "0"), "hex");
function args(run) {
  const v = run.values;
  const fields = [["deal",v.dealCommitment],["dealNull",v.dealNullifier],["inputNull",v.inputNullifier],["payment",v.paymentNote],["change",v.changeNote],["newRoot",v.finalRoot]];
  const vectors = fields.flatMap(([name,value]) => ["--make-move-vec","<u8>",vector(field(value)),"--assign",name]);
  vectors.push("--make-move-vec","<u8>",vector(run.proof),"--assign","proof");
  return ["client","ptb",...vectors,"--move-call",`${config.packageId}::pool::transfer_private`,`<${config.coinType}>`,`@${config.poolId}`,"@0x6","deal","dealNull","inputNull","payment","change",String(v.expiry),"newRoot",String(v.transferNewIndex),"proof","--gas-budget",run.gas,"--json"];
}
function state() {
  const r=spawnSync("sui",["client","object",config.poolId,"--json"],{encoding:"utf8"}); const o=JSON.parse(r.stdout);
  return {custody:o.content.custody,root:o.content.root,nextLeaf:o.content.next_leaf,spentNotes:o.content.spent_notes.size,consumedDeals:o.content.consumed_deals.size};
}
function execute(run) {
  return new Promise((done) => { const child=spawn("sui",args(run)); let output=""; child.stdout.on("data",c=>output+=c); child.stderr.on("data",c=>output+=c); child.on("close",code=>done({revision:run.revision,status:code===0?"success":"failure",digest:output.match(/transaction '([A-Za-z0-9]+)'/i)?.[1]??output.match(/"digest"\s*:\s*"([A-Za-z0-9]+)"/)?.[1]??null,error:code===0?null:output.trim().slice(-1000)})); });
}
const before=state();
const attempts=await Promise.all(revisions.map(execute));
const after=state();
if(attempts.filter(a=>a.status==="success").length!==1) throw new Error(`expected exactly one revision to settle: ${JSON.stringify(attempts)}`);
if(BigInt(after.nextLeaf)!==BigInt(before.nextLeaf)+2n||BigInt(after.spentNotes)!==BigInt(before.spentNotes)+1n||BigInt(after.consumedDeals)!==BigInt(before.consumedDeals)+1n) throw new Error("revision race changed state more than once");
const evidence={poolId:config.poolId,poolCreateTransaction:config.poolCreateTransaction,sharedDealNullifier:revisions[0].values.dealNullifier,distinctDealCommitments:revisions.map(r=>r.values.dealCommitment),before,attempts,after};
writeFileSync(resolve(base,"revision-race-evidence.json"),`${JSON.stringify(evidence,null,2)}\n`);
console.log(JSON.stringify(evidence,null,2));
