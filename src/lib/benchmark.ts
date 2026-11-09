import { ethers } from "ethers";
import { ERC20, rpc, inspectSender, RpcError } from "./benchmark-rpc.js";
import { fetchQuote, build } from "./benchmark-upstream.js";
import { verifyPeachPlan, verifyPeachReceipt, requiredNative } from "./benchmark-execution.js";
import type { Case, Profile, Result } from "./benchmark-model.js";
export * from "./benchmark-model.js";
export { rpc, chainToken, decimals } from "./benchmark-rpc.js";
export { fetchQuote, build } from "./benchmark-upstream.js";

export async function query(profile: Profile, c: Case, rpcUrl: string): Promise<Result> {
  const r = await fetchQuote(profile, c);
  if (c.doSim && r.ok) {
    await build(profile, c, r);
    if (!r.buildError) r.simulation = await simulate(c, r.tx, r.spender!, rpcUrl, r);
  }
  return r;
}

/** Ephemeral approval + swap; real balances only, never signing or broadcasting. */
export async function simulate(c: Case, tx: Result["tx"], spender: string, rpcUrl: string, result?: Result): Promise<Result["simulation"]> {
  if (!tx || !ethers.isAddress(tx.to) || !ethers.isHexString(tx.data)) return { status: "UNAVAILABLE", stage: "build", error: "Missing/invalid executable transaction" };
  let stage = "preconditions";
  const evidence: Record<string, any> = {};
  try {
    const sender = await inspectSender(rpcUrl, c.from, c.sender, c.block); evidence.sender = sender;
    if (sender.code !== "0x") return { status: "FAILED", stage, error: "Sender must be an EOA", evidence };
    if (BigInt(sender.balance) < BigInt(c.amountIn)) return { status: "FAILED", stage, error: "Insufficient actual input token balance", evidence };
    if (BigInt(sender.nativeBalance) === 0n) return { status: "FAILED", stage, error: "Sender has no native gas balance", evidence };
    if (!c.blockMeta) return { status: "UNAVAILABLE", stage: "rpc", error: "Verified simulation block metadata is required", evidence };
    const gasPrice = BigInt(c.gasPrice ?? await rpc(rpcUrl, "eth_gasPrice", []));
    if (gasPrice <= 0n) throw new Error("Invalid observed gas price");
    let verified: Awaited<ReturnType<typeof verifyPeachPlan>> | undefined;
    if (result?.kind === "peach") { stage = "plan"; verified = await verifyPeachPlan(c, result, rpcUrl); }
    stage = "approval";
    if (!ethers.isAddress(spender)) throw new Error("Missing approval spender");
    // Native ARC USDC and its ERC-20 balance are shared. Paying gas inside this
    // balance measurement would contaminate output/debit. Check real gas budget
    // separately, matching Manager's third-party balance simulation semantics.
    const callBase = { from: c.sender, gasPrice: "0x0" };
    const balanceCall = { ...callBase, to: c.target, data: ERC20.encodeFunctionData("balanceOf", [c.recipient ?? c.sender]), gas: "0x186a0" };
    const inputBalanceCall = { ...callBase, to: c.from, data: ERC20.encodeFunctionData("balanceOf", [c.sender]), gas: "0x186a0" };
    const calls = [
      ...[0n, BigInt(c.amountIn)].map(amount => ({ ...callBase, to: c.from, data: ERC20.encodeFunctionData("approve", [spender, amount]), gas: "0x4c4b40" })),
      { ...callBase, to: c.from, data: ERC20.encodeFunctionData("allowance", [c.sender, spender]), gas: "0x186a0" },
      inputBalanceCall,
      balanceCall,
      { ...callBase, to: tx.to, data: tx.data, value: ethers.toQuantity(BigInt(tx.value)), gas: "0x989680" },
      inputBalanceCall,
      balanceCall,
    ];
    const params = [{ blockStateCalls: [{ blockOverrides: { time: ethers.toQuantity(c.blockMeta.timestamp + 1), baseFeePerGas: "0x0" }, calls }], validation: false, traceTransfers: true }, c.block];
    evidence.params = params; stage = "rpc";
    const blocks = await rpc(rpcUrl, "eth_simulateV1", params); evidence.response = blocks;
    const outputs = blocks?.[0]?.calls;
    if (!outputs || outputs.length !== calls.length || blocks[0].parentHash?.toLowerCase() !== c.blockMeta.hash.toLowerCase() || BigInt(blocks[0].number) !== BigInt(c.block) + 1n || BigInt(blocks[0].timestamp) !== BigInt(c.blockMeta.timestamp + 1)) throw new Error("Incomplete/mismatched synthetic simulation block");
    const failed = outputs.findIndex((r: any) => r.status !== "0x1");
    if (failed >= 0) return { status: "FAILED", stage: failed <= 2 ? "approval" : failed === 5 ? "swap" : "balance", error: outputs[failed].error?.message ?? "Simulation call reverted", evidence };
    if (outputs.slice(0, 2).some((r: any) => r.returnData && r.returnData !== "0x" && BigInt(r.returnData) === 0n)) return { status: "FAILED", stage: "approval", error: "approve returned false", evidence };
    if (BigInt(ERC20.decodeFunctionResult("allowance", outputs[2].returnData)[0]) < BigInt(c.amountIn)) return { status: "FAILED", stage: "approval", error: "Simulated allowance remains insufficient", evidence };
    stage = "balance";
    const inputBefore = BigInt(ERC20.decodeFunctionResult("balanceOf", outputs[3].returnData)[0]);
    const inputAfter = BigInt(ERC20.decodeFunctionResult("balanceOf", outputs[6].returnData)[0]);
    const actualInput = inputBefore - inputAfter;
    Object.assign(evidence, { inputBefore: String(inputBefore), inputAfter: String(inputAfter), actualInputDebit: String(actualInput) });
    if (inputBefore !== BigInt(sender.balance) || actualInput <= 0n || actualInput > BigInt(c.amountIn)) return { status: "FAILED", stage, error: "Actual sender input debit does not match case constraints", evidence };
    const before = BigInt(ERC20.decodeFunctionResult("balanceOf", outputs[4].returnData)[0]);
    const after = BigInt(ERC20.decodeFunctionResult("balanceOf", outputs[7].returnData)[0]);
    const output = after - before;
    if (output <= 0n || (result?.minimumOut && output < BigInt(result.minimumOut))) return { status: "FAILED", stage, error: "Measured recipient output is zero/negative or below built minimum", evidence };
    if (verified && result) { stage = "receipt"; evidence.receipt = verifyPeachReceipt(c, result, verified.digest, outputs[5].returnData, output); }
    stage = "gas";
    const gasUsed = [outputs[0], outputs[1], outputs[5]].reduce((n: bigint, r: any) => n + BigInt(r.gasUsed), 0n);
    if (gasUsed <= 0n) throw new Error("Invalid simulated gas consumption");
    const gasBudget = gasUsed * gasPrice, nativeRequired = requiredNative(c, gasBudget);
    Object.assign(evidence, { observedGasPrice: String(gasPrice), simulationGasPrice: "0", nativeRequired: String(nativeRequired), block: c.blockMeta,
      notes: ["validation=false; real input balance and combined native input/gas budget checked independently", "Synthetic block is recorded parent +1, time +1 second; gas includes reset/approve/swap, excluding diagnostic reads", "Balance measurement uses gasPrice=0/baseFee=0 to avoid mixing native USDC fees into token balances. Contracts sensitive to GASPRICE/BASEFEE are only validated under those synthetic conditions."] });
    if (BigInt(sender.nativeBalance) < nativeRequired) return { status: "FAILED", stage, amountOut: String(output), gasUsed: String(gasUsed), gasBudget: String(gasBudget), error: "Actual native balance cannot cover input plus simulated gas budget", evidence };
    return { status: "SUCCESS", stage: "complete", amountOut: String(output), gasUsed: String(gasUsed), gasBudget: String(gasBudget), evidence };
  } catch (error) {
    if (error instanceof RpcError) return { status: "UNAVAILABLE", stage: "rpc", error: error.message, evidence };
    return { status: ["plan", "receipt", "balance", "approval"].includes(stage) ? "FAILED" : "UNAVAILABLE", stage, error: (error as Error).message, evidence };
  }
}

