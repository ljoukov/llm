import { describe, expect, it } from "vitest";

import {
  FIREWORKS_MODEL_IDS,
  isFireworksModelId,
  resolveFireworksModelId,
} from "../src/fireworks/models.js";

describe("fireworks model ids", () => {
  it("includes minimax-m2.1 in supported ids", () => {
    expect(FIREWORKS_MODEL_IDS).toContain("minimax-m2.1");
  });

  it("recognizes minimax-m2.1 as a Fireworks model id", () => {
    expect(isFireworksModelId("minimax-m2.1")).toBe(true);
  });

  it("resolves minimax-m2.1 to the canonical Fireworks model id", () => {
    expect(resolveFireworksModelId("minimax-m2.1")).toBe("accounts/fireworks/models/minimax-m2p1");
    expect(resolveFireworksModelId(" minimax-m2.1 ")).toBe(
      "accounts/fireworks/models/minimax-m2p1",
    );
  });
});
