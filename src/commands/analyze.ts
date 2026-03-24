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

    if (qW === "okx") { qOkx++; qOkxAdv += qD; qOkxUsd += (tradeUsd ?? 0) * qD / 100; }
    else if (qW === "peach") { qPeach++; qPeachAdv += qD; qPeachUsd += (tradeUsd ?? 0) * qD / 100; }
    else if (qW === "tie") qTie++; else if (qW === "both_fail") qFail++;

    if (okx?.simStatus === "SUCCESS") sOkxS++; else if (okx?.simStatus === "FAILED") { sOkxF++; const k = (okx.simError ?? "unknown").slice(0, 60); okxSimErrs[k] = (okxSimErrs[k] ?? 0) + 1; }
    if (peach?.simStatus === "SUCCESS") sPeachS++; else if (peach?.simStatus === "FAILED") { sPeachF++; const k = (peach.simError ?? "unknown").slice(0, 60); peachSimErrs[k] = (peachSimErrs[k] ?? 0) + 1; }

    if (sW === "okx") sOkxW++; else if (sW === "peach") sPeachW++; else if (sW === "tie") sTie++; else if (sW === "both_fail") sFail++;
    if (okx?.simStatus === "SUCCESS" && okx.simDeviationPct !== undefined) { sOkxDevSum += Math.abs(okx.simDeviationPct); sOkxDevN++; }
    if (peach?.simStatus === "SUCCESS" && peach.simDeviationPct !== undefined) { sPeachDevSum += Math.abs(peach.simDeviationPct); sPeachDevN++; }

    if (!pairStats[pair]) pairStats[pair] = { qo: 0, qp: 0, so: 0, sp: 0, oF: 0, pF: 0, n: 0 };
    const ps = pairStats[pair]; ps.n++;
    if (qW === "okx") ps.qo++; if (qW === "peach") ps.qp++;
    if (sW === "okx") ps.so++; if (sW === "peach") ps.sp++;
    if (okx?.simStatus === "FAILED") ps.oF++; if (peach?.simStatus === "FAILED") ps.pF++;

    for (const b of buckets) { if (tradeUsd >= b.min && tradeUsd < b.max) { b.n++; if (qW === "okx") b.qo++; if (qW === "peach") b.qp++; if (sW === "okx") b.so++; if (sW === "peach") b.sp++; if (okx?.simStatus === "FAILED") b.oF++; if (peach?.simStatus === "FAILED") b.pF++; } }

    if (okx?.status === "OK" && okx.routes) {
      const pDex = new Set((peach?.routes ?? []).map((r: any) => r.dexName?.toUpperCase()));
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

  console.log("\n╔═══════════════════════════════════════════════════════════════════════════╗");
  console.log("║          Peach vs OKX — Analysis                                        ║");
  console.log("╠═══════════════════════════════════════════════════════════════════════════╣");
  console.log(`║  Log: ${logFile}`);
  console.log(`║  Rounds: ${total} | Valid quotes: ${qV} | Both fail: ${qFail} | Sim: ${hasSim ? "YES" : "NO"}`);
  console.log("╠═══════════════════════════════════════════════════════════════════════════╣\n");

  console.log("1. QUOTE WIN RATE\n" + "─".repeat(70));
  console.log(`   OKX:   ${qOkx} (${qV > 0 ? (qOkx / qV * 100).toFixed(1) : 0}%)  avg: ${qOkx > 0 ? (qOkxAdv / qOkx).toFixed(3) : 0}%  total: $${fmtN(qOkxUsd)}`);
  console.log(`   Peach: ${qPeach} (${qV > 0 ? (qPeach / qV * 100).toFixed(1) : 0}%)  avg: ${qPeach > 0 ? (qPeachAdv / qPeach).toFixed(3) : 0}%  total: $${fmtN(qPeachUsd)}`);
  console.log(`   Ties:  ${qTie}\n`);

  if (hasSim) {
    console.log("2. SIMULATION\n" + "─".repeat(70));
    const oT = sOkxS + sOkxF, pT = sPeachS + sPeachF;
    console.log(`   Error Rate:  OKX ${sOkxF}/${oT}(${oT > 0 ? (sOkxF / oT * 100).toFixed(1) : 0}%)  Peach ${sPeachF}/${pT}(${pT > 0 ? (sPeachF / pT * 100).toFixed(1) : 0}%)`);
    console.log(`   Sim Winner:  OKX ${sOkxW}(${sV > 0 ? (sOkxW / sV * 100).toFixed(1) : 0}%)  Peach ${sPeachW}(${sV > 0 ? (sPeachW / sV * 100).toFixed(1) : 0}%)  Tie ${sTie}`);
    console.log(`   Deviation:   OKX ${sOkxDevN > 0 ? (sOkxDevSum / sOkxDevN).toFixed(4) : "N/A"}%(${sOkxDevN})  Peach ${sPeachDevN > 0 ? (sPeachDevSum / sPeachDevN).toFixed(4) : "N/A"}%(${sPeachDevN})`);
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
