import { describe, it, expect } from "vitest";
import { hangarNameForFlag } from "../src/tools/corporation.js";

describe("hangarNameForFlag", () => {
  it("maps a CorpSAG flag to its custom division name", () => {
    const names = new Map([[3, "Manufacturing Materials"]]);
    expect(hangarNameForFlag("CorpSAG3", names)).toBe("Manufacturing Materials");
  });

  it("returns null for a hangar division nobody renamed, rather than a placeholder", () => {
    const names = new Map([[3, "Manufacturing Materials"]]);
    expect(hangarNameForFlag("CorpSAG5", names)).toBeNull();
  });

  it("returns null for a non-hangar location flag", () => {
    const names = new Map([[1, "Master Hangar"]]);
    expect(hangarNameForFlag("Hangar", names)).toBeNull();
    expect(hangarNameForFlag("AssetSafety", names)).toBeNull();
    expect(hangarNameForFlag("Deliveries", names)).toBeNull();
  });

  it("covers all 7 valid divisions", () => {
    const names = new Map([1, 2, 3, 4, 5, 6, 7].map((n) => [n, `Division ${n}`]));
    for (let i = 1; i <= 7; i++) {
      expect(hangarNameForFlag(`CorpSAG${i}`, names)).toBe(`Division ${i}`);
    }
  });

  it("returns null on an empty names map without throwing", () => {
    expect(hangarNameForFlag("CorpSAG1", new Map())).toBeNull();
  });
});