/** Signed bps, rounded toward zero to four decimal places. */
export function differenceBps(actual: string, reference: string): string | null {
  const ref = BigInt(reference); if (ref <= 0n) return null;
  const n = (BigInt(actual) - ref) * 100_000_000n / ref, abs = n < 0n ? -n : n;
  return `${n < 0n ? "-" : ""}${abs / 10000n}${abs % 10000n ? `.${String(abs % 10000n).padStart(4, "0").replace(/0+$/, "")}` : ""}`;
}
function routeSummary(r: Result) {
  const routes = r.routes ?? [];
  return { segments: routes.length, dexes: [...new Set(routes.map(h => h.dex?.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()).filter(Boolean))],
    pools: [...new Set(routes.flatMap(h => h.pool ? [h.pool.toLowerCase()] : []))], missingPools: routes.filter(h => !h.pool).length };
}
export function analyze(results: Result[], baselineName?: string) {
  const valid = results.filter(r => r.ok && r.amountOut);
  const best = valid.reduce<Result | undefined>((a, b) => !a || BigInt(b.amountOut!) > BigInt(a.amountOut!) ? b : a, undefined);
  const simulated = valid.filter(r => r.simulation.status === "SUCCESS" && r.simulation.amountOut !== undefined);
  const bestSim = simulated.reduce<Result | undefined>((a, b) => !a || BigInt(b.simulation.amountOut!) > BigInt(a.simulation.amountOut!) ? b : a, undefined);
  const baseline = valid.find(r => r.name === baselineName) ?? (baselineName ? undefined : valid.find(r => r.kind === "peach") ?? valid[0]);
  return { baseline: baseline?.name ?? null, bestQuote: best?.name ?? null, bestSimulation: bestSim?.name ?? null,
    comparisons: results.map(r => {
      const route = routeSummary(r), reference = baseline ? routeSummary(baseline) : null;
      const uniqueDexes = reference ? route.dexes.filter(d => !reference.dexes.includes(d)) : [];
      const uniquePools = reference ? route.pools.filter(p => !reference.pools.includes(p)) : [];
      const superior = r.ok && baseline && r.name !== baseline.name && BigInt(r.amountOut!) > BigInt(baseline.amountOut!);
      return { name: r.name,
        quoteGapBps: r.ok && r.amountOut && best ? differenceBps(r.amountOut, best.amountOut!) : null,
        baselineAdvantageBps: r.ok && r.amountOut && baseline ? differenceBps(baseline.amountOut!, r.amountOut) : null,
        simulationGapBps: r.simulation.status === "SUCCESS" && bestSim ? differenceBps(r.simulation.amountOut!, bestSim.simulation.amountOut!) : null,
        quoteToBuildBps: r.builtAmountOut && r.amountOut ? differenceBps(r.builtAmountOut, r.amountOut) : null,
        quoteToSimulationBps: r.simulation.status === "SUCCESS" && r.amountOut ? differenceBps(r.simulation.amountOut!, r.amountOut) : null,
        buildToSimulationBps: r.simulation.status === "SUCCESS" && r.builtAmountOut ? differenceBps(r.simulation.amountOut!, r.builtAmountOut) : null,
        route, routeDifferenceFromBaseline: reference ? { uniqueDexes, uniquePools, sharedPools: route.pools.length && reference.pools.length ? route.pools.filter(p => reference.pools.includes(p)).length : null } : null,
        findings: [
          ...(r.error ? [{ confidence: "observed", category: "quote", detail: r.error }] : []),
          ...(r.buildError ? [{ confidence: "observed", category: "build", detail: r.buildError }] : []),
          ...(r.simulation.error ? [{ confidence: "observed", category: r.simulation.stage ?? "simulation", detail: r.simulation.error }] : []),
          ...(superior ? [{ confidence: "hypothesis", category: uniqueDexes.length || uniquePools.length ? "route-selection-or-coverage" : "pool-state-split-or-fees",
            detail: uniqueDexes.length || uniquePools.length ? "Better quote uses different DEXes/pools. Verify Peach coverage and live pool state before attributing missing liquidity." : "No observed new DEX/pool. Inspect split amounts, fees and snapshots; missing pool fields limit this comparison.", dexes: uniqueDexes, pools: uniquePools }] : []),
          ...(r.builtAmountOut && r.amountOut && r.builtAmountOut !== r.amountOut ? [{ confidence: "observed", category: "quote-to-build-drift", detail: "Fresh build differs from original quote; simulation does not prove the original route." }] : []),
          ...(r.kind === "kyber" && r.routes?.some(h => /pmm|rfq/i.test(h.dex)) ? [{ confidence: "observed", category: "rfq-quote-versus-build", detail: "Initial quote contains a PMM/RFQ source. Kyber execution build explicitly excludes RFQ, so quote/build paths may differ." }] : []),
          ...(r.routes == null ? [{ confidence: "observed", category: "missing-route-evidence", detail: "Endpoint does not expose route details" }] : []),
        ],
      };
    }),
    limitations: ["Quotes/builds refresh independently and are not pinned by upstream APIs; only simulations share a verified parent block.",
      "Different returned routes do not prove missing coverage/stale state. Root causes require pool/hop evidence.",
      "Actual sender balances and temporary approvals only. Gas is reported separately; output ranking is not gas-adjusted.",
      "No private key, wallet signature or broadcast. Simulation is not a guarantee of future execution."],
  };
}

