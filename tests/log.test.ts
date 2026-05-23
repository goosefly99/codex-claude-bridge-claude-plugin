/**
 * Logger redaction tests. Tokens must never appear in logs (DI-2 + privacy).
 */

import { describe, expect, it } from "vitest";

import { redact, REDACTED_VALUE } from "../scripts/util/log.js";

describe("log.redact", () => {
  it("redacts values under token-like keys", () => {
    const out = redact({
      authorization: "Bearer abcdef0123456789abcdef0123456789",
      access_token: "xyz",
      ok: "not-a-secret",
    });
    expect(out["authorization"]).toBe(REDACTED_VALUE);
    expect(out["access_token"]).toBe(REDACTED_VALUE);
    expect(out["ok"]).toBe("not-a-secret");
  });

  it("redacts bearer-shaped values even when key is innocent", () => {
    const out = redact({
      payload: "Bearer abcdef0123456789abcdef0123456789",
    });
    expect(out["payload"]).toBe(REDACTED_VALUE);
  });

  it("does not mutate the input object", () => {
    const input = { token: "abc" };
    redact(input);
    expect(input.token).toBe("abc");
  });

  it("recurses into nested objects", () => {
    const out = redact({ inner: { secret: "nope" } }) as { inner: { secret: string } };
    expect(out.inner.secret).toBe(REDACTED_VALUE);
  });

  it("recurses into arrays", () => {
    const out = redact({ list: [{ password: "x" }, { ok: "yes" }] }) as {
      list: Array<{ password?: string; ok?: string }>;
    };
    expect(out.list[0]?.password).toBe(REDACTED_VALUE);
    expect(out.list[1]?.ok).toBe("yes");
  });

  it("tolerates circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    a["self"] = a;
    expect(() => redact(a)).not.toThrow();
  });
});
