import { describe, it, expect } from "vitest";
import { totpCode, base32Decode } from "../src/dhanAuth.ts";
// RFC 6238 Appendix B test vectors (SHA1 secret "12345678901234567890"), last 6 digits
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
describe("TOTP (RFC 6238)", () => {
  it.each([[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]])("t=%i → %s", (t, code) => {
    expect(totpCode(SECRET, t * 1000)).toBe(code);
  });
  it("accepts spaced / lowercase secrets and rejects invalid characters", () => {
    expect(base32Decode("gezd gnbv gy3t qojq").toString()).toBe("1234567890");
    expect(() => base32Decode("ABC1!")).toThrow(/galat character/);
  });
});
