/** API catalog and contracts aligned with PeachManager Quote/Compare (2026-11-09).
 * Reference: shared/compare-upstream.ts and src/lib/compare-rpc.ts. */
export const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const ARC_USDC = "0x3600000000000000000000000000000000000000";
export type Kind = "peach" | "okx" | "kyber" | "fly";
export interface Profile {
  name: string; kind: Kind; api: string;
}
export const NETWORKS: Record<string, { chainId: number; rpc?: string; prod?: string; pre?: string }> = {
  bsc: { chainId: 56, rpc: "https://bsc-rpc.publicnode.com", prod: "https://api.peach.ag", pre: "https://api.cipheron.org" },
  arc: { chainId: 5042, rpc: "https://arc-rpc.publicnode.com", prod: "https://api.peach.ag/arc", pre: "https://api-arc.cipheron.org/arc-mainnet" },
  "arc-testnet": { chainId: 5042002 },
};
export interface Block { number: string; hash: string; timestamp: number }
export interface Case {
  chainId: number; from: string; target: string; amountIn: string; sender: string;
  recipient?: string; slippageBps: number; depth?: number; splitCount?: number; providers?: string;
  block: string; blockMeta?: Block; gasPrice?: string; doSim: boolean;
}
export interface Hop {
  dex: string; pool: string | null; tokenIn: string; tokenOut: string;
  amountIn: string | null; amountOut: string | null; feeRate?: string | null;
}
export interface Transaction { to: string; data: string; value: string }
export interface Result {
  name: string; kind?: Kind; ok: boolean; latencyMs: number; error?: string;
  amountOut?: string; grossAmountOut?: string; feeAmount?: string;
  endpoint?: string; requestParams?: Record<string, string>;
  quoteId?: string; quoteTimestamp?: number; routes?: Hop[] | null; raw?: unknown;
  tx?: Transaction; spender?: string; builtAmountOut?: string; minimumOut?: string; buildRaw?: unknown;
  buildError?: string; buildLatencyMs?: number;
  simulation: {
    status: "SKIPPED" | "SUCCESS" | "FAILED" | "UNAVAILABLE";
    stage?: string; amountOut?: string; gasUsed?: string; gasBudget?: string;
    error?: string; evidence?: unknown;
  };
}
export function defaultProfiles(chain: string, names: string[]): Profile[] {
  const network = NETWORKS[chain];
  if (!network) throw new Error("Unknown chain");
  return names.map(name => {
    if (name === "peach" || name === "peach-prod" || name === "peach-pre") {
      const api = name === "peach-pre" ? network.pre : network.prod;
      if (!api) throw new Error(`${chain} requires an explicit --api or --profiles`);
      return { name: name === "peach" ? "peach-prod" : name, kind: "peach", api };
    }
    if (name === "okx") {
      const region = process.env.OKX_REGION ?? "global";
      if (!["global", "eea", "us"].includes(region)) throw new Error("Invalid OKX_REGION");
      return { name, kind: name, api: region === "eea" ? "https://eea.web3.okx.com" : region === "us" ? "https://us.web3.okx.com" : "https://web3.okx.com" };
    }
    if (name === "kyber") return { name, kind: name, api: process.env.KYBER_API_KEY ? "https://api.kyberswap.com/swap" : "https://aggregator-api.kyberswap.com" };
    if (name === "fly" && network.chainId === 5042) return { name, kind: name, api: process.env.FLY_API_KEY ? "https://api.magpiefi.xyz" : "https://api.fly.trade" };
    throw new Error(`Unsupported aggregator ${name} for ${chain}`);
  });
}
