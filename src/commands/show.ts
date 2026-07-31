/**
 * show command: read a quote JSON log and display formatted results.
 * Uses box-drawing characters for clean table rendering.
 */

import * as fs from "fs";

interface RouteEntry {
  dexName: string;
  fromToken: string;
  toToken: string;
  path: string | null;
  percent: number;
}

interface ResultEntry {
  name: string;
  ok: boolean;
  error: string | null;
  amountOut: string;
  amountOutFmt: string | null;
  latencyMs: number;
  gasEstimate: string;
  priceImpact: string;
  routes: RouteEntry[];
  simStatus: string;
  simAmountOutFmt: string | null;
  simLatencyMs: number;
  simError: string | null;
  simDeviationPct: number;
}

interface QuoteLog {
  timestamp: string;
  from: { address: string; symbol: string };
  target: { address: string; symbol: string };
  amountInFmt: string;
  agg: string;
  doSim: boolean;
  sender: string;
  results: ResultEntry[];
}

// ── Box-drawing table ───────────────────────────────────────

function pad(s: string, n: number) { return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); }
function padL(s: string, n: number) { return s.length >= n ? s : " ".repeat(n - s.length) + s; }

type Align = "l" | "r";

function boxTable(headers: string[], rows: string[][], aligns?: Align[]): string {
  const cols = headers.length;
  const al = aligns ?? headers.map(() => "l");
  const cw = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? "").length)));
  const cell = (s: string, i: number) => al[i] === "r" ? padL(s, cw[i]) : pad(s, cw[i]);

  const top    = "┌" + cw.map(w => "─".repeat(w + 2)).join("┬") + "┐";
  const mid    = "├" + cw.map(w => "─".repeat(w + 2)).join("┼") + "┤";
  const bottom = "└" + cw.map(w => "─".repeat(w + 2)).join("┴") + "┘";
  const row = (r: string[]) => "│ " + r.map((c, i) => cell(c ?? "", i)).join(" │ ") + " │";

  const lines = [top, row(headers), mid];
  for (let i = 0; i < rows.length; i++) {
    lines.push(row(rows[i]));
    if (i < rows.length - 1) lines.push(mid);
  }
  lines.push(bottom);
  return lines.join("\n");
}

export async function cmdShow(args: string[]) {
  let format: "default" | "detail" | "json" = "default";
  let logFile = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format" || args[i] === "-f") {
      format = args[++i] as any;
    } else if (!args[i].startsWith("-")) {
      logFile = args[i];
    }
  }

  if (!logFile || !fs.existsSync(logFile)) {
    console.error(`Usage: peach-agg-tool show <log.json> [--format default|detail|json]`);
    process.exit(1);
  }

  const data: QuoteLog = JSON.parse(fs.readFileSync(logFile, "utf-8"));

  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const { from, target, results, doSim } = data;
  const sym = target.symbol;

  // Find best quote and best sim
  const okResults = results.filter(r => r.ok);
  let bestQuoteName = "";
  let bestSimName = "";
  if (okResults.length > 0) {
    bestQuoteName = okResults.reduce((a, b) =>
      parseFloat(a.amountOut) >= parseFloat(b.amountOut) ? a : b
    ).name;
  }
  const simOk = results.filter(r => r.simStatus === "SUCCESS" && r.simAmountOutFmt);
  if (simOk.length > 0) {
    bestSimName = simOk.reduce((a, b) => {
      const aVal = parseFloat(a.simAmountOutFmt?.replace(/[^0-9.]/g, "") ?? "0");
      const bVal = parseFloat(b.simAmountOutFmt?.replace(/[^0-9.]/g, "") ?? "0");
      return aVal >= bVal ? a : b;
    }).name;
  }

  // ── Header ────────────────────────────────────────────────────
  console.log();
  console.log(`  ${data.amountInFmt} ${from.symbol} → ${sym}`);
  console.log();

  // ── Combined Table ────────────────────────────────────────────
  const headers: string[] = ["", `Quote Out (${sym})`];
  const aligns: Align[] = ["l", "r"];

  if (doSim) {
    headers.push(`Sim Out (${sym})`, "Sim", "Diff");
    aligns.push("r", "l", "r");
  }

  headers.push("Gas", "Impact", "Network");
  aligns.push("r", "r", "r");

  if (doSim) {
    headers.push("Sim Time");
    aligns.push("r");
  }

  const rows = results.map(r => {
    const qTag = r.name === bestQuoteName && results.length > 1 ? " ★" : "";
    const outStr = r.ok ? `${r.amountOutFmt}${qTag}` : `ERR: ${(r.error ?? "").slice(0, 20)}`;
    const row: string[] = [r.name, outStr];

    if (doSim) {
      if (r.simStatus === "SUCCESS") {
        const sTag = r.name === bestSimName && results.length > 1 ? " ★" : "";
        const diffStr = `${r.simDeviationPct >= 0 ? "+" : ""}${r.simDeviationPct.toFixed(4)}%`;
        row.push(`${r.simAmountOutFmt}${sTag}`, "✓ OK", diffStr);
      } else if (r.simStatus === "FAILED") {
        row.push("-", "✗ FAIL", (r.simError ?? "").slice(0, 14));
      } else {
        row.push("-", "- SKIP", "-");
      }
    }

    row.push(
      r.gasEstimate,
      r.priceImpact !== "-" ? `${r.priceImpact}%` : "-",
      `${r.latencyMs}ms`,
    );

    if (doSim) {
      row.push(r.simLatencyMs > 0 ? `${r.simLatencyMs}ms` : "-");
    }

    return row;
  });

  console.log(boxTable(headers, rows, aligns));

  // ── Routes (only in detail mode) ──────────────────────────────
  if (format === "detail") {
    const routeSource = results.filter(r => r.ok);
    for (const r of routeSource) {
      if (r.routes.length === 0) continue;
      console.log();
      if (results.length > 1) {
        console.log(`  Routes [${r.name}]`);
      }
      const routeHeaders = ["#", "Path", "DEX", "Pct"];
      const routeRows = r.routes.map((rt, i) => [
        (i + 1).toString(),
        rt.path ?? `${rt.fromToken} → ${rt.toToken}`,
        rt.dexName,
        rt.percent > 0 ? `${(rt.percent * 100).toFixed(0)}%` : "-",
      ]);
      console.log(boxTable(routeHeaders, routeRows, ["r", "l", "l", "r"]));
    }
  }

  console.log();
}
