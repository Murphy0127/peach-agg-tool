/**
 * OKX aggregator: quote + simulation.
 */

import { ethers } from "ethers";
import {
  proxyFetch, okxHeaders, getOkxApproveSpender, buildErc20StateOverrides,
  decodeRevert, NATIVE_TOKEN, type AggResult, emptyResult,
} from "./common.js";

export interface OkxQueryOpts {
  sender: string;
  slippageBps: number;
  provider: ethers.JsonRpcProvider;
  doSim: boolean;
  /** OKX DEX IDs filter */
  dexIds?: string;
}

/**
 * Query OKX swap API and optionally simulate via eth_call.
 */
export async function queryOkx(
  fromAddr: string, toAddr: string, amount: string, tradeUsd: number, opts: OkxQueryOpts,
): Promise<AggResult> {
  const result = emptyResult("OKX", BigInt(amount));
  const slippagePct = (opts.slippageBps / 100).toString();

  const params = new URLSearchParams({
    chainIndex: "56", fromTokenAddress: fromAddr, toTokenAddress: toAddr, amount,
    slippagePercent: slippagePct, userWalletAddress: opts.sender,
  });
  if (opts.dexIds) params.set("dexIds", opts.dexIds);

  // Use swap endpoint when simulating (returns tx data), quote endpoint otherwise
  const reqPath = opts.doSim
    ? `/api/v6/dex/aggregator/swap?${params}`
    : `/api/v6/dex/aggregator/quote?${params}`;

  const start = Date.now();
  try {
    const resp = await proxyFetch(`https://www.okx.com${reqPath}`, {
      headers: okxHeaders("GET", reqPath), signal: AbortSignal.timeout(15000),
    });
    const json = await resp.json() as any;
    result.latencyMs = Date.now() - start;
    result.rawApiResponse = json;

    if (json.code !== "0" || !json.data?.length) {
      result.error = json.msg ?? `code=${json.code}`;
      return result;
    }

    const rawData = json.data[0];
    const data = rawData.routerResult ?? rawData;
    const toAmountRaw = BigInt(data.toTokenAmount ?? "0");
    const toPrice = parseFloat(data.toToken?.tokenUnitPrice ?? "0");
    const toDec = parseInt(data.toToken?.decimal ?? "18");
    const toAmountHuman = parseFloat(ethers.formatUnits(toAmountRaw, toDec));

    result.ok = true;
    result.amountOut = toAmountRaw;
    result.amountOutUsd = toAmountHuman * toPrice;
    result.gasEstimate = data.estimateGasFee ?? "-";
    result.priceImpact = data.priceImpactPercent ?? "-";

    result.routes = (data.dexRouterList ?? []).map((r: any) => ({
      dexName: r.dexProtocol?.dexName ?? "Unknown",
      percent: parseFloat(r.dexProtocol?.percent ?? "100") / 100,
      volumeUsd: tradeUsd * (parseFloat(r.dexProtocol?.percent ?? "100") / 100),
      fromToken: r.fromToken?.tokenSymbol ?? "?",
      toToken: r.toToken?.tokenSymbol ?? "?",
      path: `${r.fromToken?.tokenSymbol ?? "-"} -> ${r.toToken?.tokenSymbol ?? "-"}`,
    }));

    // Simulate if swap endpoint returned tx data
    const tx = rawData.tx;
    if (opts.doSim && tx) {
      result.txData = { to: tx.to, data: tx.data, value: tx.value ?? "0", gas: tx.gas ?? "0" };
      const simStart = Date.now();
      try {
        const isFromNative = fromAddr.toLowerCase() === NATIVE_TOKEN;
        let callResult: string;

        if (!isFromNative) {
          const spender = await getOkxApproveSpender();
          const stateOverrides = buildErc20StateOverrides(
            fromAddr, opts.sender, spender, BigInt(amount) * 2n,
          );
          const valueHex = BigInt(tx.value || "0") > 0n ? '0x' + BigInt(tx.value).toString(16) : undefined;
          callResult = await opts.provider.send('eth_call', [
            { from: opts.sender, to: tx.to, data: tx.data, value: valueHex },
            'latest', stateOverrides,
          ]);
        } else {
          callResult = await opts.provider.call({
            from: opts.sender, to: tx.to, data: tx.data,
            value: BigInt(tx.value || "0"), gasLimit: BigInt(tx.gas || "500000") * 3n,
          });
        }

        result.simLatencyMs = Date.now() - simStart;
        result.simStatus = "SUCCESS";
        if (callResult.length >= 66) {
          const ret = BigInt("0x" + callResult.slice(2, 66));
          if (ret > 0n) result.simAmountOut = ret;
        }
        if (result.simAmountOut > 0n && toAmountRaw > 0n) {
          result.simDeviationPct = Number((result.simAmountOut - toAmountRaw) * 10000n / toAmountRaw) / 100;
        }
      } catch (err: any) {
        result.simLatencyMs = Date.now() - simStart;
        result.simStatus = "FAILED";
        result.simError = err.message?.slice(0, 120) ?? String(err);
        const rd = err.data || err.info?.error?.data;
        if (rd) {
          const decoded = decodeRevert(rd, "");
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

/**
 * Simple OKX quote (no simulation, for dex-stats).
 */
export async function fetchOkxQuote(
  fromAddr: string, toAddr: string, amount: string,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const params = new URLSearchParams({
    chainIndex: "56", fromTokenAddress: fromAddr, toTokenAddress: toAddr, amount,
  });
  const reqPath = `/api/v6/dex/aggregator/quote?${params}`;
  try {
    const resp = await proxyFetch(`https://www.okx.com${reqPath}`, {
      headers: okxHeaders("GET", reqPath), signal: AbortSignal.timeout(10000),
    });
    const json = await resp.json() as any;
    if (json.code !== "0" || !json.data?.length) {
      return { ok: false, error: json.msg ?? `code=${json.code}` };
    }
    return { ok: true, data: json.data[0] };
  } catch (err: any) {
    return { ok: false, error: err.message?.slice(0, 80) ?? String(err) };
  }
}
