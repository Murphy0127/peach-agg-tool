import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ethers } from "ethers";
import { computeExecutionRouteHash, computeExecutionPlanStructHash, encodeExecutionRouterCalldata, PEACH_EXECUTION_ROUTER_ABI, type ExecutionPlan, type SwapParams } from "@masterpeach/aggregator-sdk";
import type { Case, Result } from "../src/lib/benchmark-model.js";
// All network calls in this suite target local fixtures.
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete process.env[key];
const { chainToken, differenceBps, analyze, query, simulate } = await import("../src/lib/benchmark.js");
const { rpc, discoverSender, snapshot, ERC20 } = await import("../src/lib/benchmark-rpc.js");
const { defaultProfiles } = await import("../src/lib/benchmark-model.js");
const { fetchQuote, build, cleanEvidence } = await import("../src/lib/benchmark-upstream.js");
const { requiredNative, verifyPeachReceipt } = await import("../src/lib/benchmark-execution.js");
const sender = "0x1111111111111111111111111111111111111111", token = "0x2222222222222222222222222222222222222222", router = "0x3333333333333333333333333333333333333333";
const hash = `0x${"ab".repeat(32)}`;
const base: Case = { chainId: 56, from: chainToken(56, "USDT"), target: token, amountIn: "100000000000000000001", sender, slippageBps: 50, block: "0x10", blockMeta: {number: "0x10", hash, timestamp: Math.floor(Date.now()/1000)}, gasPrice: "1", doSim: true };
const word = (n: bigint) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
const profile = (api: string, kind: "peach"|"kyber"|"okx"|"fly" = "peach") => ({ name: kind, kind, api });
const peachQuote = (c = base, amount = "1100") => ({code: 200, data: {amount_in: c.amountIn, amount_out: amount, request_id: hash,
  paths: [{provider: "PANCAKEV3", pool: router, token_in: c.from, token_out: c.target, amount_in: c.amountIn, amount_out: amount, fee_rate: "0.0005"}]}});
