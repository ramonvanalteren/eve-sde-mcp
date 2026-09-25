import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { packageVersion } from "../src/version.js";

describe("packageVersion", () => {
  it("matches package.json's own version (read independently, not hardcoded, so this can't go stale)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(packageVersion).toBe(pkg.version);
  });
});
