import { FEE_BPS, FORFEIT_CUT_BPS, WalletError, feeOf, splitWithFee, validateLegs } from "@saas/db/wallet";

describe("wallet money math (integer minor units)", () => {
  it("takes 6% and rounds the fee down so the creator keeps the remainder", () => {
    expect(FEE_BPS).toBe(600);
    expect(splitWithFee(500)).toEqual({ net: 470, fee: 30 });
    expect(splitWithFee(199)).toEqual({ net: 188, fee: 11 });
    expect(splitWithFee(10)).toEqual({ net: 10, fee: 0 });
  });
  it("forfeits 20% of a spam deposit to the platform", () => {
    expect(feeOf(200, FORFEIT_CUT_BPS)).toBe(40);
  });
  it("accepts a balanced transfer", () => {
    expect(() => validateLegs([
      { owner: { kind: "user", userId: "a" }, amountMinor: -500 },
      { owner: { kind: "user", userId: "b" }, amountMinor: 470 },
      { owner: { kind: "platform" }, amountMinor: 30 },
    ])).not.toThrow();
  });
  it("rejects unbalanced, zero, fractional and single-leg transfers", () => {
    const bad: Array<Parameters<typeof validateLegs>[0]> = [
      [{ owner: { kind: "platform" }, amountMinor: -1 }, { owner: { kind: "escrow" }, amountMinor: 2 }],
      [{ owner: { kind: "platform" }, amountMinor: 0 }, { owner: { kind: "escrow" }, amountMinor: 0 }],
      [{ owner: { kind: "platform" }, amountMinor: -1.5 }, { owner: { kind: "escrow" }, amountMinor: 1.5 }],
      [{ owner: { kind: "platform" }, amountMinor: 1 }],
    ];
    for (const legs of bad) expect(() => validateLegs(legs)).toThrow(WalletError);
  });
});
