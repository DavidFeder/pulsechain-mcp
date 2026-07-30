import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  CORE_TOKENS,
  POPULAR_CONTRACTS_BY_ADDRESS,
} from "../../constants.js";
import {
  getAccountInternalTxs,
  getAccountTokenList,
  getAccountTokenTransfers,
  getAccountTxList,
  getContractCreation,
  getContractSourceCode,
  getTokenHolders,
  getTokenHoldersModule,
  getTokenInfo,
  getTokenInfoV2,
  getTokenSupply,
  type TokenHolderItem,
} from "../../data/explorer.js";
import {
  batchErc20Balances,
  batchNativeBalances,
  countNonZeroSuccessfulBalances,
} from "../../data/multicall.js";
import {
  fetchLargeSwaps,
  fetchRecentBurns,
  fetchRecentPairs,
  fetchSwapsAdvanced,
  fetchWalletSwaps,
} from "../../data/subgraph.js";
import type { AppConfig } from "../../types.js";
import { ok } from "../../utils/result.js";
import { assertAddress } from "../../utils/safety.js";
import { registerTool } from "../define.js";
import { labelSubgraphSwapRow } from "./helpers.js";
import {
  buildFundingNodes,
  computeAddressAge,
  computeHolderRank,
  detectScamAlerts,
  inferFirstFunder,
  isKnownSafeAddress,
  scoreAddressRisk,
  txTimestamp,
  weiToPls,
  type ExplorerTxLike,
  type HolderLike,
  type ScamBurnLike,
  type ScamPairLike,
} from "./advanced-helpers.js";

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("0x-prefixed PulseChain address");

const versionSchema = z
  .enum(["v1", "v2"])
  .default("v2")
  .describe("PulseX subgraph version");

function asTxArray(raw: unknown): ExplorerTxLike[] {
  return Array.isArray(raw) ? (raw as ExplorerTxLike[]) : [];
}

function asHolderArray(raw: unknown): HolderLike[] {
  if (!Array.isArray(raw)) return [];
  return raw as HolderLike[];
}

function defaultPortfolioTokens(): string[] {
  return Object.values(CORE_TOKENS).map((t) => t.address);
}

/**
 * Advanced / pro-tier analytics tools using only public PulseX subgraphs,
 * BlockScout api.scan.pulsechain.com, and viem RPC/multicall.
 */
