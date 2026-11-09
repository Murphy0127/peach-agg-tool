# ARC/BSC benchmark 验证记录

日期：2026-11-09（北京时间）。工作分支 `codex/arc-bsc-benchmark`。
实现参考 PeachManager `cb8c9d8` 的 `shared/compare-upstream.ts`、
`shared/third-party-build.ts`、`src/lib/compare-rpc.ts`、`src/lib/compare-simulation.ts`。
PeachManager 仅作只读参考，未修改或部署。

## 设计与边界

- 单一 Case：链、From/Target、amount_in、来源、路由参数和 Sender/Recipient 冻结并保存。
- 初始 quote → 刷新 build → 固定父区块的只读 simulation，各阶段金额独立保存。
- 默认环境、第三方端点和 API 参数与 Manager 一致；显式支持自定义 profiles。
- 实际代币/Gas 余额为执行前提；临时授权不改变链上状态。不读取私钥，不签名或广播。
- Peach 使用 SDK 0.3.0 校验公开签名计划、链上执行 signer 和回执；到账以接收方余额差核对。
- ARC USDC ERC-20 的 6 位和 native 的 18 位属于同一余额，输入与 Gas 预算合并校验。
- 分析输出观察证据与根因假设。不同路由不直接等同于流动性缺失；缓存/税费根因需要进一步
  逐池和逐跳数据，不使用旧 BSC 存储槽猜测方法充当 ARC 诊断。

## 实际主网验证

运行：

```bash
node dist/cli.mjs benchmark USDT WBNB 100 --chain bsc --agg all
node dist/cli.mjs benchmark USDC 0x171a4217b86a807a64eb94757db6849fb4bdbaa0 1 --chain arc --agg all
```

两个 Case 及反向 ARC Case 均自动发现实际持币 EOA，完成全部来源的 quote/build/simulation 和父区块哈希复核。
使用已有本地 OKX 配置；Kyber/Fly 使用公开接口。未显示或写入 API 凭据。
下面全部输出为接收方代币的最小单位，不扣网络 Gas；仅证明该时点和该 Case。

| 链/Case | 来源 | 初始报价 | 构建预期 | 实际模拟到账 | 结果 |
| --- | --- | --- | --- | --- | --- |
| BSC 100 USDT→WBNB | peach-prod | 145037939475233456 | 145035155414471956 | 145037021071935829 | SUCCESS |
|  | peach-pre | 145024852556788932 | 145024852556788932 | 145026248104160529 | SUCCESS |
|  | kyber | 145032291904367537 | 145032291904367536 | 145032291904367540 | SUCCESS |
|  | okx | 145030832114806794 | 145030798798719490 | 145029389530429840 | SUCCESS |
| ARC 1 USDC→cirBTC | peach-prod | 1336 | 1336 | 1336 | SUCCESS |
|  | peach-pre | 1336 | 1336 | 1336 | SUCCESS |
|  | kyber | 1336 | 1335 | 1336 | SUCCESS |
|  | okx | 1333 | 1333 | 1333 | SUCCESS |
|  | fly | 1334 | 1334 | 1334 | SUCCESS |
| ARC 0.00001 cirBTC→USDC | peach-prod | 749315 | 749090 | 749090 | SUCCESS |
|  | peach-pre | 749315 | 749090 | 749090 | SUCCESS |
|  | kyber | 749100 | 749100 | 749090 | SUCCESS |
|  | okx | 749014 | 749014 | 749014 | SUCCESS |
|  | fly | 749090 | 749090 | 749090 | SUCCESS |

BSC 100 USDT→WBNB 父区块 `0x7e61446`，哈希 `0x589be0a13e1f61c995c032d0c45f42b6141644a3b3a69696375d7aa5fff93f5c`。

ARC 1 USDC→cirBTC 父区块 `0x1ce321b`，哈希 `0xc6b9f5ba6061aa5231a9f9c842f44c1c698ecac0e6277931a78b8b3f0c53c4b5`。

ARC 0.00001 cirBTC→USDC 父区块 `0x1ce321a`，哈希 `0x7b861b813e4db2ff677b0bafe3bd439b78b206fbdf6cbcb4b2c18b5c6b3eaa10`。

原始报告（本机临时目录，不纳入 Git）：

- `/tmp/peach-agg-tool-validation/benchmark-56-1794197786597-1.json`
- `/tmp/peach-agg-tool-validation/benchmark-5042-1794197786891-1.json`
- `/tmp/peach-agg-tool-validation/benchmark-5042-1794197786554-1.json`

最终重复运行中，BSC Peach prod 是初始报价及模拟到账最优；此前一次 BSC 运行则分别为 Peach pre 和 Kyber，
说明需要保存各阶段和每轮快照，不能把不同时点或不同阶段合并排名。ARC 三个来源 Peach prod/pre 与 Kyber
在买入 Case 的实际到账相同；卖出到 USDC 的反向 Case 也通过了余额差与 Peach 执行回执的交叉核对。
不据此推断差额一定来自手续费或某个池子故障。

所有来源的余额差模拟均显式使用 gasPrice=0、baseFeePerGas=0，避免 ARC USDC 的 Gas 扣费混入
输入/输出代币余额。另以本轮实测 gasPrice 核验真实 Gas 预算，并合并 ARC USDC 输入资金需求。
GASPRICE/BASEFEE 敏感合约仅在该合成条件下得到验证。Gas 统计包括归零、授权与 swap，不含诊断读取。

额外发现：Manager 中 WUSDC 主网地址 `0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f`
在本次 RPC 现场读取 `decimals()` 回滚。工具拒绝猜测其精度，ARC 冒烟测试改用 Manager
已有 cirBTC Case。该现象未在 Manager 中修复，也不能推广为全部 ARC 代币不可用。

## 自动化与交付检查

29 项本地 HTTP/RPC fixture 测试覆盖：精确整数与金额边界、环境隔离、quote/build 分离、签名及回执、
接收方余额差、授权核验、真实余额不足、RPC 不支持、合成区块时间、ARC 输入/Gas 共用余额、
第三方身份和构建参数、凭证脱敏、发送地址发现、统计口径与离线报告。Mock 验证不代替上述主网记录。

执行 `npm run test:benchmark`、`npm run typecheck`、`npm run build`、`git diff --check`。
本记录覆盖实现阶段的本地与只读主网验证，不代表部署业务服务或关闭 GitLab 任务。
CLI 与 Codex Skill 的分发流程另见 [releasing.md](releasing.md)，发布状态以对应 GitHub Release/npm 版本为准。

另完成 BSC Peach/Kyber 两轮 quote-only 实测，汇总记录位于
`/tmp/peach-agg-tool-validation/benchmark-session-56-1794197845052.json`，两轮全部来源成功，未构建交易或模拟。
