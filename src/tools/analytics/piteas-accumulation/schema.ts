import { z } from "zod";

export const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("Verified token contract address. Symbols are rejected.");

export const decimalHumanSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .describe("Positive human decimal amount. Scientific notation is not accepted.");
