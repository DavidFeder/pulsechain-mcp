/**
 * Free-tier analytics tools — public data only.
 *
 * Sources: PulseX subgraphs, BlockScout (api.scan.pulsechain.com), viem RPC/multicall.
 * Does NOT call openpulsechain.com or any private backends.
 *
 * Tool names match openpulsechain free-tier parity (underscore form):
 * get_token_price, get_token_info, get_token_history, get_top_tokens,
 * get_top_pairs, get_market_overview, get_token_safety, get_token_liquidity,
 * get_honeypots, get_bridge_stats, get_holder_leagues.
 */

import { z } from "zod";
import { decodeAbiParameters, type Address, type Hex } from "viem";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  CORE_TOKENS,
  DEFAULT_EXPLORER_UI,
  WPLS_ADDRESS,
  DAI_ADDRESS,
  FORK_DAI_ADDRESS,
  USDC_FROM_ETH_ADDRESS,
  USDT_FROM_ETH_ADDRESS,
  resolveCoreToken,
  tokenLabelFields,
} from "../../constants.js";
import {
  fetchBundle,
  fetchFactories,
  fetchPairsForToken,
  fetchPulsexDayData,
  fetchToken,
  fetchTokenDayData,
  fetchTopPairs,
  fetchTopTokens,
  getContractAbi,
  getContractSourceCode,
  getPublicClient,
  getTokenHolders,
  getTokenInfo,
  getTokenInfoV2,
  multicallRead,
} from "../../data/index.js";
import type { AppConfig, SubgraphVersion } from "../../types.js";
import { AppError } from "../../utils/errors.js";
import { ok } from "../../utils/result.js";
import { assertAddress } from "../../utils/safety.js";
import { registerTool } from "../define.js";
import {
  GET_OWNER_ABI,
  OWNER_ABI,
  ZERO_ADDRESS,
  bucketHoldersByLeague,
  buildTokenInfoPayload,
  computeSafetyScore,
  isoDateFromUnix,
  mapPairsWithSaneLiquidity,
  num,
  PAIR_PRICE_FIELDS_NOTE,
  pctChange,
  rankPairsBySaneLiquidity,
  resolveTokenLiquidityUsdEstimate,
  scanSuspiciousPatterns,
  selectTopPairsByLiquidity,
  sumSanePairLiquidity,
  uniquePairsById,
  tierForUsd,
} from "./helpers.js";

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("Token or contract address (0x…)");

const versionSchema = z
  .enum(["v1", "v2"])
  .default("v2")
  .describe("PulseX subgraph version (default v2)");

function asVersion(v: unknown): SubgraphVersion {
  return v === "v1" ? "v1" : "v2";
}

