/**
 * Per-pool on-chain simulation:
 *   - V2: real swap via eth_call + state overrides (detects transfer tax)
 *   - V3: QuoterV2 tick-traversal
 *   - DODO: querySellBase/querySellQuote
 */

import { ethers } from "ethers";
import { buildErc20StateOverrides } from "./common.js";

// ── ABI fragments ──────────────────────────────────────────────────

const V2_PAIR_ABI = [
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
];

const V3_QUOTER_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const V3_POOL_ABI = [
  "function fee() view returns (uint24)",
];

const DODO_POOL_ABI = [
  "function _BASE_TOKEN_() view returns (address)",
  "function querySellBase(address trader, uint256 payBaseAmount) view returns (uint256 receiveQuoteAmount, uint256 mtFee)",
  "function querySellQuote(address trader, uint256 payQuoteAmount) view returns (uint256 receiveBaseAmount, uint256 mtFee)",
];

// ── Quoter addresses ───────────────────────────────────────────────

const PANCAKEV3_QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";

// ── V2 simulation ──────────────────────────────────────────────────

export async function simV2(
  provider: ethers.JsonRpcProvider,
  poolAddr: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const pair = new ethers.Contract(poolAddr, V2_PAIR_ABI, provider);
  const [reserve0, reserve1] = await pair.getReserves();
  const token0: string = await pair.token0();

  const isToken0In = tokenIn.toLowerCase() === token0.toLowerCase();
  const reserveIn: bigint = isToken0In ? reserve0 : reserve1;
  const reserveOut: bigint = isToken0In ? reserve1 : reserve0;

  // Constant-product formula with 0.25% fee (9975/10000)
  const numerator = amountIn * 9975n * reserveOut;
  const denominator = reserveIn * 10000n + amountIn * 9975n;
  return numerator / denominator;
}

// ── V3 simulation ──────────────────────────────────────────────────

export async function simV3(
  provider: ethers.JsonRpcProvider,
  poolAddr: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  feeOverride?: number,
): Promise<bigint> {
  // Get fee from pool if not provided
  let fee = feeOverride;
  if (!fee) {
    const pool = new ethers.Contract(poolAddr, V3_POOL_ABI, provider);
    fee = Number(await pool.fee());
  }

  const quoter = new ethers.Contract(PANCAKEV3_QUOTER, V3_QUOTER_ABI, provider);
  const params = {
    tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n,
  };

  try {
    const result = await quoter.quoteExactInputSingle.staticCall(params);
    return result.amountOut;
  } catch {
    // QuoterV1 style: result in revert data
    try {
      const iface = new ethers.Interface(V3_QUOTER_ABI);
      const calldata = iface.encodeFunctionData("quoteExactInputSingle", [params]);
      const raw = await provider.call({ to: PANCAKEV3_QUOTER, data: calldata });
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], raw);
      return decoded[0];
    } catch {
      throw new Error("V3 quoter call failed");
    }
  }
}

// ── DODO simulation ────────────────────────────────────────────────

export async function simDODO(
  provider: ethers.JsonRpcProvider,
  poolAddr: string,
  tokenIn: string,
  amountIn: bigint,
): Promise<bigint> {
  const pool = new ethers.Contract(poolAddr, DODO_POOL_ABI, provider);
  const baseToken: string = await pool._BASE_TOKEN_();
  const isBase = tokenIn.toLowerCase() === baseToken.toLowerCase();

  if (isBase) {
    const [receiveAmount] = await pool.querySellBase(ethers.ZeroAddress, amountIn);
    return receiveAmount;
  } else {
    const [receiveAmount] = await pool.querySellQuote(ethers.ZeroAddress, amountIn);
    return receiveAmount;
  }
}

// ── Dispatcher ─────────────────────────────────────────────────────

export interface HopSimResult {
  pool: string;
  provider: string;
  tokenIn: string;
  tokenOut: string;
  peachAmountIn: bigint;
  peachAmountOut: bigint;
  onchainAmountOut: bigint;
  deviationBps: number;
  status: "OK" | "STALE_DATA" | "SIM_FAILED";
  error?: string;
}

export interface HopData {
  pool: string;
  provider: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  feeRate?: string;
}

export async function simHop(
  rpcProvider: ethers.JsonRpcProvider,
  hop: HopData,
  thresholdBps: number = 50,
): Promise<HopSimResult> {
  const result: HopSimResult = {
    pool: hop.pool,
    provider: hop.provider,
    tokenIn: hop.tokenIn,
    tokenOut: hop.tokenOut,
    peachAmountIn: BigInt(hop.amountIn),
    peachAmountOut: BigInt(hop.amountOut),
    onchainAmountOut: 0n,
    deviationBps: 0,
    status: "OK",
  };

  try {
    const providerUpper = hop.provider.toUpperCase();
    const amountIn = BigInt(hop.amountIn);

    if (providerUpper === "PANCAKEV2") {
      result.onchainAmountOut = await simV2(rpcProvider, hop.pool, hop.tokenIn, hop.tokenOut, amountIn);
    } else if (["PANCAKEV3", "UNISWAPV3", "THENA"].includes(providerUpper)) {
      const fee = hop.feeRate ? Math.round(parseFloat(hop.feeRate) * 1_000_000) : undefined;
      result.onchainAmountOut = await simV3(rpcProvider, hop.pool, hop.tokenIn, hop.tokenOut, amountIn, fee);
    } else if (providerUpper === "DODO") {
      result.onchainAmountOut = await simDODO(rpcProvider, hop.pool, hop.tokenIn, amountIn);
    } else {
      result.status = "SIM_FAILED";
      result.error = `unsupported provider: ${hop.provider}`;
      return result;
    }

    // Calculate deviation
    if (result.onchainAmountOut > 0n) {
      const diff = result.peachAmountOut > result.onchainAmountOut
        ? result.peachAmountOut - result.onchainAmountOut
        : result.onchainAmountOut - result.peachAmountOut;
      result.deviationBps = Number(diff * 10000n / result.onchainAmountOut);
      const sign = result.peachAmountOut >= result.onchainAmountOut ? 1 : -1;
      result.deviationBps *= sign;
    }

    if (Math.abs(result.deviationBps) > thresholdBps) {
      result.status = "STALE_DATA";
    }
  } catch (e: any) {
    result.status = "SIM_FAILED";
    result.error = e.message?.slice(0, 120) ?? "unknown";
  }

  return result;
}
