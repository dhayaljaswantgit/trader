import { describe, expect, it } from "vitest";
import { readSession, signSession } from "../src/auth.ts";

describe("google session cookie", () => {
  const key = Buffer.from("k".repeat(32)), allowed = ["me@x.com"];
  it("accepts a valid cookie for an allowed email", () => expect(readSession(signSession("me@x.com", key), key, allowed)).toBe("me@x.com"));
  it("rejects tampering, other keys, expiry and removed emails", () => {
    const v = signSession("me@x.com", key);
    expect(readSession(signSession("evil@x.com", key).split(".")[0] + "." + v.split(".")[1], key, allowed)).toBeNull();
    expect(readSession(v, Buffer.from("z".repeat(32)), allowed)).toBeNull();
    expect(readSession(v, key, allowed, Date.now() + 8 * 86400000)).toBeNull();
    expect(readSession(v, key, ["other@x.com"])).toBeNull();
    expect(readSession(undefined, key, allowed)).toBeNull();
  });
});