async function resolveOwner(
  config: AppConfig,
  token: Address,
): Promise<{ owner: string | null; renounced: boolean | null }> {
  try {
    const results = await multicallRead(config, [
      {
        address: token,
        abi: OWNER_ABI,
        functionName: "owner",
      },
      {
        address: token,
        abi: GET_OWNER_ABI,
        functionName: "getOwner",
      },
    ]);

    for (const r of results) {
      if (r.status === "success" && r.result) {
        const owner = String(r.result).toLowerCase();
        return {
          owner,
          renounced: owner === ZERO_ADDRESS,
        };
      }
    }
    return { owner: null, renounced: null };
  } catch {
    return { owner: null, renounced: null };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFreeTierAnalyticsTools(
  server: McpServer,
  config: AppConfig,
): void {
  // ── get_token_price ────────────────────────────────────────────────────
  registerTool(server, config, {
    name: "get_token_price",
    description:
      "USD and PLS **price by token address** from PulseX subgraph " +
      "(derivedUSD / derivedPLS). Prefer this over DexScreener search for size/price. " +
      "Includes UTC calendar-day change from tokenDayData when available " +
      "(not a rolling 24h window — see volume_window). Catalog origin labels " +
      "attach for known addresses. Public data only.",
    category: "analytics",
    inputSchema: {
      address: addressSchema,
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const address = assertAddress(args.address as string);
      const version = asVersion(args.version);
      const [tokenRes, dayRes, bundleRes] = await Promise.all([
        fetchToken(cfg, address, version),
        fetchTokenDayData(cfg, address, 3, version).catch(() => ({
          tokenDayDatas: [],
        })),
        fetchBundle(cfg, version).catch(() => ({ bundle: null })),
      ]);

      const token = tokenRes.token;
      if (!token) {
        throw new AppError(
          `Token not found on PulseX ${version} subgraph: ${address}`,
          "NOT_FOUND",
        );
      }

      const priceUsd = num(token.derivedUSD);
      const pricePls = num(token.derivedPLS);
      const days = dayRes.tokenDayDatas ?? [];
      const today = days[0];
      const yesterday = days[1];
      const priceChange24h =
        today && yesterday
          ? pctChange(num(today.priceUSD), num(yesterday.priceUSD))
          : null;
      const volume24h = today ? num(today.dailyVolumeUSD) : null;
      const liquidityUsd = today
        ? num(today.totalLiquidityUSD)
        : num(token.totalLiquidity) * priceUsd;

      const supplyRaw = num(token.totalSupply);
      const decimals = num(token.decimals, 18);
      const supply =
        decimals >= 0 && decimals < 36
          ? supplyRaw / 10 ** decimals
          : supplyRaw;
      const marketCap =
        supply > 0 && priceUsd > 0 ? supply * priceUsd : null;

      const identity = tokenLabelFields(address) ?? {};
      // Forked pDAI can show a non-zero derivedUSD on subgraph — never present as $1 stable
      const priceConfidence =
        identity.do_not_treat_as_usd_stable === true
          ? "low"
          : priceUsd > 0
            ? "high"
            : "low";
      return ok({
        address: token.id,
        symbol: token.symbol,
        name: token.name,
        price_usd: priceUsd,
        price_pls: pricePls,
        pls_usd: num(bundleRes.bundle?.plsPrice),
        price_change_24h: priceChange24h,
        volume_24h: volume24h,
        volume_window: "utc_calendar_day",
        price_change_window: "utc_calendar_day",
        window_note:
          "volume_24h and price_change_24h use PulseX tokenDayData UTC calendar days; the latest row is often a partial day, not a trailing 24 hours.",
        liquidity_usd: liquidityUsd,
        market_cap: marketCap,
        method: "PulseX subgraph derivedUSD/derivedPLS + tokenDayData",
        confidence: priceConfidence,
        subgraph: version,
        source: "graph.pulsechain.com (public)",
        ...identity,
        price_note:
          identity.do_not_treat_as_usd_stable === true
            ? "Subgraph derivedUSD for forked pDAI is NOT a claim of dollar stability — use bridged DAI (0xefD7…) for real stables"
            : undefined,
      });
    },
  });

  // ── get_token_info ─────────────────────────────────────────────────────
  registerTool(server, config, {
    name: "get_token_info",
    description:
      "Token metadata by **address** (identity-sensitive). Combines PulseX subgraph + BlockScout. " +
      "Catalogued assets get display_symbol / token_origin (e.g. eUSDC, pHEX); never invented for unknowns. " +
      "Pairs are quality-ranked (catalog rails preferred; ghost/polluted reserves demoted; " +
      "junk rails excluded from total_liquidity_usd — not an oracle). " +
      "Soft-fails when PulseX token entity blips if catalog or explorer can still identify the address " +
      "(partial=true, source_notes). Prefer this or dexscreener_token_pairs over symbol search. " +
      "For USD price prefer get_token_price; for quotes use pulsex_quote (router) or pulseswap_quote (multi-DEX).",
    category: "analytics",
    inputSchema: {
      address: addressSchema,
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const address = assertAddress(args.address as string);
      const version = asVersion(args.version);

      const tokenSettled = await Promise.allSettled([
        fetchToken(cfg, address, version),
        fetchPairsForToken(cfg, address, 10, version),
        getTokenInfo(cfg, address),
        getTokenInfoV2(cfg, address),
      ]);

      const tokenResult = tokenSettled[0];
      const pairsResult = tokenSettled[1];
      const explorerResult = tokenSettled[2];
      const v2Result = tokenSettled[3];

      let token: {
        id?: string;
        symbol?: string;
        name?: string;
        decimals?: string | number;
        totalSupply?: string;
        tradeVolumeUSD?: string | number;
        totalTransactions?: string | number;
        totalLiquidity?: string | number;
        derivedPLS?: string | number;
        derivedUSD?: string | number;
      } | null = null;
      let subgraphTokenFailed = false;
      let subgraphTokenError: string | undefined;
      if (tokenResult.status === "fulfilled") {
        token = tokenResult.value?.token ?? null;
      } else {
        subgraphTokenFailed = true;
        subgraphTokenError =
          tokenResult.reason instanceof Error
            ? tokenResult.reason.message
            : String(tokenResult.reason);
      }

      let pairs: Parameters<typeof buildTokenInfoPayload>[0]["pairs"] = [];
      let pairsFailed = false;
      let pairsError: string | undefined;
      if (pairsResult.status === "fulfilled") {
        pairs = (pairsResult.value as typeof pairs) ?? [];
      } else {
        pairsFailed = true;
        pairsError =
          pairsResult.reason instanceof Error
            ? pairsResult.reason.message
            : String(pairsResult.reason);
      }

      const explorerMeta =
        explorerResult.status === "fulfilled" && explorerResult.value
          ? (explorerResult.value as Record<string, unknown>)
          : null;
      const v2Meta =
        v2Result.status === "fulfilled" && v2Result.value
          ? (v2Result.value as {
              name?: string | null;
              symbol?: string | null;
              decimals?: string | number | null;
              total_supply?: string | null;
              holders?: string | number | null;
            })
          : null;

      const assembled = buildTokenInfoPayload({
        address,
        version,
        token,
        pairs,
        explorerMeta,
        v2Meta,
        subgraphTokenFailed,
        subgraphTokenError,
        pairsFailed,
        pairsError,
        explorerUiBase: DEFAULT_EXPLORER_UI,
      });

      if (!assembled.found) {
        throw new AppError(assembled.reason, "NOT_FOUND");
      }
      return ok(assembled.data);
    },
  });

  // ── get_token_history ──────────────────────────────────────────────────
  registerTool(server, config, {
    name: "get_token_history",
    description:
      "Historical daily price/volume/liquidity from PulseX tokenDayData " +
      "(subgraph). Returns up to 90 days of public day candles.",
    category: "analytics",
    inputSchema: {
      address: addressSchema,
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .default(30)
        .describe("Number of days (max 90)"),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const address = assertAddress(args.address as string);
      const days = Math.min((args.days as number) ?? 30, 90);
      const version = asVersion(args.version);
      const { tokenDayDatas } = await fetchTokenDayData(
        cfg,
        address,
        days,
        version,
      );

      const history = (tokenDayDatas ?? []).map((d) => {
        const close = num(d.priceUSD);
        return {
          date: isoDateFromUnix(d.date),
          timestamp: d.date,
          open: close,
          high: close,
          low: close,
          close,
          volume: num(d.dailyVolumeUSD),
          volume_token: num(d.dailyVolumeToken),
          liquidity_usd: num(d.totalLiquidityUSD),
          txns: num(d.dailyTxns),
        };
      });

      return ok({
        address: address.toLowerCase(),
        days: history.length,
        history,
        note: "OHLC open/high/low equal close — PulseX tokenDayData stores daily close price only",
        method: "PulseX tokenDayDatas",
        confidence: "high",
        subgraph: version,
      });
    },
  });

  // ── get_top_tokens ─────────────────────────────────────────────────────
  registerTool(server, config, {
    name: "get_top_tokens",
    description:
      "Top PulseX tokens by volume, liquidity, or transaction count " +
      "(subgraph orderBy). Public PulseX data. Catalogued addresses include " +
      "display_symbol / token_origin (e.g. pHEX vs eHEX, pDAI vs DAI) — never invented for unknowns. " +
      "liquidity_usd_estimate demotes absurd subgraph derivedUSD products (not invented ranks).",
    category: "analytics",
    inputSchema: {
      sort_by: z
        .enum(["volume", "liquidity", "tx_count"])
        .default("volume")
        .describe("Sort field"),
      limit: z.number().int().min(1).max(100).default(20),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const sortBy = (args.sort_by as string) ?? "volume";
      const limit = (args.limit as number) ?? 20;
      const version = asVersion(args.version);
      // Over-fetch slightly for liquidity so client-side demotion can surface majors
      const fetchFirst =
        sortBy === "liquidity"
          ? Math.min(Math.max(limit * 3, 40), 100)
          : limit;
      const orderBy =
        sortBy === "liquidity"
          ? "totalLiquidity"
          : sortBy === "tx_count"
            ? "totalTransactions"
            : "tradeVolumeUSD";

      const { tokens } = await fetchTopTokens(cfg, {
        first: fetchFirst,
        orderBy,
        version,
      });

      let polluted = 0;
      let mapped = (tokens ?? []).map((t) => {
        const price = num(t.derivedUSD);
        const liqEst = resolveTokenLiquidityUsdEstimate(
          t.totalLiquidity,
          t.derivedUSD,
        );
        if (liqEst.polluted) polluted += 1;
        const identity = tokenLabelFields(t.id) ?? {};
        return {
          address: t.id,
          name: t.name,
          symbol: t.symbol,
          decimals: num(t.decimals, 18),
          price_usd: price,
          volume_usd_cumulative: num(t.tradeVolumeUSD),
          liquidity_token_units: num(t.totalLiquidity),
          // Sanitized: absurd derivedUSD products demoted to 0
          liquidity_usd_estimate: liqEst.liquidityUsd,
          ...(liqEst.polluted
            ? {
                raw_liquidity_usd_estimate: liqEst.rawEstimate,
                liquidity_polluted: true,
              }
            : {}),
          tx_count: num(t.totalTransactions),
          // Catalog only — empty for unknown addresses
          ...identity,
        };
      });

      // Liquidity sort: re-rank by sanitized USD estimate so demoted dust sinks
      if (sortBy === "liquidity") {
        mapped = [...mapped].sort(
          (a, b) => b.liquidity_usd_estimate - a.liquidity_usd_estimate,
        );
      }
      mapped = mapped.slice(0, limit);

      return ok({
        sort_by: sortBy,
        tokens: mapped,
        note:
          "volume_usd_cumulative is all-time trade volume from subgraph. " +
          "display_symbol/token_origin attached only for catalogued addresses " +
          "(reduces HEX/pHEX/eHEX and DAI/pDAI misreads). " +
          "liquidity_usd_estimate demotes absurd totalLiquidity×derivedUSD products.",
        ...(polluted > 0
          ? {
              liquidity_note: `${polluted} token(s) had absurd/suspect liquidity_usd_estimate and were demoted or flagged`,
            }
          : {}),
        source: "PulseX subgraph",
        subgraph: version,
      });
    },
  });

  // ── get_top_pairs ──────────────────────────────────────────────────────
  registerTool(server, config, {
    name: "get_top_pairs",
    description:
      "Top PulseX DEX pairs by volume, liquidity (reserveUSD), or tx count. " +
      "Filters out dust pairs (reserveUSD & volumeUSD > 100). " +
      "Catalogued token sides include token0/1_display_symbol and token0/1_origin " +
      "(e.g. pHEX/eHEX, pDAI/DAI). " +
      "IMPORTANT: token0_price and token1_price are pair-relative (token1 per token0 / inverse), " +
      "NOT USD — prefer reserves, get_token_price, or DexScreener by address for pricing.",
    category: "analytics",
    inputSchema: {
      sort_by: z
        .enum(["volume", "liquidity", "tx_count"])
        .default("volume"),
      limit: z.number().int().min(1).max(100).default(20),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const sortBy = (args.sort_by as string) ?? "volume";
      const limit = (args.limit as number) ?? 20;
      const version = asVersion(args.version);
      const orderBy =
        sortBy === "liquidity"
          ? "reserveUSD"
          : sortBy === "tx_count"
            ? "totalTransactions"
            : "volumeUSD";

      let mapped;
      let noteExtra: string | undefined;

      if (orderBy === "reserveUSD") {
        // Raw reserveUSD order is dominated by polluted dust. Merge a
        // volume-active window (real major pools) with a reserve window, then
        // rank by sanitized liquidity so results stay useful and non-empty.
        const volLimit = Math.min(Math.max(limit * 5, 40), 100);
        const resLimit = Math.min(Math.max(limit * 3, 30), 100);
        const [byVol, byRes] = await Promise.all([
          fetchTopPairs(cfg, {
            first: volLimit,
            orderBy: "volumeUSD",
            version,
          }),
          fetchTopPairs(cfg, {
            first: resLimit,
            orderBy: "reserveUSD",
            version,
          }),
        ]);
        const byId = new Map<string, (typeof byVol.pairs)[number]>();
        for (const p of [...(byVol.pairs ?? []), ...(byRes.pairs ?? [])]) {
          byId.set(p.id, p);
        }
        const selected = selectTopPairsByLiquidity([...byId.values()], limit);
        mapped = selected.pairs;
        if (selected.usedVolumeFallback) {
          noteExtra =
            "All candidates demoted by reserveUSD sanitation; returned volume-ranked fallback so the list is not empty";
        } else if (selected.droppedDemoted > 0) {
          noteExtra = `${selected.droppedDemoted} fully demoted pair(s) dropped from liquidity ranking`;
        }
      } else {
        const { pairs } = await fetchTopPairs(cfg, {
          first: limit,
          orderBy,
          version,
        });
        // Shared mapper: sane liquidity + catalog origin/display labels
        mapped = mapPairsWithSaneLiquidity(pairs ?? []);
      }

      const polluted = mapped.filter((p) => p.liquidity_polluted).length;
      const baseNote =
        polluted > 0
          ? `${polluted} pair(s) had suspect/absurd reserveUSD; liquidity_usd is sanitized`
          : "reserveUSD dust floor applied in subgraph query; absurd values demoted client-side";
      const priceNote = PAIR_PRICE_FIELDS_NOTE;
      const identityNote =
        "token0/1_display_symbol and token0/1_origin attached only for catalogued addresses";

      return ok({
        sort_by: sortBy,
        pairs: mapped,
        note: [baseNote, noteExtra, identityNote, priceNote]
          .filter(Boolean)
          .join(". "),
        price_fields_note: PAIR_PRICE_FIELDS_NOTE,
        source: "PulseX subgraph",
        subgraph: version,
      });
    },
  });

  // ── get_market_overview ────────────────────────────────────────────────
  registerTool(server, config, {
    name: "get_market_overview",
    description:
      "Aggregate PulseX market stats: TVL (totalLiquidityUSD), cumulative " +
      "volume, pair/tx counts, recent daily volumes, PLS price. From public " +
      "PulseX factory + day data.",
    category: "analytics",
    inputSchema: {
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const version = asVersion(args.version);
      const [factories, days, bundle, topTokens] = await Promise.all([
        fetchFactories(cfg, version),
        fetchPulsexDayData(cfg, 8, version),
        fetchBundle(cfg, version),
        fetchTopTokens(cfg, {
          first: 30,
          orderBy: "tradeVolumeUSD",
          version,
        }).catch(() => ({ tokens: [] })),
      ]);

      const factory = factories.pulseXFactories?.[0] ?? null;
      const dayRows = days.pulsexDayDatas ?? [];
      const latest = dayRows[0];
      const prev = dayRows[1];

      // Approximate gainers/losers from token day history of top tokens
      const gainersLosers = await Promise.all(
        (topTokens.tokens ?? []).slice(0, 15).map(async (t) => {
          try {
            const hist = await fetchTokenDayData(cfg, t.id, 2, version);
            const d0 = hist.tokenDayDatas?.[0];
            const d1 = hist.tokenDayDatas?.[1];
            if (!d0 || !d1) return null;
            const change = pctChange(num(d0.priceUSD), num(d1.priceUSD));
            if (change === null) return null;
            return {
              address: t.id,
              symbol: t.symbol,
              price_usd: num(d0.priceUSD),
              price_change_24h: change,
            };
          } catch {
            return null;
          }
        }),
      );

      const ranked = gainersLosers
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => b.price_change_24h - a.price_change_24h);

      return ok({
        tvl_usd: num(factory?.totalLiquidityUSD ?? latest?.totalLiquidityUSD),
        volume_24h: latest ? num(latest.dailyVolumeUSD) : null,
        volume_change_24h:
          latest && prev
            ? pctChange(num(latest.dailyVolumeUSD), num(prev.dailyVolumeUSD))
            : null,
        volume_window: "utc_calendar_day",
        price_change_window: "utc_calendar_day",
        window_note:
          "volume_24h / volume_change_24h / top_gainers price_change_24h use PulseX UTC calendar days (latest row often partial), not a rolling 24-hour window.",
        total_volume_usd_cumulative: num(factory?.totalVolumeUSD),
        pair_count: num(factory?.totalPairs),
        tx_count: num(factory?.totalTransactions),
        pls_price_usd: num(bundle.bundle?.plsPrice),
        active_tokens_sample: (topTokens.tokens ?? []).length,
        top_gainers: ranked.slice(0, 5),
        top_losers: ranked.slice(-5).reverse(),
        daily: dayRows.map((d) => ({
          date: isoDateFromUnix(d.date),
          volume_usd: num(d.dailyVolumeUSD),
          tvl_usd: num(d.totalLiquidityUSD),
          tx_count: num(d.totalTransactions),
        })),
        factory_id: factory?.id ?? null,
        method: "PulseX pulseXFactories + pulsexDayDatas + tokenDayDatas",
        confidence: "high",
        subgraph: version,
        source: "graph.pulsechain.com (public)",
      });
    },
  });

  // ── get_token_safety ───────────────────────────────────────────────────
  registerTool(server, config, {
    name: "get_token_safety",
    description:
      "HEURISTIC token safety score (0–100, grade A–F) from public signals: " +
      "contract verification, ownership renounce (owner()), liquidity, holder " +
      "concentration, age, suspicious ABI patterns. NOT a full audit or " +
      "guaranteed honeypot detector. Limitations clearly labeled in result.",
    category: "analytics",
    inputSchema: {
      address: addressSchema,
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const address = assertAddress(args.address as string);
      const version = asVersion(args.version);

      const [tokenRes, pairs, sourceCode, abiRaw, holdersRes, dayRes, ownerInfo] =
        await Promise.all([
          fetchToken(cfg, address, version).catch(() => ({ token: null })),
          fetchPairsForToken(cfg, address, 15, version).catch(() => []),
          getContractSourceCode(cfg, address).catch(() => []),
          getContractAbi(cfg, address).catch(() => ""),
          getTokenHolders(cfg, address, { limit: 50 }).catch(() => ({
            items: [] as Awaited<ReturnType<typeof getTokenHolders>>["items"],
          })),
          fetchTokenDayData(cfg, address, 90, version).catch(() => ({
            tokenDayDatas: [],
          })),
          resolveOwner(cfg, address),
        ]);

      const sourceEntry = sourceCode[0];
      const sourceText = sourceEntry?.SourceCode ?? "";
      const abiText =
        typeof abiRaw === "string"
          ? abiRaw
          : sourceEntry?.ABI ?? "";
      const verified =
        Boolean(sourceText && sourceText !== "0" && sourceText.length > 2) ||
        (Boolean(abiText) &&
          abiText !== "Contract source code not verified" &&
          !abiText.includes("not verified"));

      const scanText = `${sourceText}\n${abiText}`;
      const suspiciousAbi = scanSuspiciousPatterns(scanText);

      const liqSum = sumSanePairLiquidity(pairs);
      const liquidityUsd = liqSum.totalUsd;

      // Holder concentration
      const supplyStr =
        tokenRes.token?.totalSupply ??
        holdersRes.items[0]?.token?.total_supply ??
        "0";
      const totalSupply = num(supplyStr);
      let topHolderShare: number | null = null;
      let top10Share: number | null = null;
      const items = holdersRes.items ?? [];
      if (totalSupply > 0 && items.length > 0) {
        const balances = items.map((h) => num(h.value));
        topHolderShare = balances[0]! / totalSupply;
        top10Share =
          balances.slice(0, 10).reduce((a, b) => a + b, 0) / totalSupply;
      }

      // Age from oldest day-data
      const days = dayRes.tokenDayDatas ?? [];
      let ageDays: number | null = null;
      if (days.length > 0) {
        const oldest = days[days.length - 1]!;
        ageDays = Math.max(
          0,
          (Date.now() / 1000 - oldest.date) / 86_400,
        );
      }

      // Honeypot heuristics
      const honeypotFlags: string[] = [];
      if (liquidityUsd > 0 && liquidityUsd < 500) {
        honeypotFlags.push("very_low_liquidity");
      }
      if (topHolderShare !== null && topHolderShare > 0.8) {
        honeypotFlags.push("extreme_holder_concentration");
      }
      // ABI findings stay in suspiciousAbi only — do not duplicate into honeypotFlags.

      // Optional transfer simulation: try transfer from top holder → dead address
      // via eth_call (static). If it reverts, flag. This is approximate only.
      let sellSimulation: {
        attempted: boolean;
        success: boolean | null;
        detail: string;
      } = {
        attempted: false,
        success: null,
        detail: "skipped",
      };

      if (items[0]?.address?.hash && totalSupply > 0) {
        try {
          const holder = items[0].address.hash as Address;
          const client = getPublicClient(cfg);
          // transfer(address,uint256) selector + args for 1 raw unit
          const amount = 1n;
          const data = encodeTransferCalldata(
            "0x000000000000000000000000000000000000dEaD",
            amount,
          );
          const ret = await client.call({
            account: holder,
            to: address,
            data,
          });
          const dataHex = (typeof ret === "string" ? ret : (ret as { data?: Hex })?.data) as
            | Hex
            | undefined;
          const succeeded = erc20CallIndicatesSuccess(dataHex);
          sellSimulation = {
            attempted: true,
            success: succeeded,
            detail: succeeded
              ? "staticcall transfer(1) from top holder to dead did not revert"
              : "staticcall transfer(1) returned ABI false (token rejected the transfer without reverting)",
          };
          if (!succeeded) {
            honeypotFlags.push("transfer_simulation_false");
          }
        } catch (err) {
          sellSimulation = {
            attempted: true,
            success: false,
            detail: `transfer simulation reverted: ${err instanceof Error ? err.message : String(err)}`,
          };
          honeypotFlags.push("transfer_simulation_revert");
        }
      }

      const { score, grade, factors } = computeSafetyScore({
        verified,
        ownershipRenounced: ownerInfo.renounced,
        liquidityUsd,
        topHolderShare,
        top10Share,
        ageDays,
        honeypotFlags,
        suspiciousAbi,
      });

      return ok({
        address: address.toLowerCase(),
        symbol: tokenRes.token?.symbol ?? null,
        name: tokenRes.token?.name ?? sourceEntry?.ContractName ?? null,
        score,
        grade,
        is_honeypot_heuristic: honeypotFlags.length >= 2 || sellSimulation.success === false,
        ownership_renounced: ownerInfo.renounced,
        owner: ownerInfo.owner,
        verified,
        buy_tax: null,
        sell_tax: null,
        tax_note:
          "Buy/sell tax percentages require on-chain fee simulation contracts; not available from public APIs alone",
        liquidity_usd: liquidityUsd,
        pair_count: pairs.length,
        top_holder_share: topHolderShare,
        top10_holder_share: top10Share,
        age_days: ageDays,
        suspicious_abi: suspiciousAbi,
        honeypot_flags: honeypotFlags,
        sell_simulation: sellSimulation,
        factors,
        limitations: [
          "Heuristic score only — NOT a security audit",
          "Cannot detect all honeypots, hidden mint, or malicious proxies",
          "Tax rates not measured without dedicated fee-checker simulation",
          "Holder data limited to BlockScout top-holders page",
          "Do not use as sole basis for financial decisions",
        ],
        method: "explorer+RPC+subgraph heuristic",
        confidence: "medium",
        subgraph: version,
        source: "public BlockScout + PulseX + RPC",
      });
    },
  });

  // ── get_token_liquidity ────────────────────────────────────────────────
  registerTool(server, config, {
    name: "get_token_liquidity",
    description:
      "Pool liquidity breakdown for a token: all major PulseX pairs, " +
      "reserves, and USD liquidity estimates.",
    category: "analytics",
    inputSchema: {
      address: addressSchema,
      limit: z.number().int().min(1).max(50).default(20),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const address = assertAddress(args.address as string);
      const limit = (args.limit as number) ?? 20;
      const version = asVersion(args.version);
      const pairs = await fetchPairsForToken(cfg, address, limit, version);
      const ranked = rankPairsBySaneLiquidity(pairs);
      const total = ranked.reduce((s, p) => s + p._saneLiquidityUsd, 0);
      const polluted = ranked.filter((p) => p._liquidityPolluted).length;

      return ok({
        address: address.toLowerCase(),
        total_liquidity_usd: total,
        pair_count: ranked.length,
        polluted_pair_count: polluted,
        pairs: ranked.map((p) => ({
          pair_address: p.id,
          dex: version === "v1" ? "PulseX V1" : "PulseX V2",
          token0_address: p.token0.id,
          token0_symbol: p.token0.symbol,
          token1_address: p.token1.id,
          token1_symbol: p.token1.symbol,
          liquidity_usd: p._saneLiquidityUsd,
          raw_reserve_usd: num(p.reserveUSD),
          liquidity_polluted: p._liquidityPolluted,
          reserve0: p.reserve0,
          reserve1: p.reserve1,
          volume_usd_cumulative: num(p.volumeUSD),
          tx_count: num(p.totalTransactions),
          share_of_liquidity:
            total > 0 ? p._saneLiquidityUsd / total : null,
        })),
        note:
          polluted > 0
            ? `${polluted} pair(s) had absurd/suspect reserveUSD; excluded or re-estimated in totals`
            : undefined,
        source: "PulseX subgraph pairs (sane reserveUSD ranking)",
        subgraph: version,
      });
    },
  });

  // ── get_honeypots ──────────────────────────────────────────────────────
  registerTool(server, config, {
    name: "get_honeypots",
    description:
      "HEURISTIC list of recently suspicious / high-risk tokens from public " +
      "PulseX + contract signals (low liquidity vs volume, suspicious ABI, " +
      "transfer simulation). NOT a guarantee of honeypot status — labels " +
      "confidence and method. For screening only.",
    category: "analytics",
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(20),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const limit = (args.limit as number) ?? 20;
      const version = asVersion(args.version);

      // Pull high-volume tokens, then score risk heuristics
      const { tokens } = await fetchTopTokens(cfg, {
        first: Math.min(limit * 3, 60),
        orderBy: "tradeVolumeUSD",
        version,
      });

      const candidates = (tokens ?? []).filter((t) => {
        // Skip core / stable assets
        const id = t.id.toLowerCase();
        if (id === WPLS_ADDRESS.toLowerCase()) return false;
        if (id === DAI_ADDRESS.toLowerCase()) return false;
        if (id === FORK_DAI_ADDRESS.toLowerCase()) return false;
        if (id === USDC_FROM_ETH_ADDRESS.toLowerCase()) return false;
        if (id === USDT_FROM_ETH_ADDRESS.toLowerCase()) return false;
        for (const core of Object.values(CORE_TOKENS)) {
          if (core.address.toLowerCase() === id) return false;
        }
        return true;
      });

      const results: Array<Record<string, unknown>> = [];

      for (const t of candidates) {
        if (results.length >= limit) break;
        const price = num(t.derivedUSD);
        const liqUnits = num(t.totalLiquidity);
        const liqUsd = liqUnits * price;
        const volume = num(t.tradeVolumeUSD);
        const flags: string[] = [];

        if (liqUsd < 1000 && volume > 10_000) {
          flags.push("high_volume_low_liquidity");
        }
        if (liqUsd < 100) flags.push("dust_liquidity");
        if (price === 0) flags.push("zero_price");

        // Quick ABI scan
        let suspicious: string[] = [];
        try {
          const abi = await getContractAbi(cfg, t.id);
          suspicious = scanSuspiciousPatterns(abi);
          flags.push(...suspicious.map((s) => `abi:${s}`));
        } catch {
          flags.push("abi_unavailable");
        }

        if (flags.length === 0) continue;

        results.push({
          address: t.id,
          name: t.name,
          symbol: t.symbol,
          price_usd: price,
          liquidity_usd_estimate: liqUsd,
          volume_usd_cumulative: volume,
          flags,
          risk_score: Math.min(100, flags.length * 25),
          detected_at: new Date().toISOString(),
          buy_tax: null,
          sell_tax: null,
          method: "heuristic_screen",
          confidence: "low",
          disclaimer:
            "Heuristic only — not confirmed honeypot. Verify on-chain before trading.",
        });
      }

      return ok({
        honeypots: results,
        count: results.length,
        limitations: [
          "No dedicated honeypot database — results are heuristic screens",
          "False positives and false negatives are expected",
          "Does not replace manual review or professional audit",
        ],
        method: "top tokens × liquidity/ABI heuristics",
        confidence: "low",
        subgraph: version,
        source: "PulseX subgraph + BlockScout ABI",
      });
    },
  });

  // ── get_bridge_stats ───────────────────────────────────────────────────
  registerTool(server, config, {
    name: "get_bridge_stats",
    description:
      "Best-effort PulseChain bridge / bridged-asset overview from public " +
      "PulseX liquidity of major bridged tokens (DAI/USDC/USDT from Ethereum). " +
      "LIMITED: daily inflow/outflow event series require bridge indexers " +
      "(not available via public PulseX/BlockScout alone). Documents gaps.",
    category: "analytics",
    inputSchema: {
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const version = asVersion(args.version);
      const bridged = [
        { symbol: "DAI", address: DAI_ADDRESS },
        { symbol: "USDC", address: USDC_FROM_ETH_ADDRESS },
        { symbol: "USDT", address: USDT_FROM_ETH_ADDRESS },
      ];

      const pairGroups: Array<
        Array<{
          id?: string;
          reserveUSD?: string | number;
          reserve0?: string | number;
          reserve1?: string | number;
          volumeUSD?: string | number;
          token0?: { derivedUSD?: string | number; id?: string; symbol?: string };
          token1?: { derivedUSD?: string | number; id?: string; symbol?: string };
        }>
      > = [];
      const assets = await Promise.all(
        bridged.map(async (b) => {
          try {
            const [tokenRes, pairs] = await Promise.all([
              fetchToken(cfg, b.address, version),
              fetchPairsForToken(cfg, b.address, 5, version),
            ]);
            pairGroups.push(pairs);
            const t = tokenRes.token;
            const liq = sumSanePairLiquidity(pairs);
            return {
              symbol: b.symbol,
              address: b.address.toLowerCase(),
              price_usd: num(t?.derivedUSD),
              pulsex_liquidity_usd: liq.totalUsd,
              trade_volume_usd_cumulative: num(t?.tradeVolumeUSD),
              polluted_pair_count: liq.pollutedPairCount,
              pairs: rankPairsBySaneLiquidity(pairs)
                .slice(0, 3)
                .map((p) => ({
                  pair_address: p.id,
                  pair: `${p.token0.symbol}/${p.token1.symbol}`,
                  liquidity_usd: p._saneLiquidityUsd,
                  raw_reserve_usd: num(p.reserveUSD),
                  liquidity_polluted: p._liquidityPolluted,
                })),
            };
          } catch (err) {
            return {
              symbol: b.symbol,
              address: b.address.toLowerCase(),
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );

      const uniquePairs = uniquePairsById(pairGroups);
      const uniqueLiq = sumSanePairLiquidity(uniquePairs);
      const totalBridgedLiquidity = uniqueLiq.totalUsd;
      const pollutedPairs = uniqueLiq.pollutedPairCount;

      return ok({
        bridged_assets: assets,
        total_bridged_stable_liquidity_usd: totalBridgedLiquidity,
        inflow_usd: null,
        outflow_usd: null,
        net_flow_usd: null,
        daily: [],
        limitations: [
          "Daily bridge inflow/outflow not available from public PulseX subgraph or BlockScout alone",
          "OmniBridge / Hyperlane transfer indexers (Dune, private APIs) are out of scope for free public-only mode",
          "Values shown are PulseX pool liquidity for major Ethereum-bridged stables as a proxy for bridged-asset depth",
          "Pair liquidity uses sanitized reserveUSD (absurd values demoted/re-estimated); still not a full USD oracle",
        ],
        method: "PulseX liquidity of known bridged tokens (sane reserveUSD ranking)",
        confidence: "low",
        note:
          pollutedPairs > 0
            ? `${pollutedPairs} pair(s) had suspect/absurd reserveUSD and were demoted or re-estimated before summing`
            : "For full bridge flow analytics use public Dune dashboards or run a dedicated bridge indexer",
        subgraph: version,
        source: "PulseX subgraph (public)",
      });
    },
  });

  // ── get_holder_leagues ─────────────────────────────────────────────────
  registerTool(server, config, {
    name: "get_holder_leagues",
    description:
      "Holder distribution buckets (poseidon/whale/shark/dolphin/squid/turtle) " +
      "for a core token or any address, using BlockScout top holders + PulseX " +
      "price. USD tiers are approximate community-style leagues.",
    category: "analytics",
    inputSchema: {
      symbol: z
        .enum(["PLS", "WPLS", "PLSX", "HEX", "INC", "DAI", "USDC", "USDT"])
        .optional()
        .describe("Core token symbol (preferred)"),
      address: addressSchema
        .optional()
        .describe("Token address if not using symbol"),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const version = asVersion(args.version);
      let tokenAddress: string | undefined;
      let symbol = (args.symbol as string | undefined)?.toUpperCase();

      if (symbol === "PLS") {
        // Native PLS has no ERC-20 holders; use WPLS as proxy
        tokenAddress = WPLS_ADDRESS;
        symbol = "WPLS";
      } else if (symbol) {
        const core = resolveCoreToken(symbol);
        if (!core) {
          throw new AppError(`Unknown core symbol: ${symbol}`, "NOT_FOUND");
        }
        tokenAddress = core.address;
      } else if (args.address) {
        tokenAddress = assertAddress(args.address as string);
      } else {
        throw new AppError(
          "Provide symbol (PLS/PLSX/HEX/INC/…) or address",
          "VALIDATION_ERROR",
        );
      }

      const addr = assertAddress(tokenAddress);

      const [holdersRes, tokenRes, v2Meta] = await Promise.all([
        getTokenHolders(cfg, addr, { limit: 50 }),
        fetchToken(cfg, addr, version).catch(() => ({ token: null })),
        getTokenInfoV2(cfg, addr).catch(() => null),
      ]);

      const priceUsd = num(tokenRes.token?.derivedUSD);
      const decimals = num(
        tokenRes.token?.decimals ?? v2Meta?.decimals,
        18,
      );
      const items = holdersRes.items ?? [];

      const holders = items.map((h) => {
        const raw = num(h.value);
        const balance = decimals >= 0 && decimals < 36 ? raw / 10 ** decimals : raw;
        const balanceUsd = balance * priceUsd;
        return {
          address: h.address.hash,
          is_contract: Boolean(h.address.is_contract),
          balance_raw: h.value,
          balance,
          balance_usd: balanceUsd,
          tier: tierForUsd(balanceUsd),
        };
      });

      const tiers = bucketHoldersByLeague(
        holders.map((h) => ({ balanceUsd: h.balance_usd })),
      );

      return ok({
        symbol:
          symbol ??
          tokenRes.token?.symbol ??
          v2Meta?.symbol ??
          null,
        address: addr.toLowerCase(),
        price_usd: priceUsd,
        total_holders_reported: v2Meta?.holders
          ? num(v2Meta.holders)
          : null,
        sample_size: holders.length,
        tiers,
        top_holders: holders.slice(0, 20),
        tier_thresholds_usd: {
          poseidon: 1_000_000,
          whale: 100_000,
          shark: 10_000,
          dolphin: 1_000,
          squid: 100,
          turtle: 0,
        },
        limitations: [
          "Based on BlockScout top-holders sample (not full holder set)",
          "USD values use PulseX derivedUSD; may diverge from CEX prices",
          "PLS uses WPLS holders as proxy (native PLS not ERC-20)",
        ],
        method: "BlockScout holders + PulseX price → USD tiers",
        confidence: holders.length > 0 && priceUsd > 0 ? "medium" : "low",
        subgraph: version,
        source: "api.scan.pulsechain.com + PulseX subgraph",
      });
    },
  });
}

/** Encode ERC-20 transfer(to, amount) calldata without importing full abi encode path thrice. */
function encodeTransferCalldata(to: string, amount: bigint): `0x${string}` {
  // transfer(address,uint256) = 0xa9059cbb
  const selector = "a9059cbb";
  const toClean = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amt = amount.toString(16).padStart(64, "0");
  return `0x${selector}${toClean}${amt}`;
}

/** ERC-20 transfer() may revert OR return ABI false without reverting. */
function erc20CallIndicatesSuccess(data: Hex | undefined): boolean {
  if (data === undefined || data === "0x") return true;
  try {
    const [ok] = decodeAbiParameters([{ type: "bool" }], data);
    return ok === true;
  } catch {
    const stripped = data.replace(/^0x/i, "");
    return stripped.length > 0 && !/^0+$/.test(stripped);
  }
}
