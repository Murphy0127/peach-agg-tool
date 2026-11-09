# peach-agg-tool

Peach Aggregator ARC/BSC 报价对比、交易模拟与劣势分析工具，同时也是 Claude Code 的 **peach** skill plugin。

当前 API 使用 `benchmark` 入口，支持 Peach prod/pre、Kyber、OKX，ARC 还支持 Fly。接口与模拟流程参考 PeachManager Quote/Compare。

```bash
npm run build
# BSC：100 USDT → WBNB，自动发现并核验持币 Sender
node dist/cli.mjs benchmark USDT WBNB 100 --chain bsc --agg all
# ARC 主网：1 USDC → cirBTC
node dist/cli.mjs benchmark USDC 0x171a4217b86a807a64eb94757db6849fb4bdbaa0 1 --chain arc --agg all
```

`all` 中 OKX 需要配置凭证；公开 Peach/Kyber/Fly 接口无需 Key 即可测试。每个来源独立保存失败证据。
详细参数见下方“ARC / BSC 当前 API 对比入口”，实测记录见 [docs/benchmark-validation.md](docs/benchmark-validation.md)。

## 安装

需要 Node.js >=20.18.1。Codex 用户使用 **CLI + Skill**：从 GitHub Release 安装 CLI，
再让 `$skill-installer` 安装
`https://github.com/Murphy0127/peach-agg-tool/tree/v0.6.1/skills/peach`。
之后可直接说“用 $peach 对比 ARC/BSC 上指定币对和金额”。Skill 启动器固定 CLI 版本，
支持 PATH 和 `~/.local/bin`，从其他项目目录也可运行。
完整安装命令、GitHub 发布包安装方式及发布流程见 [docs/releasing.md](docs/releasing.md)。

### 1. 作为 Claude Code Plugin 安装（推荐）

```bash
# 添加 marketplace
claude plugin marketplace add Murphy0127/peach-agg-tool

# 安装 plugin
claude plugin install peach@peach-agg-tool
```

重启 Claude Code 或在会话中执行 `/reload-plugins` 即可使用。

### 2. 仅作为 CLI 工具安装

```bash
npm install --global --prefix "$HOME/.local" https://github.com/Murphy0127/peach-agg-tool/releases/download/v0.6.1/peach-agg-tool-0.6.1.tgz
export PATH="$HOME/.local/bin:$PATH"
```

### 3. 配置凭证（可选）

在 `~/.config/peach-agg-tool/.env` 中配置凭证（插件更新不会丢失）：

```bash
mkdir -p ~/.config/peach-agg-tool
cp skills/peach/.env.example ~/.config/peach-agg-tool/.env
vim ~/.config/peach-agg-tool/.env
```

`.env` 支持的变量：

| 变量 | 用途 | 必须？ |
|------|------|--------|
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` / `OKX_PROJECT_ID` | OKX 聚合器对比 | `--agg all` 时需要 |
| `PEACH_DEBUG_TOKEN` | Peach debug API 认证 | `debug` 命令的池子检查需要 |

不配置 OKX 凭证也可以使用 Peach-only 功能（`--agg peach`、`debug`、`analyze`）。
不配置 `PEACH_DEBUG_TOKEN` 也能跑 debug，但无法查看聚合器内存/Redis 池子数据。

## 更新

Plugin 通过 GitHub 安装后：
```bash
claude plugin update peach@peach-agg-tool
```
或在会话中执行 `/reload-plugins` 自动拉取最新版本。

CLI 使用 GitHub Release 安装包更新，不依赖 npm registry 发布：
```bash
npm install --global --prefix "$HOME/.local" https://github.com/Murphy0127/peach-agg-tool/releases/download/v0.6.1/peach-agg-tool-0.6.1.tgz
```

## 使用

### CLI 直接使用

```bash
# 查看帮助
npx peach-agg-tool -h

# 单次 Peach 报价
npx peach-agg-tool quote BNB USDT 1.0

# Peach vs OKX 对比
npx peach-agg-tool quote BNB USDT 1.0 --agg all

# 持续对比跑 30 分钟
npx peach-agg-tool compare --duration 30 --min-usd 1000

# 使用固定 Case 可复现地对比 agg-test 与 OKX
npx peach-agg-tool compare \
  --env test \
  --cases /path/to/cases.json \
  --rounds 320 \
  --seed 42 \
  --slippage 50

# 诊断模拟失败（含链上数据比对）
npx peach-agg-tool debug BNB USDT 1.0
npx peach-agg-tool debug USDT BNB 100 --check-redis --force

# 分析日志
npx peach-agg-tool analyze /tmp/aggregator/compare-xxx.jsonl

