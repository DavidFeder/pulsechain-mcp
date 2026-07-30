import { describe, expect, it } from "vitest";
import { fail, ok, toMcpToolResponse, toTextContent } from "../src/utils/result.js";
import { PolicyError } from "../src/utils/errors.js";

describe("result envelope", () => {
  it("ok wraps data", () => {
    const r = ok({ a: 1 }, ["note"]);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ a: 1 });
    expect(r.warnings).toEqual(["note"]);
  });

  it("fail maps AppError codes", () => {
    const r = fail(new PolicyError("nope"));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("POLICY_ERROR");
    expect(r.error).toMatch(/nope/);
  });

  it("toMcpToolResponse sets isError on failure", () => {
    const good = toMcpToolResponse(ok(true));
    expect(good.isError).toBeUndefined();
    expect(JSON.parse(good.content[0]!.text).ok).toBe(true);

    const bad = toMcpToolResponse(fail("x", "ERR"));
    expect(bad.isError).toBe(true);
    expect(toTextContent(fail("x"))).toContain('"ok": false');
  });
});