export function registerAdvancedAnalyticsTools(
  server: McpServer,
  config: AppConfig,
): void {
  // -------------------------------------------------------------------------
  // check_address_risk
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "check_address_risk",
    description:
      "Heuristic risk signals for a PulseChain address from public data only. " +
      "Methodology: explorer txlist (age, fail rate, funders, contract creates) + " +
      "known CORE_TOKENS/POPULAR_CONTRACTS allowlist. No private openpulsechain backend. " +
      "Returns riskScore 0–100, signals[], confidence, and method. Approximate — not a blacklist.",
    category: "analytics",
    inputSchema: {
      address: addressSchema,
      sampleSize: z
        .number()
        .int()
        .min(5)
        .max(100)
        .default(40)
        .describe("How many recent txs to sample for heuristics"),
    },
    handler: async (args, cfg) => {
      const address = assertAddress(args.address as string);
      const sampleSize = (args.sampleSize as number) ?? 40;

      const [recentDesc, earliestAsc, creation] = await Promise.all([
        getAccountTxList(cfg, address, 1, sampleSize, "desc"),
        getAccountTxList(cfg, address, 1, Math.min(sampleSize, 20), "asc"),
        getContractCreation(cfg, address).catch(() => null),
      ]);

      const recent = asTxArray(recentDesc);
      const earliest = asTxArray(earliestAsc);
      const earliestTs =
        earliest.length > 0
          ? txTimestamp(earliest[0]!)
          : recent.length > 0
            ? Math.min(
                ...recent
                  .map((t) => txTimestamp(t))
                  .filter((t): t is number => t !== undefined),
              )
            : undefined;

      const failedTxCount = recent.filter((t) => t.isError === "1").length;
      const contractCreations = recent.filter(
        (t) =>
          (!t.to || t.to === "") &&
          t.contractAddress &&
          t.contractAddress !== "",
      ).length;

      const uniqueFunders = new Set<string>();
      const addrLower = address.toLowerCase();
      for (const tx of [...earliest, ...recent]) {
        const to = (tx.to ?? "").toLowerCase();
        const from = (tx.from ?? "").toLowerCase();
        if (to === addrLower && from && from !== addrLower) {
          uniqueFunders.add(from);
        }
      }

      const first = inferFirstFunder(address, earliest);
      const isContract =
        (Array.isArray(creation) && creation.length > 0) ||
        (creation !== null &&
          typeof creation === "object" &&
          !Array.isArray(creation));

      const scored = scoreAddressRisk({
        address,
        isContract: Boolean(isContract),
        earliestTxTs: earliestTs,
        txCountSample: recent.length,
        failedTxCount,
        uniqueFunders: [...uniqueFunders],
        firstFunder: first.funder,
        contractCreations,
      });

      const age = computeAddressAge(earliestTs);
      const popular = POPULAR_CONTRACTS_BY_ADDRESS[addrLower];

      return ok({
        address,
        ...scored,
        age,
        firstFunder: first,
        sample: {
          recentTxCount: recent.length,
          failedTxCount,
          contractCreations,
          uniqueFunderCount: uniqueFunders.size,
        },
        knownLabel: popular
          ? { name: popular.name, category: popular.category }
          : isKnownSafeAddress(address)
            ? { name: "core_token", category: "token" }
            : null,
        contractCreation: creation,
      });
    },
  });

  // -------------------------------------------------------------------------
  // get_deployer_reputation
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "get_deployer_reputation",
    description:
      "Best-effort contract creator reputation from public BlockScout data. " +
      "Methodology: getcontractcreation for the contract → creator address history " +
      "(txlist contract creates, age, fail rate). Outcomes are approximate (no private " +
      "scam DB). confidence/method included.",
    category: "analytics",
    inputSchema: {
      contractAddress: addressSchema.describe("Deployed contract to inspect"),
      sampleSize: z.number().int().min(5).max(100).default(50),
    },
    handler: async (args, cfg) => {
      const contractAddress = assertAddress(args.contractAddress as string);
      const sampleSize = (args.sampleSize as number) ?? 50;

      // Soft-fail explorer getcontractcreation (HTTP 400/500 common on BlockScout)
      let creationRaw: unknown = null;
      let creationError: string | null = null;
      try {
        creationRaw = await getContractCreation(cfg, contractAddress);
      } catch (err) {
        creationError =
          err instanceof Error ? err.message : "getcontractcreation failed";
        creationRaw = null;
      }
      // Normalize array/object
      const creationList = Array.isArray(creationRaw)
        ? creationRaw
        : creationRaw
          ? [creationRaw]
          : [];
      const creation = creationList[0] as
        | {
            contractAddress?: string;
            contractCreator?: string;
            creatorAddress?: string;
            txHash?: string;
          }
        | undefined;

      const creator =
        creation?.contractCreator ??
        creation?.creatorAddress ??
        null;

      if (!creator) {
        // Fallback: earliest tx with contractAddress match
        let txs: ReturnType<typeof asTxArray> = [];
        let txlistError: string | null = null;
        try {
          txs = asTxArray(
            await getAccountTxList(cfg, contractAddress, 1, 5, "asc"),
          );
        } catch (err) {
          txlistError =
            err instanceof Error ? err.message : "txlist fallback failed";
        }
        const fromTx = txs.find(
          (t) =>
            (t.contractAddress ?? "").toLowerCase() ===
            contractAddress.toLowerCase(),
        );
        const fallbackCreator = fromTx?.from ?? null;
        if (!fallbackCreator) {
          return ok({
            contractAddress,
            creator: null,
            reputation: null,
            confidence: "low",
            method:
              "getcontractcreation + txlist fallback; creator not found on public explorer",
            note: "Contract may predate index, be a create2 clone, or explorer may lack creation index.",
            explorer_errors: [creationError, txlistError].filter(Boolean),
            partial: true,
          });
        }

        return ok(
          await buildDeployerReport(cfg, contractAddress, fallbackCreator, {
            txHash: fromTx?.hash,
            sampleSize,
            method: creationError
              ? `txlist fallback (getcontractcreation: ${creationError})`
              : "txlist contractAddress match fallback",
          }),
        );
      }

      let source: unknown = null;
      try {
        source = await getContractSourceCode(cfg, contractAddress);
      } catch {
        source = null;
      }

      const report = await buildDeployerReport(cfg, contractAddress, creator, {
        txHash: creation?.txHash,
        sampleSize,
        method: "BlockScout getcontractcreation + creator txlist heuristics",
      });

      return ok({
        ...report,
        verifiedSourceHint: summarizeSource(source),
      });
    },
  });

  // -------------------------------------------------------------------------
  // get_scam_alerts
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "get_scam_alerts",
    description:
      "Recent suspicious PulseX tokens/pairs from public subgraph heuristics only. " +
      "Signals: (1) young pairs with volume>>liquidity, (2) thin-reserve high-tx pairs, " +
      "(3) large LP burns vs remaining reserves (liquidity-pull). " +
      "Each alert includes confidence + method. Not a definitive scam oracle.",
    category: "analytics",
    inputSchema: {
      first: z.number().int().min(5).max(50).default(25),
      maxAgeDays: z.number().min(1).max(90).default(14),
      minBurnUsd: z.number().min(0).default(500),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const first = (args.first as number) ?? 25;
      const version = (args.version as "v1" | "v2") ?? "v2";
      const maxAgeDays = (args.maxAgeDays as number) ?? 14;
      const minBurnUsd = (args.minBurnUsd as number) ?? 500;

      const [pairsRes, burnsRes] = await Promise.all([
        fetchRecentPairs(cfg, {
          first,
          minReserveUsd: 0,
          version,
        }),
        fetchRecentBurns(cfg, {
          first,
          minLiquidityUsd: minBurnUsd,
          version,
        }),
      ]);

      const detected = detectScamAlerts({
        pairs: (pairsRes.pairs ?? []) as ScamPairLike[],
        burns: (burnsRes.burns ?? []) as ScamBurnLike[],
        maxAgeDays,
      });

      return ok({
        ...detected,
        sample: {
          pairsScanned: pairsRes.pairs?.length ?? 0,
          burnsScanned: burnsRes.burns?.length ?? 0,
          version,
        },
        generatedAt: new Date().toISOString(),
      });
    },
  });

  // -------------------------------------------------------------------------
  // get_smart_money_feed
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "get_smart_money_feed",
    description:
      "High-signal PulseX swaps from the public subgraph. " +
      "Default threshold: amountUSD > minUsd (default 10000). " +
      "Methodology: GraphQL swaps where amountUSD_gt = threshold, newest first. " +
      "'Smart money' here means large USD-notional flow only — not labeled whale DB.",
    category: "analytics",
    inputSchema: {
      minUsd: z
        .number()
        .min(100)
        .default(10_000)
        .describe("Minimum swap amountUSD threshold"),
      first: z.number().int().min(1).max(100).default(25),
      skip: z.number().int().min(0).default(0),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const minUsd = (args.minUsd as number) ?? 10_000;
      const first = (args.first as number) ?? 25;
      const skip = (args.skip as number) ?? 0;
      const version = (args.version as "v1" | "v2") ?? "v2";

      const data = await fetchLargeSwaps(cfg, { minUsd, first, skip, version });
      const swaps = (data.swaps ?? []).map((s) => ({
        ...s,
        signal: {
          kind: "large_swap",
          amountUSD: Number(s.amountUSD ?? 0),
          aboveThreshold: Number(s.amountUSD ?? 0) >= minUsd,
        },
      }));

      return ok({
        minUsd,
        count: swaps.length,
        swaps,
        thresholds: {
          defaultMinUsd: 10_000,
          appliedMinUsd: minUsd,
          definition:
            "High-signal = subgraph amountUSD strictly greater than minUsd",
        },
        method: "PulseX subgraph swaps(where: { amountUSD_gt })",
        confidence: "high" as const,
        version,
      });
    },
  });

  // -------------------------------------------------------------------------
  // get_recent_swaps
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "get_recent_swaps",
    description:
      "Recent PulseX swaps with optional pair, token, or minUsd filters. " +
      "Uses public graph.pulsechain.com PulseX subgraph. Token filter resolves " +
      "top pairs (capped) then strict-filters swaps; partial results if some pair queries fail. " +
      "Catalogued pair sides get display_symbol / token_origin (never invented for unknowns). " +
      "Filter by token **address** for identity-sensitive work.",
    category: "analytics",
    inputSchema: {
      pair: addressSchema.optional().describe("Pair/pool address filter"),
      token: addressSchema.optional().describe("Token address filter"),
      minUsd: z.number().min(0).optional(),
      first: z.number().int().min(1).max(100).default(20),
      skip: z.number().int().min(0).default(0),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const result = await fetchSwapsAdvanced(cfg, {
        pair: args.pair as string | undefined,
        token: args.token as string | undefined,
        minUsd: args.minUsd as number | undefined,
        first: (args.first as number) ?? 20,
        skip: (args.skip as number) ?? 0,
        version: (args.version as "v1" | "v2") ?? "v2",
      });
      if (result.filterError) {
        return ok({
          count: 0,
          swaps: [],
          filter: result.filter,
          filter_error: result.filterError,
          method:
            "PulseX subgraph swaps; token filter is strict (pair must include token)",
          note: result.filterError,
        });
      }
      const swaps = result.swaps.map((s) => labelSubgraphSwapRow(s));
      return ok({
        count: swaps.length,
        swaps,
        filter: result.filter,
        method:
          "PulseX subgraph swaps with optional pair/token/minUsd; token filter post-validated",
        label_note:
          "display_symbol/token_origin on pair sides only for catalogued addresses",
      });
    },
  });

  // -------------------------------------------------------------------------
  // get_wallet_balances
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "get_wallet_balances",
    description:
      "Native PLS + ERC-20 portfolio for a wallet. " +
      "Methodology: (1) explorer account/tokenlist (or tokentx sample) to discover tokens, " +
      "(2) merge with CORE_TOKENS, (3) live balances via RPC multicall balanceOf + native getBalance. " +
      "Explorer list may be incomplete for never-indexed tokens.",
    category: "analytics",
    inputSchema: {
      address: addressSchema,
      extraTokens: z
        .array(addressSchema)
        .max(30)
        .optional()
        .describe("Additional token addresses to include"),
      includeCoreTokens: z
        .boolean()
        .default(true)
        .describe("Always include WPLS/HEX/PLSX/INC/stables"),
      maxTokens: z.number().int().min(1).max(80).default(40),
    },
    handler: async (args, cfg) => {
      const address = assertAddress(args.address as string);
      const includeCore = (args.includeCoreTokens as boolean) ?? true;
      const maxTokens = (args.maxTokens as number) ?? 40;
      const extra = (args.extraTokens as string[] | undefined) ?? [];

      const tokenSet = new Map<string, { address: string; symbol?: string }>();

      if (includeCore) {
        for (const t of defaultPortfolioTokens()) {
          tokenSet.set(t.toLowerCase(), { address: t });
        }
      }
      for (const t of extra) {
        const a = assertAddress(t);
        tokenSet.set(a.toLowerCase(), { address: a });
      }

      let discoveryMethod = "core_tokens";
      try {
        const list = await getAccountTokenList(cfg, address);
        if (Array.isArray(list) && list.length > 0) {
          discoveryMethod = "explorer_tokenlist+core";
          for (const item of list) {
            const row = item as {
              contractAddress?: string;
              tokenAddress?: string;
              address?: string;
              symbol?: string;
            };
            const ca =
              row.contractAddress ?? row.tokenAddress ?? row.address;
            if (ca && /^0x[a-fA-F0-9]{40}$/.test(ca)) {
              tokenSet.set(ca.toLowerCase(), {
                address: ca,
                symbol: row.symbol,
              });
            }
          }
        } else {
          // Fallback: sample tokentx for unique contracts
          const transfers = await getAccountTokenTransfers(cfg, address, {
            page: 1,
            offset: 50,
          });
          if (Array.isArray(transfers)) {
            discoveryMethod = "explorer_tokentx+core";
            for (const tr of transfers) {
              const ca = (tr as { contractAddress?: string }).contractAddress;
              if (ca && /^0x[a-fA-F0-9]{40}$/.test(ca)) {
                tokenSet.set(ca.toLowerCase(), { address: ca });
              }
            }
          }
        }
      } catch {
        discoveryMethod = "core_tokens_only_explorer_failed";
      }

      const tokens = [...tokenSet.values()]
        .map((t) => t.address)
        .slice(0, maxTokens);

      const [native, erc20] = await Promise.all([
        batchNativeBalances(cfg, [address]),
        tokens.length > 0
          ? batchErc20Balances(cfg, address, tokens, true)
          : Promise.resolve([]),
      ]);

      return ok({
        address,
        native: native[0] ?? null,
        tokens: erc20,
        nonZeroCount: countNonZeroSuccessfulBalances(erc20),
        tokenCount: erc20.length,
        discovery: {
          method: discoveryMethod,
          maxTokens,
          includeCoreTokens: includeCore,
        },
      });
    },
  });

  // -------------------------------------------------------------------------
  // get_wallet_swaps
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "get_wallet_swaps",
    description:
      "PulseX swap history for a wallet from the public subgraph. " +
      "Methodology: swaps where sender == wallet OR to == wallet, merged & sorted by timestamp desc. " +
      "Router-mediated swaps may attribute sender as the router — coverage is best-effort.",
    category: "analytics",
    inputSchema: {
      address: addressSchema,
      first: z.number().int().min(1).max(100).default(25),
      skip: z.number().int().min(0).default(0),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const address = assertAddress(args.address as string);
      const data = await fetchWalletSwaps(cfg, address, {
        first: (args.first as number) ?? 25,
        skip: (args.skip as number) ?? 0,
        version: (args.version as "v1" | "v2") ?? "v2",
      });
      return ok({
        address,
        count: data.swaps.length,
        swaps: data.swaps,
        method: data.method,
        confidence: "medium",
        caveat:
          "UniswapV2-style subgraph indexes sender/to; many UI swaps set sender to router.",
      });
    },
  });

  // -------------------------------------------------------------------------
  // get_funding_tree
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "get_funding_tree",
    description:
      "Depth-limited first-funder hop tree via public explorer native transfers. " +
      "Methodology: for each node, take earliest inbound native tx (txlist sort=asc) as parent edge; " +
      "BFS up to maxDepth (default 2) and maxNodes. Approximate; CEX/deposit roots common.",
    category: "analytics",
    inputSchema: {
      address: addressSchema,
      maxDepth: z.number().int().min(1).max(4).default(2),
      maxNodes: z.number().int().min(1).max(30).default(12),
    },
    handler: async (args, cfg) => {
      const root = assertAddress(args.address as string);
      const maxDepth = (args.maxDepth as number) ?? 2;
      const maxNodes = (args.maxNodes as number) ?? 12;

      const hops: Array<{
        address: string;
        fundedBy: string | null;
        valueWei: string | null;
        valuePls: string | null;
        txHash: string | null;
        timestamp: number | null;
        depth: number;
      }> = [];

      const visited = new Set<string>();
      const queue: Array<{ address: string; depth: number }> = [
        { address: root, depth: 0 },
      ];

      while (queue.length > 0 && hops.length < maxNodes) {
        const current = queue.shift()!;
        const key = current.address.toLowerCase();
        if (visited.has(key)) continue;
        visited.add(key);

        let first = {
          funder: null as string | null,
          valueWei: null as string | null,
          txHash: null as string | null,
          timestamp: null as number | null,
        };

        try {
          const txs = asTxArray(
            await getAccountTxList(cfg, current.address, 1, 15, "asc"),
          );
          const inferred = inferFirstFunder(current.address, txs);
          first = {
            funder: inferred.funder,
            valueWei: inferred.valueWei,
            txHash: inferred.txHash,
            timestamp: inferred.timestamp,
          };

          // Optional: peek internal if no native funder
          if (!first.funder) {
            const internal = asTxArray(
              await getAccountInternalTxs(cfg, current.address, 1, 10, "asc"),
            );
            const inferredInt = inferFirstFunder(current.address, internal);
            if (inferredInt.funder) {
              first = {
                funder: inferredInt.funder,
                valueWei: inferredInt.valueWei,
                txHash: inferredInt.txHash,
                timestamp: inferredInt.timestamp,
              };
            }
          }
        } catch {
          // keep null funder
        }

        hops.push({
          address: current.address,
          fundedBy: first.funder,
          valueWei: first.valueWei,
          valuePls: weiToPls(first.valueWei),
          txHash: first.txHash,
          timestamp: first.timestamp,
          depth: current.depth,
        });

        if (
          first.funder &&
          current.depth < maxDepth &&
          hops.length + queue.length < maxNodes
        ) {
          const parent = first.funder.toLowerCase();
          if (!visited.has(parent) && !isKnownSafeAddress(parent)) {
            queue.push({ address: first.funder, depth: current.depth + 1 });
          }
        }
      }

      const tree = buildFundingNodes(root, hops);
      return ok({
        ...tree,
        maxDepth,
        maxNodes,
        nodeCount: hops.length,
      });
    },
  });

  // -------------------------------------------------------------------------
  // get_holder_rank
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "get_holder_rank",
    description:
      "Rank of an address among ERC-20 holders via public BlockScout. " +
      "Primary: API v2 /tokens/{addr}/holders (top holders). Fallback: module=token&action=getTokenHolders. " +
      "If found on the returned page, rank = index + 1 (v2 top list) or (page-1)*offset + index + 1. " +
      "Otherwise not-found with percentileEstimate caveat. No private APIs.",
    category: "analytics",
    inputSchema: {
      token: addressSchema.describe("ERC-20 token contract"),
      address: addressSchema.describe("Holder address to rank"),
      page: z.number().int().min(1).default(1),
      offset: z.number().int().min(1).max(100).default(50),
    },
    handler: async (args, cfg) => {
      const token = assertAddress(args.token as string);
      const address = assertAddress(args.address as string);
      const page = (args.page as number) ?? 1;
      const offset = (args.offset as number) ?? 50;

      let holders: HolderLike[] = [];
      let source: "v2" | "module" = "v2";
      let totalSupply: string | null = null;
      let tokenInfo: unknown = null;

      try {
        const v2 = await getTokenHolders(cfg, token, { limit: offset });
        holders = (v2.items ?? []).map((item: TokenHolderItem) => ({
          address: item.address?.hash,
          value: item.value,
        }));
        const tip = v2.items?.[0]?.token;
        if (tip?.total_supply) totalSupply = tip.total_supply;
        source = "v2";
      } catch {
        source = "module";
        const [holdersRaw, supplyRaw, info] = await Promise.all([
          getTokenHoldersModule(cfg, token, page, offset),
          getTokenSupply(cfg, token).catch(() => null),
          getTokenInfo(cfg, token).catch(() => null),
        ]);
        holders = asHolderArray(holdersRaw);
        if (typeof supplyRaw === "string" || typeof supplyRaw === "number") {
          totalSupply = String(supplyRaw);
        }
        tokenInfo = info;
      }

      if (!totalSupply) {
        try {
          const v2info = await getTokenInfoV2(cfg, token);
          totalSupply = v2info.total_supply ?? null;
          tokenInfo = v2info;
        } catch {
          /* optional */
        }
      }

      const rank = computeHolderRank(holders, address, {
        page: source === "v2" ? 1 : page,
        offset,
        totalSupply,
      });

      return ok({
        token,
        address,
        page,
        offset,
        holdersOnPage: holders.length,
        totalSupply,
        tokenInfo,
        source,
        ...rank,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Internal helpers (async composition)
// ---------------------------------------------------------------------------

async function buildDeployerReport(
  cfg: AppConfig,
  contractAddress: string,
  creator: string,
  meta: { txHash?: string; sampleSize: number; method: string },
): Promise<Record<string, unknown>> {
  const creatorAddr = assertAddress(creator);
  const [recent, earliest] = await Promise.all([
    getAccountTxList(cfg, creatorAddr, 1, meta.sampleSize, "desc"),
    getAccountTxList(cfg, creatorAddr, 1, 20, "asc"),
  ]);
  const recentTxs = asTxArray(recent);
  const earliestTxs = asTxArray(earliest);
  const earliestTs =
    earliestTxs.length > 0 ? txTimestamp(earliestTxs[0]!) : undefined;
  const age = computeAddressAge(earliestTs);

  const deployments = recentTxs.filter(
    (t) =>
      (!t.to || t.to === "") &&
      t.contractAddress &&
      String(t.contractAddress).length >= 42,
  );
  const failed = recentTxs.filter((t) => t.isError === "1").length;

  const otherContracts = deployments
    .map((t) => ({
      contractAddress: t.contractAddress,
      txHash: t.hash,
      timestamp: txTimestamp(t) ?? null,
    }))
    .filter(
      (d) =>
        (d.contractAddress ?? "").toLowerCase() !==
        contractAddress.toLowerCase(),
    );

  const risk = scoreAddressRisk({
    address: creatorAddr,
    isContract: false,
    earliestTxTs: earliestTs,
    txCountSample: recentTxs.length,
    failedTxCount: failed,
    uniqueFunders: [],
    firstFunder: inferFirstFunder(creatorAddr, earliestTxs).funder,
    contractCreations: deployments.length,
  });

  return {
    contractAddress,
    creator: creatorAddr,
    creationTxHash: meta.txHash ?? null,
    age,
    sample: {
      txCount: recentTxs.length,
      failedTxCount: failed,
      deploymentsInSample: deployments.length,
    },
    otherDeployments: otherContracts.slice(0, 20),
    reputation: {
      riskScore: risk.riskScore,
      riskLevel: risk.riskLevel,
      signals: risk.signals,
      summary:
        deployments.length >= 5 && age.young
          ? "Elevated: young multi-deployer pattern in sample"
          : deployments.length >= 1
            ? "Deployer has contract creation activity in sample"
            : "Limited creation activity in recent sample",
    },
    confidence: risk.confidence,
    method: meta.method,
    caveats: [
      "Outcomes (rug vs legit) are not labeled without an external curated list.",
      "Sample is recent-page limited; historical deploy count may be higher.",
    ],
  };
}

function summarizeSource(source: unknown): Record<string, unknown> | null {
  if (!source) return null;
  const row = Array.isArray(source) ? source[0] : source;
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  return {
    contractName: r.ContractName ?? r.contractName ?? null,
    compilerVersion: r.CompilerVersion ?? null,
    optimizationUsed: r.OptimizationUsed ?? null,
    proxy: r.Proxy ?? null,
    isVerified: Boolean(
      r.SourceCode && String(r.SourceCode).length > 2,
    ),
  };
}