async function server(handler: (req: http.IncomingMessage, body: any) => any, run: (url: string) => Promise<void>) {
  const s = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    try { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(handler(req, text ? JSON.parse(text) : undefined))); }
    catch (error) { res.statusCode = 500; res.end(JSON.stringify({error: String(error)})); }
  });
  await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${(s.address() as any).port}`); }
  finally { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); }
}
function reply(body: any, result: unknown) { return {jsonrpc: "2.0", id: body.id, result}; }
function preflight(body: any, options: {balance?: bigint; native?: bigint; code?: string} = {}) {
  if (body.method === "eth_getCode") return reply(body, options.code ?? "0x");
  if (body.method === "eth_getBalance") return reply(body, ethers.toQuantity(options.native ?? 10n**25n));
  if (body.method === "eth_call") return reply(body, word(options.balance ?? BigInt(base.amountIn)*2n));
  throw new Error(`Unexpected method ${body.method}`);
}
function simulated(body: any, options: {output?: bigint; fail?: number; allowance?: bigint; receipt?: string; timeOffset?: number} = {}) {
  const calls = body.params[0].blockStateCalls[0].calls;
  assert.equal(calls.length, 8); assert.equal(body.params[1], base.block);
  assert.equal(body.params[0].blockStateCalls[0].stateOverrides, undefined);
  const values = [word(1n), word(1n), word(options.allowance ?? BigInt(base.amountIn)), word(BigInt(base.amountIn)*2n), word(500n), options.receipt ?? "0x", word(BigInt(base.amountIn)), word(500n+(options.output ?? 1005n))];
  return reply(body, [{number: "0x11", parentHash: hash, timestamp: ethers.toQuantity(base.blockMeta!.timestamp+1+(options.timeOffset ?? 0)),
    calls: values.map((returnData, i) => ({status: options.fail === i ? "0x0" : "0x1", returnData, gasUsed: "0x5208", ...(options.fail === i ? {error:{message:"fixture revert"}}:{})}))}]);
}
function signedBuild(c = base) {
  const wallet = ethers.Wallet.createRandom(); // test-only ephemeral signer
  const deadline = BigInt(Math.floor(Date.now()/1000)+300);
  const params: SwapParams = {srcToken:c.from,dstToken:c.target,amountIn:BigInt(c.amountIn),amountOutMin:995n,expectAmountOut:1000n,
    steps:[{adapter:router,pool:router,tokenIn:c.from,tokenOut:c.target,amountIn:BigInt(c.amountIn),extraData:"0x"}],intermediateTokens:[],deadline,quoteId:hash,feeReceiver:ethers.ZeroAddress,feeBps:0};
  const logicalPoolIds=[hash], amountModes=[0];
  const plan: ExecutionPlan = {version:1n,signerVersion:1n,chainId:BigInt(c.chainId),router,payer:c.sender,executor:c.sender,recipient:c.recipient??c.sender,
    tokenIn:c.from,tokenOut:c.target,nativeMode:0,fundingMode:0,amountIn:BigInt(c.amountIn),minAmountOut:995n,expectedAmountOut:1000n,quoteId:hash,
    routeHash:computeExecutionRouteHash(params,logicalPoolIds,amountModes),settlementPolicyHash:hash,customFeeBps:0n,customFeeReceiver:ethers.ZeroAddress,deadline,nonce:BigInt(hash)};
  const domain=ethers.TypedDataEncoder.hashDomain({name:c.chainId===56?"Peach Router Execution":"Arc Router Execution",version:"1",chainId:c.chainId,verifyingContract:router});
  const digest=ethers.keccak256(ethers.concat(["0x1901",domain,computeExecutionPlanStructHash(plan)]));
  const signature=wallet.signingKey.sign(digest).serialized;
  const data=encodeExecutionRouterCalldata({plan,routerParams:params,logicalPoolIds,amountModes,payerSignature:"0x",aggregatorSignature:signature});
  const raw={code:200,data:{amount_in:c.amountIn,amount_out:"1000",expect_amount_out:"1000",custom_fee_bps:0,custom_fee_amount:"0",payer:c.sender,executor:c.sender,recipient:c.recipient??c.sender,
    contracts:{execution_router:router},tx:{to:router,data,value:"0",amount_out_min:"995"}}};
  const receipt = new ethers.Interface(PEACH_EXECUTION_ROUTER_ABI).encodeFunctionResult("executePlan",[[digest,c.sender,c.sender,c.recipient??c.sender,c.target,c.amountIn,c.amountIn,"1005"]]);
  return {wallet,raw,receipt,digest};
}

test("network catalog matches Manager and preserves BNB/WBNB distinction",()=>{
  assert.notEqual(chainToken(56,"BNB"),chainToken(56,"WBNB"));
  assert.equal(chainToken(5042,"USDC"),"0x3600000000000000000000000000000000000000");
  assert.throws(()=>chainToken(5042002,"WUSDC"));
  assert.equal(defaultProfiles("arc",["peach-prod"])[0].api,"https://api.peach.ag/arc");
  assert.equal(defaultProfiles("arc",["peach-pre"])[0].api,"https://api-arc.cipheron.org/arc-mainnet");
  assert.throws(()=>defaultProfiles("bsc",["fly"]));
});
test("precise arithmetic, baseline failures and execution ranking",()=>{
  assert.equal(differenceBps("990000000000000000000000000000","1000000000000000000000000000000"),"-100");
  assert.equal(differenceBps("1000001","1000000"),"0.01"); assert.equal(differenceBps("1","0"),null);
  const rows:Result[]=[{name:"Peach",kind:"peach",ok:true,latencyMs:1,amountOut:"1000",builtAmountOut:"990",simulation:{status:"SUCCESS",amountOut:"900"}},
    {name:"other",ok:true,latencyMs:1,amountOut:"1100",simulation:{status:"UNAVAILABLE"}}];
  const report=analyze(rows);
  assert.equal(report.bestQuote,"other");assert.equal(report.bestSimulation,"Peach");
  assert.equal(report.comparisons[0].quoteToBuildBps,"-100");assert.equal(report.comparisons[1].simulationGapBps,null);
  assert.equal(analyze(rows,"missing").baseline,null);
});
test("initial quote, refreshed build and signed receipt remain separate",async()=>{
  const fixture=signedBuild();
  await server((req,body)=>{
    if(req.method==="GET") return req.url!.startsWith("/router/find_routes")?peachQuote():fixture.raw;
    if(body.method==="eth_simulateV1") return simulated(body,{receipt:fixture.receipt});
    if(body.method==="eth_call"&&body.params[0].to===router) return reply(body,ethers.AbiCoder.defaultAbiCoder().encode(["address"],[fixture.wallet.address]));
    return preflight(body);
  },async url=>{
    const r=await query(profile(url),base,url);
    assert.equal(r.ok,true);assert.equal(r.amountOut,"1100");assert.equal(r.builtAmountOut,"1000");
    assert.equal(r.simulation.status,"SUCCESS",r.simulation.error);assert.equal(r.simulation.amountOut,"1005");
    assert.equal((r.simulation.evidence as any).receipt.userAmountOut,"1005");
  });
});
test("mismatched route boundary/input cannot enter quote ranking",async()=>{
  await server(()=>{const q=peachQuote();q.data.paths[0].amount_in="1";return q;},async url=>{
    const r=await fetchQuote(profile(url),base);assert.equal(r.ok,false);assert.match(r.error!,/boundary amounts/);
  });
});
test("quote-only does not call transaction construction",async()=>{
  await server(req=>{assert.match(req.url!,/^\/router\/find_routes/);return peachQuote();},async url=>{
    const r=await query(profile(url),{...base,doSim:false},url);assert.equal(r.ok,true);assert.equal(r.tx,undefined);
  });
});
test("build failure preserves valid original quote",async()=>{
  await server(req=>req.url!.startsWith("/router/find_routes")?peachQuote():{code:400,msg:"build disabled"},async url=>{
    const r=await query(profile(url),base,url);assert.equal(r.ok,true);assert.equal(r.amountOut,"1100");assert.equal(r.buildError,"build disabled");assert.equal(r.simulation.stage,"build");
  });
});
test("unsupported RPC is unavailable, approval and swap failures distinct",async()=>{
  for(const failure of [null,0,5]) await server((_req,body)=>body.method!=="eth_simulateV1"?preflight(body):failure===null?{jsonrpc:"2.0",id:1,error:{message:"method not found"}}:simulated(body,{fail:failure}),async url=>{
    const r=await simulate(base,{to:router,data:"0x12345678",value:"0"},router,url);
    assert.equal(r.status,failure===null?"UNAVAILABLE":"FAILED");assert.equal(r.stage,failure===null?"rpc":failure===0?"approval":"swap");
  });
});
test("insufficient real balance prevents simulation and cannot be fabricated",async()=>{
  let attempted=false;
  await server((_req,body)=>{if(body.method==="eth_simulateV1")attempted=true;return preflight(body,{balance:1n});},async url=>{
    const r=await simulate(base,{to:router,data:"0x12345678",value:"0"},router,url);assert.equal(r.status,"FAILED");assert.match(r.error!,/actual input/);assert.equal(attempted,false);
  });
});
test("allowance is measured after approval, not assumed from status",async()=>{
  await server((_req,body)=>body.method==="eth_simulateV1"?simulated(body,{allowance:0n}):preflight(body),async url=>{
    const r=await simulate(base,{to:router,data:"0x12345678",value:"0"},router,url);assert.equal(r.status,"FAILED");assert.equal(r.stage,"approval");
  });
});
test("synthetic block timestamp must match requested parent+1",async()=>{
  await server((_req,body)=>body.method==="eth_simulateV1"?simulated(body,{timeOffset:1}):preflight(body),async url=>{
    const r=await simulate(base,{to:router,data:"0x12345678",value:"0"},router,url);assert.equal(r.status,"UNAVAILABLE");assert.match(r.error!,/mismatched/);
  });
});
test("receipt and measured output must agree",()=>{
  const f=signedBuild();const r:Result={name:"peach",ok:true,latencyMs:1,minimumOut:"995",simulation:{status:"SKIPPED"}};
  assert.throws(()=>verifyPeachReceipt(base,r,f.digest,f.receipt,999n),/differs/);
});
test("Arc USDC input plus gas share one native balance",()=>{
  const c={...base,chainId:5042,from:chainToken(5042,"USDC"),amountIn:"1000000"};
  assert.equal(requiredNative(c,100n),10n**18n+100n);assert.equal(requiredNative(base,100n),100n);
});
test("RPC wrapper rejects write methods",async()=>{
  await assert.rejects(rpc("http://unused","eth_sendRawTransaction",[]),/not read-only/);
});
test("Kyber current quote/build uses route identity and excludes RFQ when building",async()=>{
  const q={code:0,data:{routerAddress:router,routeSummary:{tokenIn:base.from,tokenOut:base.target,amountIn:base.amountIn,amountOut:"1000",route:[]}}};
  let refreshed=false;
  await server((req,body)=>{
    if(req.method==="POST"){assert.equal(refreshed,true);assert.equal(body.sender,sender);return{code:0,data:{amountIn:base.amountIn,amountOut:"999",routerAddress:router,data:"0x12345678",transactionValue:"0"}};}
    if(req.url!.includes("excludeRFQSources=true"))refreshed=true;
    return q;
  },async url=>{const r=await fetchQuote(profile(url,"kyber"),base);await build(profile(url,"kyber"),base,r);assert.equal(r.amountOut,"1000");assert.equal(r.builtAmountOut,"999");});
});
test("Fly quote requires matching sender, recipient, chain and deadline",async()=>{
  const body={id:"fly",amountOut:"1000",typedData:{domain:{chainId:5042},message:{fromAsset:base.from,toAsset:base.target,sender,recipient:token,deadline:String(Math.floor(Date.now()/1000)+300)}}};
  await server(()=>body,async url=>{const r=await fetchQuote(profile(url,"fly"),{...base,chainId:5042});assert.equal(r.ok,false);assert.match(r.error!,/recipient/);});
});
test("OKX selected chain and unsupported response preserved, project ID optional",async()=>{
  const keys=["OKX_API_KEY","OKX_SECRET_KEY","OKX_PASSPHRASE","OKX_PROJECT_ID"],previous=keys.map(k=>process.env[k]);
  keys.slice(0,3).forEach(k=>process.env[k]="test-only");delete process.env.OKX_PROJECT_ID;
  try{await server(req=>{const url=new URL(req.url!,"http://fixture");assert.equal(url.searchParams.get("chainIndex"),"5042");assert.ok(req.headers["ok-access-sign"]);return{code:"51000",msg:"unsupported chain"};},async url=>{
    const r=await fetchQuote(profile(url,"okx"),{...base,chainId:5042});assert.equal(r.error,"unsupported chain");assert.equal(r.ok,false);
  });}finally{keys.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];});}
});
test("saved evidence removes known API credentials",()=>{
  const prior=process.env.KYBER_API_KEY;process.env.KYBER_API_KEY="test-secret-do-not-log";
  try{assert.deepEqual(cleanEvidence({apiKey:"test-secret-do-not-log",message:"echo test-secret-do-not-log"}),{apiKey:"[REDACTED]",message:"echo [REDACTED]"});}
  finally{if(prior===undefined)delete process.env.KYBER_API_KEY;else process.env.KYBER_API_KEY=prior;}
});
test("route differences are hypotheses; no fabricated liquidity diagnosis",()=>{
  const rows:Result[]=[{name:"Peach",kind:"peach",ok:true,latencyMs:1,amountOut:"1000",routes:[],simulation:{status:"SKIPPED"}},
    {name:"other",ok:true,latencyMs:1,amountOut:"1100",routes:[{dex:"V3",pool:router,tokenIn:base.from,tokenOut:token,amountIn:null,amountOut:null}],simulation:{status:"SKIPPED"}}];
  const f=analyze(rows).comparisons[1].findings.find(f=>f.category==="route-selection-or-coverage");assert.equal(f?.confidence,"hypothesis");
});
test("CLI saves report and re-analyzes offline; decimals read from selected chain",async()=>{
  const {execFile}=await import("node:child_process"),{promisify}=await import("node:util"),fs=await import("node:fs/promises"),os=await import("node:os"),path=await import("node:path");
  const execute=promisify(execFile),out=await fs.mkdtemp(path.join(os.tmpdir(),"peach-benchmark-test-"));
  try{await server((req,body)=>{
    if(req.method==="GET")return peachQuote({...base,from:chainToken(5042,"USDC"),amountIn:"1000000"},"980000");
    if(body.method==="eth_chainId")return reply(body,"0x13b2");
    if(body.method==="eth_getBlockByNumber")return reply(body,{number:"0x10",hash,timestamp:"0x6553f100"});
    return reply(body,word(6n));
  },async url=>{
    const {stdout}=await execute(process.execPath,["--import","tsx","src/cli.ts","benchmark","USDC",token,"1","--chain","arc","--rpc",url,"--api",url,"--no-sim","--out",out]);
    const response=JSON.parse(stdout),report=JSON.parse(await fs.readFile(response.report,"utf8"));
    assert.equal(report.case.amountIn,"1000000");assert.equal(report.case.chainId,5042);assert.equal(report.results[0].amountOut,"980000");
    const offline=await execute(process.execPath,["--import","tsx","src/cli.ts","benchmark","--report",response.report]);assert.equal(JSON.parse(offline.stdout).bestQuote,"peach-prod");
  });}finally{await fs.rm(out,{recursive:true,force:true});}
});
test("automatic sender discovery verifies EOA, actual balances and block hash",async()=>{
  await server((_req,body)=>{
    if(body.method==="eth_chainId")return reply(body,"0x38");
    if(body.method==="eth_getBlockByNumber")return reply(body,{number:"0x10",hash,timestamp:"0x6553f100"});
    return preflight(body);
  },async url=>{const block=await snapshot(url,56),found=await discoverSender(url,56,base.from,BigInt(base.amountIn),block);assert.equal(found.selected.code,"0x");assert.ok(BigInt(found.selected.balance)>=BigInt(base.amountIn));});
});

test("case-mapped DEX names do not invent a coverage difference",()=>{
  const a={dex:"PANCAKE_INFINITY_CL",pool:router,tokenIn:base.from,tokenOut:token,amountIn:null,amountOut:null};
  const rows:Result[]=[{name:"Peach",kind:"peach",ok:true,latencyMs:1,amountOut:"1000",routes:[a],simulation:{status:"SKIPPED"}},
    {name:"Kyber",kind:"kyber",ok:true,latencyMs:1,amountOut:"1100",routes:[{...a,dex:"pancake-infinity-cl"}],simulation:{status:"SKIPPED"}}];
  const report=analyze(rows);assert.deepEqual(report.comparisons[1].routeDifferenceFromBaseline?.uniqueDexes,[]);
  assert.equal(report.comparisons[1].findings[0].category,"pool-state-split-or-fees");
});
test("multi-round wins exclude incomplete rounds and track ties separately",async()=>{
  const {summarize}=await import("../src/lib/benchmark.ts");
  const q=(name:string,amount:string,ok=true):Result=>({name,ok,amountOut:ok?amount:undefined,latencyMs:10,simulation:{status:"SKIPPED"}});
  const summary=summarize([[q("p","100"),q("k","110")],[q("p","100"),q("k","100")],[q("p","100"),q("k","0",false)]]);
  assert.equal(summary.completeQuoteRounds,2);assert.equal(summary.sources[0].wins,0);assert.equal(summary.sources[0].ties,1);
  assert.equal(summary.sources[1].wins,1);assert.equal(summary.sources[1].quoteSuccess,2);
});
test("synthetic/mock quotes are excluded rather than presented as real prices",async()=>{
  await server(()=>({...peachQuote(),simulation:true}),async url=>{
    const r=await fetchQuote(profile(url),base);assert.equal(r.ok,false);assert.match(r.error!,/mock/);
  });
});
test("Peach plan must be signed by the current chain signer",async()=>{
  const f=signedBuild();
  await server((req,body)=>{
    if(req.method==="GET")return req.url!.startsWith("/router/find_routes")?peachQuote():f.raw;
    if(body.method==="eth_call"&&body.params[0].to===router)return reply(body,ethers.AbiCoder.defaultAbiCoder().encode(["address"],[token]));
    assert.notEqual(body.method,"eth_simulateV1");return preflight(body);
  },async url=>{const r=await query(profile(url),base,url);assert.equal(r.simulation.status,"FAILED");assert.equal(r.simulation.stage,"plan");assert.match(r.simulation.error!,/signer/);});
});
test("RPC failure while checking signer is not a transaction failure",async()=>{
  const f=signedBuild();
  await server((req,body)=>{
    if(req.method==="GET")return req.url!.startsWith("/router/find_routes")?peachQuote():f.raw;
    if(body.method==="eth_call"&&body.params[0].to===router)return{jsonrpc:"2.0",id:1,error:{message:"backend unavailable"}};
    return preflight(body);
  },async url=>{const r=await query(profile(url),base,url);assert.equal(r.simulation.status,"UNAVAILABLE");assert.equal(r.simulation.stage,"rpc");});
});
test("zero token output cannot become a successful simulation",async()=>{
  await server((_req,body)=>body.method==="eth_simulateV1"?simulated(body,{output:0n}):preflight(body),async url=>{
    const r=await simulate(base,{to:router,data:"0x12345678",value:"0"},router,url);assert.equal(r.status,"FAILED");assert.equal(r.stage,"balance");
  });
});

test("ARC USDC output measurement isolates gas but checks a real gas budget",async()=>{
  const c={...base,chainId:5042,from:token,target:chainToken(5042,"USDC")};
  await server((_req,body)=>{
    if(body.method!=="eth_simulateV1")return preflight(body);
    assert.equal(body.params[0].blockStateCalls[0].blockOverrides.baseFeePerGas,"0x0");
    const calls=body.params[0].blockStateCalls[0].calls;
    assert.ok(calls.every((c:any)=>c.gasPrice==="0x0"));assert.equal(calls[4].to,c.target);
    return simulated(body);
  },async url=>{const r=await simulate(c,{to:router,data:"0x12345678",value:"0"},router,url);assert.equal(r.status,"SUCCESS");assert.equal(r.amountOut,"1005");assert.ok(BigInt(r.gasBudget!)>0n);});
});
test("ARC input cannot spend the same native USDC twice on input and gas",async()=>{
  const c={...base,chainId:5042,from:chainToken(5042,"USDC")};
  const native=BigInt(c.amountIn)*10n**12n+1n;
  await server((_req,body)=>body.method==="eth_simulateV1"?simulated(body):preflight(body,{native}),async url=>{
    const r=await simulate(c,{to:router,data:"0x12345678",value:"0"},router,url);assert.equal(r.status,"FAILED");assert.equal(r.stage,"gas");assert.match(r.error!,/input plus/);
  });
});
test("simulation must use the verified parent hash",async()=>{
  await server((_req,body)=>{
    if(body.method!=="eth_simulateV1")return preflight(body);
    const r=simulated(body);r.result[0].parentHash=ethers.ZeroHash;return r;
  },async url=>{const r=await simulate(base,{to:router,data:"0x12345678",value:"0"},router,url);assert.equal(r.status,"UNAVAILABLE");assert.match(r.error!,/mismatched/);});
});