# OKX DEX 分布统计
npx peach-agg-tool dex-stats --duration 10

# 逐跳模拟分析（定位报价偏差）
npx peach-agg-tool hop-sim BNB USDT 1.0 --full-sim

# 检测 token 转账税
npx peach-agg-tool tax-check VIN LTC CAKE

# 刷新 token 数据
npx peach-agg-tool fetch-tokens
```

### 作为 Claude Code Skill 使用

安装 plugin 后，Claude 会自动识别聚合器相关的请求。你可以直接用自然语言：

- "帮我比较一下 BNB 换 USDT 1 个的报价"
- "跑一个 10 分钟的 benchmark"
- "BNB 换 USDT 模拟失败了，帮我分析原因"
- "查看最新的 compare 日志分析结果"

或直接调用 `/peach` slash command。

## 命令参考

| 命令 | 用途 |
|------|------|
| `quote <from> <to> <amount>` | 单次报价 + 模拟（`--agg all` 对比） |
| `compare` | 持续多轮随机对比 |
| `debug <from> <to> <amount>` | 诊断模拟失败（Peach 内存 + 链上比对） |
| `hop-sim <from> <to> <amount>` | 逐跳链上模拟对比，定位报价偏差 |
| `tax-check <token> [token2 ...]` | 纯链上检测 token 转账税（不依赖 Peach） |
| `dex-stats` | OKX DEX 使用分布统计 |
| `analyze <log.jsonl>` | 分析 compare 日志 |
| `fetch-tokens` | 刷新 BSC token 数据 |

`compare --cases` 支持 Aggregator `test/v8/cases.json` 格式。对比日志保留有符号的
quote-to-simulation 滑点，并同时统计 Peach/OKX 正滑点比例以及“Peach 吃掉全部
正滑点”的假设结果。OKX 模拟使用 `eth_simulateV1` 的 Transfer logs 提取实际到账量；
RPC 不支持时会标记模拟不可用，不会用 ABI 返回值猜测。

### debug 命令详细

`debug` 命令通过 Peach debug API（`/agg/debug/pool`、`/agg/debug/pool/redis`）检查池子状态，需要 `PEACH_DEBUG_TOKEN`。

执行 4 步诊断：

1. 执行 Peach quote + simulation
2. 拉取聚合器内存中的 pool 数据（`/agg/debug/pool`）
3. 通过 RPC 读取链上真实状态，逐字段比对：
   - **V3 pools**: sqrtPriceX96, tick, liquidity
   - **V2 pools**: reserve0, reserve1
   - **DODO pools**: baseReserve, quoteReserve, baseTarget, quoteTarget
4. 汇总诊断结果

数据偏差超过阈值会标记为 `⚠ STALE`，表示聚合器缓存过期。

```bash
# 基本用法（模拟失败时自动诊断）
npx peach-agg-tool debug BNB USDT 1.0

# 同时检查 Redis 数据同步
npx peach-agg-tool debug BNB USDT 1.0 --check-redis

# 即使模拟成功也检查 pool 状态
npx peach-agg-tool debug BNB USDT 1.0 --force

# 跳过链上比对（更快）
npx peach-agg-tool debug BNB USDT 1.0 --no-onchain
```

### hop-sim 命令详细

`hop-sim` 逐跳模拟 Peach 的报价路由，将每一跳的 Peach 预测输出与链上实际计算结果对比：

- **V2 pools**: 读取 `getReserves()` + 恒等积公式计算
- **V3 pools**: 调用 QuoterV2 的 `quoteExactInputSingle()` 做真实 tick 遍历
- **DODO pools**: 调用 `querySellBase()`/`querySellQuote()`

```bash
# 基本用法
npx peach-agg-tool hop-sim BNB USDT 1.0

# 同时跑完整路由模拟，自动判断是 stale data 还是 transfer tax
npx peach-agg-tool hop-sim BNB USDT 1.0 --full-sim

# 自定义偏差阈值（10 bps = 0.1%）
npx peach-agg-tool hop-sim BNB USDT 1.0 --threshold 10
```

**系统化排查流程（4 步）：**

```
1. hop-sim           →  逐跳链上模拟，定位哪个 hop 有偏差
2. debug --check-redis --force  →  比对内存/Redis/链上三层数据
3. /agg/debug/pool/swap API  →  用聚合器自身逻辑复现单跳计算
4. tax-check <中间代币>  →  确认 transfer tax 或聚合器 bug
```

### tax-check 命令详细

`tax-check` 通过纯链上模拟检测 token 的隐藏转账税，完全不依赖 Peach：

1. 通过 PancakeV2 Router 的 `swapExactETHForTokensSupportingFeeOnTransferTokens` 买入 token
2. 对比 `getAmountsOut`（无税预期）vs `balanceOf`（实际到手）→ **Buy tax**
3. 将一半 token 转给 `address(0xdead)`，对比发送量 vs 接收量 → **Transfer tax**

整个过程在单次 `eth_call` 中通过部署临时合约完成，无需消耗 gas。

```bash
# 检测单个 token
npx peach-agg-tool tax-check 0x85E43bF8faAF04ceDdcD03d6C07438b72606a988

