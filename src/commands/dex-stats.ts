import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import {
  pad, padL, fmtN, sleep, appendLog,
  NATIVE_TOKEN, WBNB, TARGET_TOKENS,
  loadTokenPool,
} from "../lib/common.js";
import { fetchOkxQuote } from "../lib/okx.js";

export async function cmdDexStats(args: string[]) {
  let duration = 60, interval = 10, minUsd = 10000, maxUsd = 1000000;
  let outPath = "/tmp/aggregator/okx-dex-stats.json", rpcUrl = "https://bsc-dataseed.bnbchain.org";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--duration":  duration = parseInt(args[++i]); break;
      case "--interval":  interval = parseInt(args[++i]); break;
      case "--min-usd":   minUsd = parseInt(args[++i]); break;
      case "--max-usd":   maxUsd = parseInt(args[++i]); break;
      case "--out":       outPath = args[++i]; break;
      case "--rpc":       rpcUrl = args[++i]; break;
    }
  }

  const endTime = Date.now() + duration * 60_000;
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  const tsStr = new Date().toISOString().replace(/[:.]/g, "-");
  const detailPath = path.join(dir, `okx-dex-details-${tsStr}.jsonl`);

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║       OKX DEX Usage Statistics Collector            ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Duration:  ${duration} min | Interval: ${interval} sec`);
  console.log(`║  Trade $:   $${fmtN(minUsd)} - $${fmtN(maxUsd)}`);
  console.log(`║  Output:    ${outPath}`);
  console.log("╚══════════════════════════════════════════════════════╝\n");

  const tokens = loadTokenPool();
  console.log(`Loaded ${tokens.length} tokens | Detail log: ${detailPath}\n`);

  const dexVol: Record<string, number> = {};
  let totalVol = 0, totalQueries = 0, totalErrors = 0, round = 0, backoffMs = 0;
  const startTime = Date.now();

  while (Date.now() < endTime) {
    round++;
    const roundStart = Date.now();
    if (backoffMs > 0) { process.stdout.write(`  [backoff] ${(backoffMs / 1000).toFixed(0)}s...\n`); await sleep(backoffMs); backoffMs = 0; }

    const token = tokens[Math.floor(Math.random() * tokens.length)];
    const validTargets = TARGET_TOKENS.filter(t => token.okxAddress !== t.address && token.address !== t.address);
    if (validTargets.length === 0) continue;
    const target = validTargets[Math.floor(Math.random() * validTargets.length)];

    const tradeUsd = minUsd + Math.random() * (maxUsd - minUsd);
    const tokenAmount = tradeUsd / token.priceUsd;
    const amountRaw = ethers.parseUnits(tokenAmount.toFixed(Math.min(token.decimals, 8)), token.decimals);
    const pairKey = `${token.symbol}->${target.symbol}`;

    totalQueries++;
    const result = await fetchOkxQuote(token.okxAddress, target.address, amountRaw.toString());

    if (!result.ok) {
      totalErrors++;
      if (result.error?.includes("Too Many Requests") || result.error?.includes("429")) {
        backoffMs = Math.min(30000, Math.max(5000, backoffMs + 5000));
        process.stdout.write(`  [R${round}] ${pad(pairKey, 16)} RATE LIMITED\n`);
      } else {
        process.stdout.write(`  [R${round}] ${pad(pairKey, 16)} $${padL(fmtN(tradeUsd), 8)} ERR: ${result.error?.slice(0, 50)}\n`);
      }
      appendLog(detailPath, { round, time: new Date().toISOString(), pair: pairKey, tradeUsd, status: "ERROR", error: result.error });
    } else {
      const data = result.data;
      const fromPrice = parseFloat(data.fromToken?.tokenUnitPrice ?? "0");
      const fromAmountRaw = BigInt(data.fromTokenAmount ?? "0");
      const fromDec = parseInt(data.fromToken?.decimal ?? "18");
      const quoteVol = parseFloat(ethers.formatUnits(fromAmountRaw, fromDec)) * fromPrice;
      const toAmountRaw = BigInt(data.toTokenAmount ?? "0");
      const toDec = parseInt(data.toToken?.decimal ?? "18");
      const toHuman = parseFloat(ethers.formatUnits(toAmountRaw, toDec));

      const dexNames: string[] = [];
      for (const route of data.dexRouterList ?? []) {
        const name = route.dexProtocol?.dexName ?? "Unknown";
        const pct = parseFloat(route.dexProtocol?.percent ?? "100") / 100;
        const vol = quoteVol * pct;
        dexVol[name] = (dexVol[name] ?? 0) + vol;
        totalVol += vol;
        dexNames.push(name);
      }
      if (fromPrice > 0) token.priceUsd = fromPrice;

      const top = dexNames.slice(0, 3).join(", ");
      process.stdout.write(`  [R${round}] ${pad(pairKey, 16)} $${padL(fmtN(tradeUsd), 8)} -> ${padL(toHuman.toFixed(2), 12)} ${target.symbol}  [${top}]\n`);
      appendLog(detailPath, { round, time: new Date().toISOString(), pair: pairKey, tradeUsd, status: "OK", routes: dexNames });
    }

    // Save stats
    const elapsed = (Date.now() - startTime) / 60000;
    fs.writeFileSync(outPath, JSON.stringify({ startTime: new Date(startTime).toISOString(), lastUpdate: new Date().toISOString(), elapsedMin: elapsed, rounds: round, queries: totalQueries, errors: totalErrors, totalVolumeUsd: totalVol, dexVolume: dexVol }, null, 2), "utf-8");

    // Print summary every 20 rounds
    if (round % 20 === 0) {
      console.log();
      console.log(`  ── DEX Volume Distribution (Round ${round}, ${elapsed.toFixed(1)} min) ──`);
      const sorted = Object.entries(dexVol).sort(([, a], [, b]) => b - a);
      for (const [dex, vol] of sorted) {
        const pct = (vol / (totalVol || 1) * 100).toFixed(1);
        const bar = "█".repeat(Math.round(vol / (totalVol || 1) * 30));
        console.log(`  ${pad(dex, 28)} ${padL("$" + fmtN(vol), 14)} ${padL(pct + "%", 7)}  ${bar}`);
      }
      console.log();
    }

    const waitMs = Math.max(0, interval * 1000 - (Date.now() - roundStart));
    if (waitMs > 0 && Date.now() + waitMs < endTime) await sleep(waitMs);
  }

  console.log(`\nDone. ${round} rounds. Stats: ${outPath}`);
}
