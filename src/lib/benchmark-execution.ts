import { ethers } from "ethers";
import { computeExecutionPlanStructHash, computeExecutionRouteHash, decodeExecutionRouterCalldata, decodeExecutionRouterReceipt } from "@masterpeach/aggregator-sdk";
import { ARC_USDC, type Case, type Result } from "./benchmark-model.js";
import { rpc } from "./benchmark-rpc.js";

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const requireValue = (v: unknown, message: string) => { if (!v) throw new Error(message); };
const signers = new ethers.Interface(["function executionSigners(uint64) view returns(address)"]);
/** Validate public signed execution evidence. No signer/private key is needed. */
export async function verifyPeachPlan(c: Case, result: Result, rpcUrl: string) {
  const decoded = decodeExecutionRouterCalldata(result.tx!.data), p = decoded.plan, r = decoded.routerParams;
  const recipient = c.recipient ?? c.sender;
  requireValue(p.version === 1n && p.chainId === BigInt(c.chainId) && eq(p.router, result.tx!.to)
    && eq(p.payer, c.sender) && eq(p.executor, c.sender) && eq(p.recipient, recipient), "Signed execution roles/chain do not match case");
  requireValue(eq(p.tokenIn, c.from) && eq(p.tokenOut, c.target) && p.amountIn === BigInt(c.amountIn)
    && p.nativeMode === 0 && p.fundingMode === 0 && decoded.payerSignature === "0x", "Signed execution tokens/input do not match case");
  requireValue(p.customFeeBps === 0n && eq(p.customFeeReceiver, ethers.ZeroAddress), "Unexpected signed integrator fee");
  requireValue(p.expectedAmountOut === BigInt(result.builtAmountOut!) && p.minAmountOut === BigInt(result.minimumOut!)
    && p.deadline * 1000n > BigInt(Date.now()) && p.deadline * 1000n <= BigInt(Date.now() + 600000), "Signed output/minimum/deadline mismatch");
  requireValue(eq(r.srcToken, p.tokenIn) && eq(r.dstToken, p.tokenOut) && r.amountIn === p.amountIn
    && r.amountOutMin === p.minAmountOut && r.expectAmountOut === p.expectedAmountOut && r.deadline === p.deadline
    && eq(r.quoteId, p.quoteId) && r.feeBps === 0 && eq(r.feeReceiver, ethers.ZeroAddress)
    && r.steps.length > 0 && decoded.logicalPoolIds.length === r.steps.length && decoded.amountModes.length === r.steps.length,
  "Signed route parameters mismatch");
  requireValue(eq(computeExecutionRouteHash(r, decoded.logicalPoolIds, decoded.amountModes), p.routeHash), "Execution route hash mismatch");
  const domain = ethers.TypedDataEncoder.hashDomain({ name: c.chainId === 56 ? "Peach Router Execution" : "Arc Router Execution", version: "1", chainId: c.chainId, verifyingContract: p.router });
  const digest = ethers.keccak256(ethers.concat(["0x1901", domain, computeExecutionPlanStructHash(p)]));
  const signer = ethers.recoverAddress(digest, decoded.aggregatorSignature);
  const registered = await rpc(rpcUrl, "eth_call", [{ to: p.router, data: signers.encodeFunctionData("executionSigners", [p.signerVersion]) }, c.block]);
  requireValue(eq(signers.decodeFunctionResult("executionSigners", registered)[0], signer), "Plan signer does not match on-chain signerVersion");
  return { digest, plan: p };
}
export function verifyPeachReceipt(c: Case, result: Result, digest: string, raw: string, balanceOutput: bigint) {
  const receipt = decodeExecutionRouterReceipt(raw);
  requireValue(eq(receipt.planHash, digest) && eq(receipt.payer, c.sender) && eq(receipt.executor, c.sender)
    && eq(receipt.recipient, c.recipient ?? c.sender) && eq(receipt.tokenOut, c.target)
    && receipt.requestedAmountIn === BigInt(c.amountIn) && receipt.actualAmountIn > 0n
    && receipt.actualAmountIn <= BigInt(c.amountIn) && receipt.userAmountOut >= BigInt(result.minimumOut!)
    && receipt.userAmountOut === balanceOutput, "Execution receipt identity/amount differs from case or measured output");
  return JSON.parse(JSON.stringify(receipt, (_k, v) => typeof v === "bigint" ? String(v) : v));
}
export function requiredNative(c: Case, gasBudget: bigint): bigint {
  // Arc canonical USDC (6 decimals) shares native balance (18 decimals).
  return gasBudget + ([5042, 5042002].includes(c.chainId) && eq(c.from, ARC_USDC) ? BigInt(c.amountIn) * 10n ** 12n : 0n);
}
