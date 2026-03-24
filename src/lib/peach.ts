/**
 * Peach aggregator: quote + simulation.
 */

import { ethers } from "ethers";
import { PeachClient, BSC_MAINNET_CONFIG } from "@pagg/aggregator-sdk";
import type { Quote } from "@pagg/aggregator-sdk";
import { decodeRevert, WBNB, type AggResult, emptyResult } from "./common.js";
import { tokenLabel } from "./tokens.js";

export interface PeachQueryOpts {
  apiUrl: string;
  rpcUrl: string;
  sender: string;
  slippageBps: number;
  provider: ethers.JsonRpcProvider;
  doSim: boolean;
  /** Peach-specific options */
  depth?: number;
  splitCount?: number;
  providers?: string;
  version?: string;
}

/**
 * Query Peach find_routes API, build quote, and optionally simulate.
 */
export async function queryPeach(
  fromAddr: string, toAddr: string, amount: string, tradeUsd: number, opts: PeachQueryOpts,
): Promise<AggResult> {
  const result = emptyResult("Peach", BigInt(amount));

  const depth = opts.depth ?? 3;
  const splitCount = opts.splitCount ?? 5;
  const providers = opts.providers ?? "PANCAKEV2,PANCAKEV3,UNISWAPV3,DODO,THENA";
  const version = opts.version ?? "v5";

  const params = new URLSearchParams({
    from: fromAddr, target: toAddr, amount,
    by_amount_in: "true", depth: depth.toString(),
    split_count: splitCount.toString(), providers, v: "1001500",
  });
  const endpoint = version === "v5" ? "find_routes" : `find_routes_${version}`;
  const url = `${opts.apiUrl}/router/${endpoint}?${params}`;

  const start = Date.now();
  try {
    const resp = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    result.latencyMs = Date.now() - start;
    const json = await resp.json() as any;
    result.rawApiResponse = json;

    if (json?.code !== 200 || !json?.data) {
      result.error = `API: ${json?.msg ?? "unknown"} (code: ${json?.code})`;
      return result;
    }

    const config = { ...BSC_MAINNET_CONFIG, rpcUrl: opts.rpcUrl };
    const client = new PeachClient(config, opts.provider, { api: { baseUrl: opts.apiUrl, timeout: 30000 } });
    const quote: Quote = client.buildQuoteFromRouteData(json.data, fromAddr, toAddr);

    result.ok = true;
    result.amountOut = quote.amountOut;
    result.gasEstimate = quote.gasEstimate.toString();
    result.priceImpact = quote.priceImpact?.toString() ?? "-";

    // Build adapter -> dex name map
    const adapterMap: Record<string, string> = {};
    if (json.data?.contracts?.adapters) {
      for (const [name, addr] of Object.entries(json.data.contracts.adapters)) {
        adapterMap[(addr as string).toLowerCase()] = name;
      }
    }

    result.routes = quote.params.steps.map(s => ({
      dexName: adapterMap[s.adapter.toLowerCase()] ?? s.adapter.slice(0, 10),
      percent: 0,
      volumeUsd: 0,
      fromToken: tokenLabel(s.tokenIn),
      toToken: tokenLabel(s.tokenOut),
      path: `${tokenLabel(s.tokenIn)} -> ${tokenLabel(s.tokenOut)}`,
    }));

    // Encode calldata
    const txData = client.encodeSwapCalldata(quote, opts.slippageBps);
    result.txData = {
      to: txData.to, data: txData.data,
      value: txData.value.toString(), gas: quote.gasEstimate.toString(),
    };

    // Simulate
    if (opts.doSim) {
      const simStart = Date.now();
      try {
        const isNative = fromAddr.toLowerCase() === WBNB;
        const routerAddress = quote.routerAddress ?? config.routerAddress;
        const stateOverrides = isNative
          ? undefined
          : client.buildStateOverrides(fromAddr, opts.sender, routerAddress, BigInt(amount) * 2n);

        const sim = await client.simulate(quote, opts.slippageBps, opts.sender, stateOverrides);
        result.simLatencyMs = Date.now() - simStart;
        result.simStatus = "SUCCESS";
        result.simAmountOut = sim.amountOut;
        if (result.simAmountOut > 0n && quote.amountOut > 0n) {
          result.simDeviationPct = Number((result.simAmountOut - quote.amountOut) * 10000n / quote.amountOut) / 100;
        }
      } catch (err: any) {
        result.simLatencyMs = Date.now() - simStart;
        result.simStatus = "FAILED";
        result.simError = err.message?.slice(0, 120) ?? String(err);
        const rd = (err as any).data || (err as any).info?.error?.data;
        if (rd) {
          const decoded = decodeRevert(rd, toAddr);
          if (decoded) result.simError = decoded;
        }
      }
    }

    return result;
  } catch (err: any) {
    result.latencyMs = Date.now() - start;
    result.error = err.message?.slice(0, 80);
    return result;
  }
}