# 批量检测
npx peach-agg-tool tax-check VIN LTC CAKE

# 用更大金额测试（防止小额豁免）
npx peach-agg-tool tax-check VIN --amount 0.1
```

**典型排查流程：**

```
quote (模拟失败) → hop-sim (定位偏差跳) → debug --check-redis (比对数据) → tax-check (排查 token 税)
```

## 卸载

```bash
# Plugin 方式安装的
claude plugin uninstall peach@peach-agg-tool
claude plugin marketplace remove peach-agg-tool

# npm 方式安装的
npm uninstall --global --prefix "$HOME/.local" peach-agg-tool
```

## ARC / BSC 当前 API 对比入口（benchmark）

`benchmark` 直接获取路由与服务端构建的交易，使用 `@masterpeach/aggregator-sdk` 校验
公开执行计划和回执。原有 `quote` / `compare` / `debug` / `hop-sim` 是历史 BSC 实现；
它们仍依赖旧 SDK，不保证兼容当前接口。新测试使用 `benchmark`。

```bash
# 指定聚合器，prod/pre 环境和 RPC 默认与 PeachManager 一致
node dist/cli.mjs benchmark USDT WBNB 100 --chain bsc --agg peach-prod,peach-pre,kyber,okx

# ARC 主网：USDC 的 ERC-20 精度为 6，cirBTC 精度现场从 RPC 读取
node dist/cli.mjs benchmark USDC 0x171a4217b86a807a64eb94757db6849fb4bdbaa0 1 --chain arc --agg all

# 重复同一个 Case，逐轮保存报告；完整来源轮次才计入报价胜场
node dist/cli.mjs benchmark USDT WBNB 100 --chain bsc --agg all --rounds 10 --interval 2

# 精确指定 amount_in 最小单位；不根据字符串长度猜测金额单位
node dist/cli.mjs benchmark USDT WBNB 100000000000000000000 --raw --chain bsc --no-sim

# 手动发送地址/接收地址，覆盖自动发现；仅用于只读模拟，无需私钥
node dist/cli.mjs benchmark USDT WBNB 100 --chain bsc --sender 0xFUNDED_SENDER --recipient 0xRECIPIENT

# 指定测试网或自定义部署；地址必须来自该链
node dist/cli.mjs benchmark USDC 0xTARGET_TOKEN 1 --chain arc-testnet --api https://YOUR-TESTNET-API --rpc https://YOUR-TESTNET-RPC

# 离线重新分析保存的快照，切换 Peach 基准
node dist/cli.mjs benchmark --report /tmp/aggregator/benchmark-56-TIMESTAMP-1.json --baseline peach-pre
```

输入默认是人类可读单位；`--raw` 表示最小单位。工具从选定链读取 decimals，拒绝 RPC
链 ID 不匹配。支持 `--slippage`（bps，默认 50）、`--depth`（默认 3）、`--split`（默认 5）、
`--providers`（逗号分隔，仅作用于 Peach）、`--baseline` 和 `--out`。
原生 BNB 不在当前 benchmark 范围；使用 WBNB。ARC 主网为 5042，测试网为 5042002。
两条 ARC 网络均可用 canonical USDC ERC-20 别名，其他代币地址/部署不能跨网络套用。
WUSDC 别名来自 Manager，但 2026-11-09 主网该地址读取 decimals 回滚；不要把它作为
当前可用币对，工具会保留明确错误，不用猜测精度代替链上读取。

| 网络 | prod | pre | 默认 RPC |
| --- | --- | --- | --- |
| BSC | `https://api.peach.ag` | `https://api.cipheron.org` | `https://bsc-rpc.publicnode.com` |
| ARC mainnet | `https://api.peach.ag/arc` | `https://api-arc.cipheron.org/arc-mainnet` | `https://arc-rpc.publicnode.com` |
| ARC testnet | 显式指定 | 显式指定 | 显式指定 |

`--agg` 支持 `peach`（prod 别名）、`peach-prod`、`peach-pre`、`kyber`、`okx`、`fly`（ARC 主网），
以及逗号分隔组合或 `all`。默认 `peach-prod`；`all` 包含所选主网的全部来源。
可使用 `--profiles profiles.json` 对比自定义部署：

