import { describe, it, expect } from "vitest";
import { sizedLots } from "./positionSizing";

describe("sizedLots — AI position sizing from instrumentSizing", () => {
  it("lots mode → fixed lot count", () => {
    expect(sizedLots({ mode: "lots", value: 10 }, 100_000, 100, 15)).toBe(10);
    expect(sizedLots({ mode: "lots", value: 3.6 }, 100_000, 100, 15)).toBe(4); // rounded
  });

  it("percent mode → % of pool spent on premium / (premium*lotSize)", () => {
    // 50% of 100k = 50k; /(100*15)=33.3 → 33 lots
    expect(sizedLots({ mode: "percent", value: 50 }, 100_000, 100, 15)).toBe(33);
    // 10% of 75k = 7500; /(950*15)=0.52 → floored to min 1
    expect(sizedLots({ mode: "percent", value: 10 }, 75_000, 950, 15)).toBe(1);
  });

  it("amount mode → fixed ₹ spend / (premium*lotSize), independent of pool", () => {
    // ₹2,00,000 / (100*15) = 133.3 → 133 lots (pool is irrelevant in amount mode)
    expect(sizedLots({ mode: "amount", value: 200_000 }, 100_000, 100, 15)).toBe(133);
    // ₹50,000 / (950*15) = 3.5 → 3 lots
    expect(sizedLots({ mode: "amount", value: 50_000 }, 100_000, 950, 15)).toBe(3);
    // too small to afford one lot → min 1
    expect(sizedLots({ mode: "amount", value: 100 }, 100_000, 950, 15)).toBe(1);
  });

  it("absent sizing or unusable inputs → 1 lot (safe default)", () => {
    expect(sizedLots(undefined, 100_000, 100, 15)).toBe(1);
    expect(sizedLots({ mode: "percent", value: 50 }, 100_000, 0, 15)).toBe(1); // no premium
    expect(sizedLots({ mode: "percent", value: 50 }, 0, 100, 15)).toBe(1); // no capital
    expect(sizedLots({ mode: "amount", value: 200_000 }, 100_000, 0, 15)).toBe(1); // no premium
    expect(sizedLots({ mode: "amount", value: 0 }, 100_000, 100, 15)).toBe(1); // no amount set
  });
});
