import type { PiteasQuoteData } from "../../../data/piteas.js";
import { stableJson } from "./decimalMath.js";
import type {
  RouteChangeDetails,
  RouteSignatureConfidence,
  SuccessfulPoint,
} from "./types.js";

export function routeSummary(data: PiteasQuoteData): Record<string, unknown> | null {
  const route = data.route;
  const tokenPath = normalizeTokenPath(
    route?.tokenPath,
    data.tokenInParam,
    data.tokenOutParam,
  );
  const structuralRouteFields = {
    protocols: normalizeProtocolNames(route?.protocols ?? []),
    routers: normalizeAddressList([route?.router ?? data.router]),
    pools: normalizeAddressList(route?.pools ?? []),
    tokenPath,
    pathCount: route?.pathCount ?? null,
    swapCount: route?.swapCount ?? null,
  };
  const allocations = normalizeAllocations(route?.allocations ?? []);
  const economicRouteFields = {
    allocations,
    inputRaw: String(data.amountIn),
    expectedOutputRaw: String(data.amountOut),
    minimumOutputRaw: data.amountOutMin !== undefined ? String(data.amountOutMin) : null,
    gasUseEstimate: data.gasUseEstimate ?? null,
    gasUseEstimateUSD: data.gasUseEstimateUSD ?? null,
  };
  const structuralRouteSignature = stableJson(structuralRouteFields);
  const economicRouteFingerprint = stableJson({
    structuralRouteSignature,
    ...economicRouteFields,
  });
  return {
    pathCount: structuralRouteFields.pathCount,
    swapCount: structuralRouteFields.swapCount,
    protocols: structuralRouteFields.protocols,
    pools: structuralRouteFields.pools,
    tokenPath: structuralRouteFields.tokenPath,
    router: structuralRouteFields.routers[0] ?? null,
    routers: structuralRouteFields.routers,
    allocations,
    structuralRouteFields,
    economicRouteFields,
    structuralRouteSignature,
    economicRouteFingerprint,
    signature: structuralRouteSignature,
    routeSignatureConfidence: routeConfidence(structuralRouteFields),
    routeMetadataCompletenessPercent:
      routeMetadataCompletenessPercent(structuralRouteFields),
    note: route?.note ?? "No route summary returned by Piteas.",
  };
}

export function normalizeProtocolNames(values: unknown): string[] {
  const list = Array.isArray(values) ? values : [];
  return [...new Set(
    list
      .map((value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " "))
      .filter(Boolean),
  )].sort();
}

export function normalizeAddressList(values: unknown): string[] {
  const list = Array.isArray(values) ? values : [];
  return [...new Set(
    list
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter((value) => /^0x[a-f0-9]{40}$/.test(value)),
  )].sort();
}

export function normalizeTokenPath(
  value: unknown,
  tokenIn: string,
  tokenOut: string,
): string[] {
  const routed = Array.isArray(value)
    ? value
        .map((token) => String(token ?? "").trim().toLowerCase())
        .filter((token) => /^0x[a-f0-9]{40}$/.test(token))
    : [];
  return uniqueStrings([
    tokenIn.toLowerCase(),
    ...routed,
    tokenOut.toLowerCase(),
  ]);
}

export function normalizeAllocations(
  values: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return values.map((allocation) => {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(allocation)) {
      if (value === undefined) continue;
      if (typeof value === "string") {
        normalized[key] = value.trim();
      } else if (typeof value === "number" && Number.isFinite(value)) {
        normalized[key] = String(value);
      } else {
        normalized[key] = value;
      }
    }
    return normalized;
  });
}

export function routeConfidence(fields: Record<string, unknown>): RouteSignatureConfidence {
  const protocols = stringArrayField(fields, "protocols");
  const pools = stringArrayField(fields, "pools");
  const routers = stringArrayField(fields, "routers");
  const tokenPath = stringArrayField(fields, "tokenPath");
  if (
    protocols.length > 0 &&
    pools.length > 0 &&
    routers.length > 0 &&
    tokenPath.length >= 2
  ) {
    return "high";
  }
  if (protocols.length > 0 && tokenPath.length >= 2) {
    return "medium";
  }
  return "low";
}

