import * as fs from "fs";
import {
  pad, padL, fmtN, printTable,
} from "../lib/common.js";

export async function cmdAnalyze(args: string[]) {
  const logFile = args[0];
  if (!logFile || !fs.existsSync(logFile)) {
    console.error(`Usage: agg-tool analyze <log.jsonl>\n${logFile ? `File not found: ${logFile}` : ""}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n").map(l => JSON.parse(l));
  const total = lines.length;

  let qOkx = 0, qPeach = 0, qTie = 0, qFail = 0, qOkxAdv = 0, qPeachAdv = 0, qOkxUsd = 0, qPeachUsd = 0;
  let sOkxS = 0, sOkxF = 0, sPeachS = 0, sPeachF = 0, sOkxW = 0, sPeachW = 0, sTie = 0, sFail = 0;
  let sOkxDevSum = 0, sOkxDevN = 0, sPeachDevSum = 0, sPeachDevN = 0;
  let sOkxPos = 0, sOkxNeg = 0, sPeachPos = 0, sPeachNeg = 0;
  let adjustedOkx = 0, adjustedPeach = 0, adjustedTie = 0;
  let qBothOk = 0, qOnlyOkx = 0, qOnlyPeach = 0, qBothFailed = 0;
  let qBothOkxWins = 0, qBothPeachWins = 0, qBothTies = 0;
  let simBothOk = 0, simBothOkxWins = 0, simBothPeachWins = 0, simBothTies = 0;
  const okxQuoteLatency: number[] = [], peachQuoteLatency: number[] = [];
  const okxSlippage: number[] = [], peachSlippage: number[] = [];
  const okxOnlyDex: Record<string, number> = {};
  const allOkxDex: Record<string, number> = {};
  const allPeachDex: Record<string, number> = {};
  const okxSimErrs: Record<string, number> = {};
  const peachSimErrs: Record<string, number> = {};

  const buckets = [
    { label: "<$1K", min: 0, max: 1000 }, { label: "$1K-$10K", min: 1000, max: 10000 },
    { label: "$10K-$50K", min: 10000, max: 50000 }, { label: "$50K-$200K", min: 50000, max: 200000 },
    { label: "$200K-$1M", min: 200000, max: 1000000 }, { label: ">$1M", min: 1000000, max: Infinity },
  ].map(b => ({ ...b, n: 0, qo: 0, qp: 0, so: 0, sp: 0, oF: 0, pF: 0 }));

  const pairStats: Record<string, { qo: number; qp: number; so: number; sp: number; oF: number; pF: number; n: number }> = {};

  for (const e of lines) {
    const { tradeUsd, okx, peach, pair } = e;
    const qW = e.quote?.winner ?? e.winner ?? "none";
    const qD = e.quote?.diffPct ?? e.diffPct ?? 0;
    const sW = e.sim?.winner ?? "none";
    const sD = e.sim?.diffPct ?? 0;

    const okxQuoteOk = okx?.status === "OK";
    const peachQuoteOk = peach?.status === "OK";
    if (okxQuoteOk) okxQuoteLatency.push(okx.latencyMs);
    if (peachQuoteOk) peachQuoteLatency.push(peach.latencyMs);
    if (okxQuoteOk && peachQuoteOk) {
      qBothOk++;
      if (BigInt(okx.amountOut) > BigInt(peach.amountOut)) qBothOkxWins++;
      else if (BigInt(peach.amountOut) > BigInt(okx.amountOut)) qBothPeachWins++;
      else qBothTies++;
    } else if (okxQuoteOk) qOnlyOkx++;
    else if (peachQuoteOk) qOnlyPeach++;
    else qBothFailed++;

    if (qW === "okx") { qOkx++; qOkxAdv += qD; qOkxUsd += (tradeUsd ?? 0) * qD / 100; }
    else if (qW === "peach") { qPeach++; qPeachAdv += qD; qPeachUsd += (tradeUsd ?? 0) * qD / 100; }
    else if (qW === "tie") qTie++; else if (qW === "both_fail") qFail++;

    if (okx?.simStatus === "SUCCESS") sOkxS++; else if (okx?.simStatus === "FAILED") { sOkxF++; const k = (okx.simError ?? "unknown").slice(0, 60); okxSimErrs[k] = (okxSimErrs[k] ?? 0) + 1; }
    if (peach?.simStatus === "SUCCESS") sPeachS++; else if (peach?.simStatus === "FAILED") { sPeachF++; const k = (peach.simError ?? "unknown").slice(0, 60); peachSimErrs[k] = (peachSimErrs[k] ?? 0) + 1; }

    if (sW === "okx") sOkxW++; else if (sW === "peach") sPeachW++; else if (sW === "tie") sTie++; else if (sW === "both_fail") sFail++;
    if (okx?.simStatus === "SUCCESS" && okx.simDeviationPct !== undefined) {
      sOkxDevSum += okx.simDeviationPct; sOkxDevN++;
      okxSlippage.push(okx.simDeviationPct);
      if (okx.simDeviationPct > 0) sOkxPos++; else if (okx.simDeviationPct < 0) sOkxNeg++;
    }
    if (peach?.simStatus === "SUCCESS" && peach.simDeviationPct !== undefined) {
      sPeachDevSum += peach.simDeviationPct; sPeachDevN++;
      peachSlippage.push(peach.simDeviationPct);
      if (peach.simDeviationPct > 0) sPeachPos++; else if (peach.simDeviationPct < 0) sPeachNeg++;
    }
    if (okx?.simStatus === "SUCCESS" && peach?.simStatus === "SUCCESS" && okx.simAmountOut && peach.simAmountOut && peach.amountOut) {
      const okxActual = BigInt(okx.simAmountOut);
      const peachActual = BigInt(peach.simAmountOut);
      const peachQuote = BigInt(peach.amountOut);
      const peachAfterCapture = peachActual > peachQuote ? peachQuote : peachActual;
      simBothOk++;
      if (okxActual > peachActual) simBothOkxWins++; else if (peachActual > okxActual) simBothPeachWins++; else simBothTies++;
      if (okxActual > peachAfterCapture) adjustedOkx++; else if (peachAfterCapture > okxActual) adjustedPeach++; else adjustedTie++;
    }

    if (!pairStats[pair]) pairStats[pair] = { qo: 0, qp: 0, so: 0, sp: 0, oF: 0, pF: 0, n: 0 };
    const ps = pairStats[pair]; ps.n++;
    if (qW === "okx") ps.qo++; if (qW === "peach") ps.qp++;
    if (sW === "okx") ps.so++; if (sW === "peach") ps.sp++;
    if (okx?.simStatus === "FAILED") ps.oF++; if (peach?.simStatus === "FAILED") ps.pF++;

    for (const b of buckets) { if (tradeUsd >= b.min && tradeUsd < b.max) { b.n++; if (qW === "okx") b.qo++; if (qW === "peach") b.qp++; if (sW === "okx") b.so++; if (sW === "peach") b.sp++; if (okx?.simStatus === "FAILED") b.oF++; if (peach?.simStatus === "FAILED") b.pF++; } }

    if (okx?.status === "OK" && okx.routes) {
      const pDex = new Set<string>((peach?.routes ?? []).map((r: any) => String(r.dexName ?? "").toUpperCase()));
      for (const r of okx.routes) {
        allOkxDex[r.dexName] = (allOkxDex[r.dexName] ?? 0) + (r.volumeUsd ?? 0);
        if (qW === "okx") { const m = pDex.has(r.dexName?.toUpperCase()) || [...pDex].some((p: string) => (r.dexName?.includes("PancakeSwap") && p.includes("PANCAKE")) || (r.dexName?.includes("Uniswap") && p.includes("UNISWAP")) || (r.dexName?.includes("DODO") && p.includes("DODO")) || (r.dexName?.includes("Thena") && p.includes("THENA"))); if (!m) okxOnlyDex[r.dexName] = (okxOnlyDex[r.dexName] ?? 0) + (r.volumeUsd ?? 0); }
      }
    }
    if (peach?.status === "OK" && peach.routes) for (const r of peach.routes) allPeachDex[r.dexName] = (allPeachDex[r.dexName] ?? 0) + 1;
  }

  const hasSim = sOkxS + sOkxF + sPeachS + sPeachF > 0;
  const qV = qOkx + qPeach + qTie;
  const sV = sOkxW + sPeachW + sTie;
  const pct = (n: number, d: number) => d > 0 ? (n / d * 100).toFixed(1) : "0.0";
  const percentile = (values: number[], p: number) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  };

  console.log("\n╔═══════════════════════════════════════════════════════════════════════════╗");
  console.log("║          Peach vs OKX — Analysis                                        ║");
  console.log("╠═══════════════════════════════════════════════════════════════════════════╣");
  console.log(`║  Log: ${logFile}`);
  console.log(`║  Rounds: ${total} | Both quote success: ${qBothOk} | Both fail: ${qBothFailed} | Sim: ${hasSim ? "YES" : "NO"}`);
  console.log("╠═══════════════════════════════════════════════════════════════════════════╣\n");

  console.log("1. QUOTE WIN RATE\n" + "─".repeat(70));
  console.log(`   Both success: ${qBothOk} | OKX ${qBothOkxWins} (${pct(qBothOkxWins, qBothOk)}%) | Peach ${qBothPeachWins} (${pct(qBothPeachWins, qBothOk)}%) | Tie ${qBothTies}`);
  console.log(`   One-sided: OKX only ${qOnlyOkx} | Peach only ${qOnlyPeach} | Both failed ${qBothFailed}`);
  console.log(`   Quote latency: OKX p50/p95/p99 ${percentile(okxQuoteLatency, .5).toFixed(0)}/${percentile(okxQuoteLatency, .95).toFixed(0)}/${percentile(okxQuoteLatency, .99).toFixed(0)}ms | Peach ${percentile(peachQuoteLatency, .5).toFixed(0)}/${percentile(peachQuoteLatency, .95).toFixed(0)}/${percentile(peachQuoteLatency, .99).toFixed(0)}ms\n`);

  if (hasSim) {
    console.log("2. SIMULATION\n" + "─".repeat(70));
    const oT = sOkxS + sOkxF, pT = sPeachS + sPeachF;
    console.log(`   Error Rate:  OKX ${sOkxF}/${oT}(${oT > 0 ? (sOkxF / oT * 100).toFixed(1) : 0}%)  Peach ${sPeachF}/${pT}(${pT > 0 ? (sPeachF / pT * 100).toFixed(1) : 0}%)`);
    console.log(`   Both success: ${simBothOk} | OKX ${simBothOkxWins} (${pct(simBothOkxWins, simBothOk)}%) | Peach ${simBothPeachWins} (${pct(simBothPeachWins, simBothOk)}%) | Tie ${simBothTies}`);
    console.log(`   Slippage:    OKX +${sOkxPos} (${pct(sOkxPos, sOkxDevN)}%)/-${sOkxNeg}, median ${percentile(okxSlippage, .5).toFixed(4)}%, avg ${sOkxDevN > 0 ? (sOkxDevSum / sOkxDevN).toFixed(4) : "N/A"}%`);
    console.log(`                Peach +${sPeachPos} (${pct(sPeachPos, sPeachDevN)}%)/-${sPeachNeg}, median ${percentile(peachSlippage, .5).toFixed(4)}%, avg ${sPeachDevN > 0 ? (sPeachDevSum / sPeachDevN).toFixed(4) : "N/A"}%`);
    console.log(`   Peach captures all positive slippage (${adjustedOkx + adjustedPeach + adjustedTie} comparable): OKX ${adjustedOkx} (${pct(adjustedOkx, adjustedOkx + adjustedPeach + adjustedTie)}%)  Peach ${adjustedPeach} (${pct(adjustedPeach, adjustedOkx + adjustedPeach + adjustedTie)}%)  Tie ${adjustedTie}`);
    const topOE = Object.entries(okxSimErrs).sort(([, a], [, b]) => b - a).slice(0, 3);
    const topPE = Object.entries(peachSimErrs).sort(([, a], [, b]) => b - a).slice(0, 3);
    if (topOE.length) { console.log("   OKX errors:"); for (const [e, n] of topOE) console.log(`     ${n}x ${e}`); }
    if (topPE.length) { console.log("   Peach errors:"); for (const [e, n] of topPE) console.log(`     ${n}x ${e}`); }
    console.log();
  }

  const sn = hasSim ? 3 : 2;
  console.log(`${sn}. BY TRADE SIZE\n` + "─".repeat(70));
  const bH = hasSim ? ["Bucket", "N", "Q:OKX", "Q:PCH", "S:OKX", "S:PCH", "OKX Err", "PCH Err"] : ["Bucket", "N", "OKX", "Peach", "OKX%"];
  const bR = buckets.filter(b => b.n > 0).map(b => hasSim
    ? [b.label, b.n.toString(), b.qo.toString(), b.qp.toString(), b.so.toString(), b.sp.toString(), `${(b.oF / b.n * 100).toFixed(0)}%`, `${(b.pF / b.n * 100).toFixed(0)}%`]
    : [b.label, b.n.toString(), b.qo.toString(), b.qp.toString(), `${(b.qo / b.n * 100).toFixed(0)}%`]);
  printTable(bH, bR, hasSim ? ["l", "r", "r", "r", "r", "r", "r", "r"] : ["l", "r", "r", "r", "r"]);
  console.log();

  const missing = Object.entries(okxOnlyDex).sort(([, a], [, b]) => b - a);
  if (missing.length) {
    console.log(`${sn + 1}. MISSING DEXes (OKX-only when OKX wins)\n` + "─".repeat(70));
    for (const [d, v] of missing.slice(0, 10)) console.log(`   ${pad(d, 28)} $${fmtN(v)}`);
    console.log();
  }

  const pe = Object.entries(pairStats).filter(([, v]) => v.n >= 2).sort(([, a], [, b]) => (b.qo / (b.qo + b.qp || 1)) - (a.qo / (a.qo + a.qp || 1)));
  if (pe.length) {
    console.log(`${sn + 2}. WORST PAIRS FOR PEACH\n` + "─".repeat(70));
    const pH = hasSim ? ["Pair", "N", "Q:OKX", "Q:PCH", "S:OKX", "S:PCH"] : ["Pair", "N", "OKX", "Peach"];
    const pR = pe.slice(0, 15).map(([p, v]) => hasSim ? [p, v.n.toString(), v.qo.toString(), v.qp.toString(), v.so.toString(), v.sp.toString()] : [p, v.n.toString(), v.qo.toString(), v.qp.toString()]);
    printTable(pH, pR, hasSim ? ["l", "r", "r", "r", "r", "r"] : ["l", "r", "r", "r"]);
    console.log();
  }

  console.log("╚═══════════════════════════════════════════════════════════════════════════╝");
}
