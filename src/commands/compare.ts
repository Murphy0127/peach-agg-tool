import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import {
  pad, padL, fmtN, printKV, printTable, sleep, appendLog, findSender,
  NATIVE_TOKEN, WBNB, USDT, USDC, TARGET_TOKENS,
  loadTokenPool, type AggResult,
} from "../lib/common.js";
import { queryOkx } from "../lib/okx.js";
import { queryPeach } from "../lib/peach.js";
import { tokenLabel, fmtAmt } from "../lib/tokens.js";

export async function cmdCompare(args: string[]) {
  let duration = 60, interval = 10, minUsd = 10000, maxUsd = 1000000;
  let outDir = "/tmp/aggregator", rpcUrl = "https://bsc-dataseed.bnbchain.org";
  let apiUrl = "https://api.cipheron.org", slippageBps = 50, doSim = true;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--duration":  duration = parseInt(args[++i]); break;
      case "--interval":  interval = parseInt(args[++i]); break;
      case "--min-usd":   minUsd = parseInt(args[++i]); break;
      case "--max-usd":   maxUsd = parseInt(args[++i]); break;
      case "--out":       outDir = args[++i]; break;
      case "--rpc":       rpcUrl = args[++i]; break;
      case "--api":       apiUrl = args[++i]; break;
      case "--slippage":  slippageBps = parseInt(args[++i]); break;
      case "--no-sim":    doSim = false; break;
    }
  }

  const endTime = Date.now() + duration * 60_000;
  fs.mkdirSync(outDir, { recursive: true });
  const tsStr = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(outDir, `compare-${tsStr}.jsonl`);
  const statsPath = path.join(outDir, `compare-stats-${tsStr}.json`);
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║       Peach vs OKX Aggregator Comparison (Quote + Sim)       ║");
  console.log("╠═══════════════════════════════════════════════════════════════╣");
  console.log(`║  Duration:   ${duration} min | Interval: ${interval} sec`);
  console.log(`║  Trade $:    $${fmtN(minUsd)} - $${fmtN(maxUsd)}`);
  console.log(`║  Simulation: ${doSim ? "ON" : "OFF"} | Slippage: ${slippageBps}bps`);
  console.log(`║  Log:        ${logPath}`);
  console.log(`║  Peach API:  ${apiUrl}`);
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");

  const tokens = loadTokenPool();
  console.log(`Loaded ${tokens.length} tokens from tokens.json\n`);

  let round = 0;
  let qStats = { okxWins: 0, peachWins: 0, ties: 0, bothFail: 0 };
  let sStats = { okxSuccess: 0, okxFail: 0, peachSuccess: 0, peachFail: 0, okxWins: 0, peachWins: 0, ties: 0, bothFail: 0, okxDevSum: 0, okxDevN: 0, peachDevSum: 0, peachDevN: 0 };
  let okxOnlyDexVol: Record<string, number> = {};
  let totalOkxAdvUsd = 0;
  let backoffMs = 0;

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
    const peachTarget = target.address === NATIVE_TOKEN ? WBNB : target.address;
    const isNative = token.peachAddress.toLowerCase() === WBNB;
    const sender = doSim ? await findSender(provider, token.okxAddress === NATIVE_TOKEN ? WBNB : token.address, amountRaw, isNative) : "0xF977814e90dA44bFA03b6295A0616a897441aceC";

    const [okx, peach] = await Promise.all([
      queryOkx(token.okxAddress, target.address, amountRaw.toString(), tradeUsd, { sender, slippageBps, provider, doSim }),
      queryPeach(token.peachAddress, peachTarget, amountRaw.toString(), tradeUsd, { apiUrl, rpcUrl, sender, slippageBps, provider, doSim }),
    ]);

    if (okx.error?.includes("Too Many Requests") || okx.error?.includes("429")) backoffMs = Math.min(30000, Math.max(5000, backoffMs + 5000));

    // Quote winner
    let qWinner = "none", qDiff = 0;
    if (okx.ok && peach.ok) {
      if (okx.amountOut > peach.amountOut) { qWinner = "okx"; qStats.okxWins++; qDiff = Number((okx.amountOut - peach.amountOut) * 10000n / peach.amountOut) / 100; totalOkxAdvUsd += tradeUsd * qDiff / 100;
        const pDex = new Set(peach.routes.map(r => r.dexName.toUpperCase()));
        for (const r of okx.routes) { const m = pDex.has(r.dexName.toUpperCase()) || [...pDex].some((p: string) => (r.dexName.includes("PancakeSwap") && p.includes("PANCAKE")) || (r.dexName.includes("Uniswap") && p.includes("UNISWAP")) || (r.dexName.includes("DODO") && p.includes("DODO")) || (r.dexName.includes("Thena") && p.includes("THENA"))); if (!m) okxOnlyDexVol[r.dexName] = (okxOnlyDexVol[r.dexName] ?? 0) + r.volumeUsd; }
      } else if (peach.amountOut > okx.amountOut) { qWinner = "peach"; qStats.peachWins++; qDiff = Number((peach.amountOut - okx.amountOut) * 10000n / okx.amountOut) / 100; }
      else { qWinner = "tie"; qStats.ties++; }
    } else if (!okx.ok && !peach.ok) { qWinner = "both_fail"; qStats.bothFail++; }
    else { qWinner = okx.ok ? "okx" : "peach"; if (okx.ok) qStats.okxWins++; else qStats.peachWins++; }

    // Sim stats
    if (okx.simStatus === "SUCCESS") sStats.okxSuccess++; else if (okx.simStatus === "FAILED") sStats.okxFail++;
    if (peach.simStatus === "SUCCESS") sStats.peachSuccess++; else if (peach.simStatus === "FAILED") sStats.peachFail++;
    if (okx.simStatus === "SUCCESS" && okx.simAmountOut > 0n) { sStats.okxDevSum += Math.abs(okx.simDeviationPct); sStats.okxDevN++; }
    if (peach.simStatus === "SUCCESS" && peach.simAmountOut > 0n) { sStats.peachDevSum += Math.abs(peach.simDeviationPct); sStats.peachDevN++; }

    let sWinner = "none", sDiff = 0;
    const okxSimOk = okx.simStatus === "SUCCESS" && okx.simAmountOut > 0n;
    const peachSimOk = peach.simStatus === "SUCCESS" && peach.simAmountOut > 0n;
    if (okxSimOk && peachSimOk) {
      if (okx.simAmountOut > peach.simAmountOut) { sWinner = "okx"; sStats.okxWins++; sDiff = Number((okx.simAmountOut - peach.simAmountOut) * 10000n / peach.simAmountOut) / 100; }
      else if (peach.simAmountOut > okx.simAmountOut) { sWinner = "peach"; sStats.peachWins++; sDiff = Number((peach.simAmountOut - okx.simAmountOut) * 10000n / okx.simAmountOut) / 100; }
      else { sWinner = "tie"; sStats.ties++; }
    } else if (okx.simStatus !== "SKIPPED" || peach.simStatus !== "SKIPPED") {
      if (!okxSimOk && !peachSimOk) { sWinner = "both_fail"; sStats.bothFail++; }
      else { sWinner = okxSimOk ? "okx" : "peach"; if (okxSimOk) sStats.okxWins++; else sStats.peachWins++; }
    }

    // Console
    const qt = qWinner === "okx" ? `Q:OKX +${qDiff.toFixed(2)}%` : qWinner === "peach" ? `Q:PCH +${qDiff.toFixed(2)}%` : qWinner === "tie" ? "Q:TIE" : qWinner === "both_fail" ? "Q:FAIL" : qWinner;
    const st = doSim ? (sWinner === "okx" ? `S:OKX +${sDiff.toFixed(2)}%` : sWinner === "peach" ? `S:PCH +${sDiff.toFixed(2)}%` : sWinner === "tie" ? "S:TIE" : sWinner === "both_fail" ? "S:FAIL" : "S:--") : "";
    process.stdout.write(`  [R${round}] ${pad(pairKey, 16)} $${padL(fmtN(tradeUsd), 8)}  ${pad(qt, 18)} ${pad(st, 18)}\n`);

    // Log
    appendLog(logPath, {
      round, time: new Date().toISOString(), pair: pairKey, from: token.symbol, fromAddr: token.address, target: target.symbol, targetAddr: target.address, tradeUsd, amountIn: amountRaw.toString(),
      quote: { winner: qWinner, diffPct: qDiff }, sim: { winner: sWinner, diffPct: sDiff },
      okx: { status: okx.ok ? "OK" : "ERROR", amountOut: okx.ok ? okx.amountOut.toString() : null, latencyMs: okx.latencyMs, error: okx.error ?? null, routes: okx.routes, simStatus: okx.simStatus, simAmountOut: okx.simAmountOut > 0n ? okx.simAmountOut.toString() : null, simLatencyMs: okx.simLatencyMs, simError: okx.simError ?? null, simDeviationPct: okx.simDeviationPct },
      peach: { status: peach.ok ? "OK" : "ERROR", amountOut: peach.ok ? peach.amountOut.toString() : null, latencyMs: peach.latencyMs, error: peach.error ?? null, routes: peach.routes, simStatus: peach.simStatus, simAmountOut: peach.simAmountOut > 0n ? peach.simAmountOut.toString() : null, simLatencyMs: peach.simLatencyMs, simError: peach.simError ?? null, simDeviationPct: peach.simDeviationPct },
    });

    // Summary every 10 rounds
    if (round % 10 === 0) {
      const qT = qStats.okxWins + qStats.peachWins + qStats.ties + qStats.bothFail;
      const sT = sStats.okxWins + sStats.peachWins + sStats.ties + sStats.bothFail;
      console.log(`\n  ── Round ${round} Summary ──`);
      console.log(`  [Quote] OKX: ${qStats.okxWins}(${qT > 0 ? (qStats.okxWins / qT * 100).toFixed(1) : 0}%) | Peach: ${qStats.peachWins}(${qT > 0 ? (qStats.peachWins / qT * 100).toFixed(1) : 0}%) | Tie: ${qStats.ties} | Fail: ${qStats.bothFail}`);
      if (doSim) {
        console.log(`  [Sim]   OKX: ${sStats.okxWins}(${sT > 0 ? (sStats.okxWins / sT * 100).toFixed(1) : 0}%) | Peach: ${sStats.peachWins}(${sT > 0 ? (sStats.peachWins / sT * 100).toFixed(1) : 0}%) | Tie: ${sStats.ties} | Fail: ${sStats.bothFail}`);
        const okxET = sStats.okxSuccess + sStats.okxFail; const pET = sStats.peachSuccess + sStats.peachFail;
        console.log(`  [Sim Error] OKX: ${sStats.okxFail}/${okxET}(${okxET > 0 ? (sStats.okxFail / okxET * 100).toFixed(1) : 0}%) | Peach: ${sStats.peachFail}/${pET}(${pET > 0 ? (sStats.peachFail / pET * 100).toFixed(1) : 0}%)`);
        console.log(`  [Deviation] OKX: ${sStats.okxDevN > 0 ? (sStats.okxDevSum / sStats.okxDevN).toFixed(4) : "-"}% | Peach: ${sStats.peachDevN > 0 ? (sStats.peachDevSum / sStats.peachDevN).toFixed(4) : "-"}%`);
      }
      console.log();
    }

    // Save stats
    fs.writeFileSync(statsPath, JSON.stringify({ lastUpdate: new Date().toISOString(), roundsCompleted: round, quote: qStats, simulation: doSim ? sStats : null, totalOkxAdvantageUsd: totalOkxAdvUsd, okxOnlyDexVolume: okxOnlyDexVol, logFile: logPath }, null, 2), "utf-8");

    const waitMs = Math.max(0, interval * 1000 - (Date.now() - roundStart));
    if (waitMs > 0 && Date.now() + waitMs < endTime) await sleep(waitMs);
  }

  console.log(`\nDone. ${round} rounds. Log: ${logPath}\nAnalyze: npx peach-agg-tool analyze ${logPath}`);
}