export function routeMetadataCompletenessPercent(fields: Record<string, unknown>): number {
  const checks = [
    stringArrayField(fields, "protocols").length > 0,
    stringArrayField(fields, "pools").length > 0,
    stringArrayField(fields, "routers").length > 0,
    stringArrayField(fields, "tokenPath").length >= 2,
    fields.pathCount !== null && fields.pathCount !== undefined,
    fields.swapCount !== null && fields.swapCount !== undefined,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

export function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function emptyRouteChangeDetails(): RouteChangeDetails {
  return {
    structuralRouteChanged: false,
    allocationChanged: false,
    poolChanged: false,
    protocolChanged: false,
    routerChanged: false,
    tokenPathChanged: false,
    onlyEconomicValuesChanged: false,
  };
}

export function buildRouteChangeDetails(
  previous: SuccessfulPoint,
  point: SuccessfulPoint,
): RouteChangeDetails {
  const previousFields = routeStructuralFields(previous);
  const fields = routeStructuralFields(point);
  const previousEconomics = routeEconomicFields(previous);
  const economics = routeEconomicFields(point);
  const protocolChanged = !sameStringArray(
    stringArrayField(previousFields, "protocols"),
    stringArrayField(fields, "protocols"),
  );
  const poolChanged = !sameStringArray(
    stringArrayField(previousFields, "pools"),
    stringArrayField(fields, "pools"),
  );
  const routerChanged = !sameStringArray(
    stringArrayField(previousFields, "routers"),
    stringArrayField(fields, "routers"),
  );
  const tokenPathChanged = !sameStringArray(
    stringArrayField(previousFields, "tokenPath"),
    stringArrayField(fields, "tokenPath"),
  );
  const pathCountChanged = previousFields.pathCount !== fields.pathCount;
  const swapCountChanged = previousFields.swapCount !== fields.swapCount;
  const structuralRouteChanged =
    protocolChanged ||
    poolChanged ||
    routerChanged ||
    tokenPathChanged ||
    pathCountChanged ||
    swapCountChanged;
  const allocationChanged =
    stableJson(previousEconomics.allocations ?? []) !==
    stableJson(economics.allocations ?? []);
  const economicValuesChanged =
    previous.economicRouteFingerprint !== point.economicRouteFingerprint;
  return {
    structuralRouteChanged,
    allocationChanged,
    poolChanged,
    protocolChanged,
    routerChanged,
    tokenPathChanged,
    onlyEconomicValuesChanged: !structuralRouteChanged && economicValuesChanged,
  };
}

export function routeStructuralFields(point: SuccessfulPoint): Record<string, unknown> {
  return (
    (point.routeComposition?.structuralRouteFields as Record<string, unknown> | undefined) ??
    {
      protocols: [],
      routers: [],
      pools: [],
      tokenPath: [],
      pathCount: null,
      swapCount: null,
    }
  );
}

export function routeEconomicFields(point: SuccessfulPoint): Record<string, unknown> {
  return (
    (point.routeComposition?.economicRouteFields as Record<string, unknown> | undefined) ??
    { allocations: [] }
  );
}

export function routesStructurallyIncompatible(
  previous: SuccessfulPoint,
  point: SuccessfulPoint,
  details: RouteChangeDetails = buildRouteChangeDetails(previous, point),
): boolean {
  if (!details.structuralRouteChanged) return false;
  if (
    previous.routeSignatureConfidence === "low" ||
    point.routeSignatureConfidence === "low"
  ) {
    return false;
  }
  return true;
}

export function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function isRouteSignatureConfidence(value: unknown): value is RouteSignatureConfidence {
  return value === "high" || value === "medium" || value === "low";
}

export function weakestRouteConfidence(points: SuccessfulPoint[]): RouteSignatureConfidence {
  if (points.some((point) => point.routeSignatureConfidence === "low")) return "low";
  if (points.some((point) => point.routeSignatureConfidence === "medium")) return "medium";
  return "high";
}

export function lowestRouteMetadataCompleteness(points: SuccessfulPoint[]): number {
  if (points.length === 0) return 0;
  return Math.min(...points.map((point) => point.routeMetadataCompletenessPercent));
}