/** Quote wins require a complete selected-source round, like Manager statistics. */
export function summarize(rounds: Result[][]) {
  const names = [...new Set(rounds.flatMap(r => r.map(q => q.name)))];
  const complete = rounds.filter(r => r.length === names.length && r.every(q => q.ok && q.amountOut));
  return { rounds: rounds.length, completeQuoteRounds: complete.length,
    sources: names.map(name => {
      const samples = rounds.flatMap(r => r.filter(q => q.name === name));
      let wins = 0, ties = 0;
      for (const round of complete) {
        const highest = round.reduce((n, q) => BigInt(q.amountOut!) > n ? BigInt(q.amountOut!) : n, 0n);
        const leaders = round.filter(q => BigInt(q.amountOut!) === highest);
        if (leaders.some(q => q.name === name)) { if (leaders.length === 1) wins++; else ties++; }
      }
      const latencies = samples.filter(q => q.ok).map(q => q.latencyMs).sort((a, b) => a - b);
      return { name, quoteAttempts: samples.length, quoteSuccess: samples.filter(q => q.ok).length, wins, ties,
        simulationSuccess: samples.filter(q => q.simulation.status === "SUCCESS").length,
        simulationFailed: samples.filter(q => q.simulation.status === "FAILED").length,
        simulationUnavailable: samples.filter(q => q.simulation.status === "UNAVAILABLE").length,
        simulationSkipped: samples.filter(q => q.simulation.status === "SKIPPED").length,
        quoteMeanLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
        quoteP95LatencyMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null };
    }),
  };
}
