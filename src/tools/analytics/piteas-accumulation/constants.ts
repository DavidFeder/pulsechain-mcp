import { PITEAS_API_BASE } from "../../../data/piteas.js";

export const SAME_STATE_WARNING =
  "Executing the first chunk changes pool and route state. Later chunks cannot be assumed to receive the same quote.";
export const MAX_LADDER_POINTS = 20;
export const MAX_FOCUSED_POINTS = 12;
export const MAX_CANDIDATE_CHUNK_COUNTS = 20;
export const MAX_CANDIDATE_CHUNK_COUNT = 100;
export const DEFAULT_GENERATED_STEPS = 5;
export const DEFAULT_EUSDC_DECIMALS = 6;
export const DEFAULT_PHIAT_DECIMALS = 18;
export const PRICE_SCALE_DECIMALS = 18;
export const DEFAULT_MAX_BLOCK_SPREAD = 1;
export const DEFAULT_MAX_COLLECTION_DURATION_MS = 30_000;
export const DEFAULT_MAX_QUOTE_AGE_SPREAD_MS = 30_000;
export const DEFAULT_FOCUSED_REFRESH_DURATION_MS = 20_000;
export const DEFAULT_MAX_PAIR_WINDOW_MS = 45_000;
export const DEFAULT_MAX_BATCH_WINDOW_MS = 45_000;
export const DEFAULT_MAX_REFERENCE_DRIFT_PERCENT = 0.5;
export const DEFAULT_QUOTE_CONCURRENCY = 2;
export const MAX_QUOTE_CONCURRENCY = 5;
export const DEFAULT_MAX_ADAPTIVE_ROUNDS = 3;
export const DEFAULT_REFERENCE_AMOUNT_CANDIDATES = ["5", "10", "20"] as const;
export const DEFAULT_DISCOVERY_RETRY_COUNT = 1;
export const DEFAULT_TRANCHE_INCREMENT_HUMAN = "5";
export const DEFAULT_OPERATIONAL_SAFETY_BUFFER_PERCENT = 0.5;
export const PITEAS_QUOTE_ENDPOINT = `${PITEAS_API_BASE}/quote`;