```json
[
  { "name": "baseline", "kind": "peach", "api": "https://BASELINE" },
  { "name": "candidate", "kind": "peach", "api": "https://CANDIDATE" }
]
```

同一轮所有 profile 必须属于同一条链。Peach 使用与 Manager 一致的 `/router/swap`
和 v1 ExecutionPlan 格式，不混用新的 allowance/Permit2 v2 交易格式。`--api` 覆盖所选 Peach 来源的 API；对比两个不同部署时优先用 profiles。
配置 URL 不接受嵌入用户名、密码或 query 凭据。

凭证沿用 `--env-file` / `~/.config/peach-agg-tool/.env`。OKX 使用 `OKX_API_KEY`、
`OKX_SECRET_KEY`、`OKX_PASSPHRASE`；`OKX_PROJECT_ID` 可选，`OKX_REGION=global|eea|us`。
Kyber 可配置 `KYBER_API_KEY` / `KYBER_CLIENT_ID`，Fly 可配置 `FLY_API_KEY` / `FLY_NETWORK`。
未配置 Key 时 Kyber/Fly 使用公开接口，不自动读取 PeachManager 浏览器中的个人 Key。
日志脱敏已知环境凭据，文件权限为 0600；不要在终端或报告中手工填写密钥。

### 报价、构建与模拟的证据边界

1. 并发获取初始报价。Peach `/router/find_routes` 保留池子、DEX、逐段金额和费率；
   验证响应链、输入币对和精确金额。`--no-sim` 不构建任何交易。
2. 模拟前重新构建交易。Peach `/router/swap` 返回签名执行计划；Kyber build 明确排除 RFQ；
   OKX/Fly 使用各自交易端点。记录新构建的净预期输出和最低接收量，独立于初始报价。
3. 构建完成后冻结共同的区块号、哈希、时间和 gasPrice，复核链上精度。未指定 Sender 时，
   先尝试 BSC 固定候选，再检查最近 128 块 Transfer 的最多 24 个候选，逐一核验 EOA、真实
   代币余额和原生 Gas 余额；未找到时明确失败，可手动指定 `--sender`。
4. RPC `eth_simulateV1` 中连续执行：授权归零、授权本次金额、核验 allowance、读取发送方输入
   和接收方输出余额、swap、再次读取余额，核验实际输入扣减和接收方到账。
   要求真实持币，不覆盖余额、代码或存储，不签名、不广播。
   合成区块为记录父区块后的一块，时间 +1 秒，严格核验返回的区块与时间。
5. Peach 校验计划链/角色/币对/金额、路由哈希、链上 signerVersion 和执行回执，回执的用户
   净到账必须等于接收方余额差且不低于签名最低到账。余额差模拟使用 `gasPrice=0`、`baseFee=0`，
   避免 ARC 原生 USDC Gas 扣费混入代币余额；对 GASPRICE/BASEFEE 敏感的合约只验证了该合成条件。
   另以现场观察的实际 gasPrice 计算预算。Gas 包含归零、授权和 swap，不含诊断读取，
   原生余额须覆盖 Gas；ARC canonical USDC 额外合并预留 6→18 位换算后的输入余额。
6. 所有模拟结束后重新验证父区块哈希。RPC 不支持/网络故障/区块变化为 `UNAVAILABLE`；
   构建、余额、授权、swap、回执等失败单独标记阶段，不混入成功模拟排名。

报告默认存于 `/tmp/aggregator`，包含参数、来源、初始路由和原始响应、构建交易、模拟区块、
预条件和完整模拟证据。多轮额外保存 session 汇总，报价胜场只计全部所选来源成功的轮次。
输出 bps 带符号、精确至小数点后 4 位；排名不扣网络 Gas。

分析区分初始报价差距、quote→build 漂移、build→simulation 执行偏差、DEX/池子差异和失败阶段。
不同服务商的 DEX 名称先统一大小写和分隔符；RFQ 初始报价与排除 RFQ 的构建差异另行标记。
新增池子/DEX 是“不同路由选择”的证据，不能直接证明 Peach 未收录或缓存过期；这些原因
标记为待核验假设，保留逐池/逐跳排查所需原始信息。原始金额不使用浮点运算。
上游报价/构建不能固定区块，旧签名可能过期，模拟也不保证未来真实交易成功。

验证：`npm run test:benchmark`、`npm run typecheck`、`npm run build`。
完整主网实测见 [docs/benchmark-validation.md](docs/benchmark-validation.md)。
