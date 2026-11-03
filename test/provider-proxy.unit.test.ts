import { Agent, type Dispatcher, MockAgent, ProxyAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";

vi.mock("../src/xai/auth.js", () => ({
  getXaiSubscriptionAuth: async () => ({ token: "subscription-token", clientVersion: "1.0.67" }),
}));

const routes = ["xai:api", "xai:subscription", "fireworks"] as const;

describe("provider HTTP proxy environment", () => {
  let network: MockAgent;
  let proxyDispatch: MockInstance<Dispatcher["dispatch"]>;
  let directDispatch: MockInstance<Dispatcher["dispatch"]>;

  beforeEach(() => {
    resetRuntimeSingletonsForTesting();
    vi.resetModules();
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ])
      vi.stubEnv(name, undefined);
    vi.stubEnv("XAI_API_KEY", "api-token");
    vi.stubEnv("XAI_BASE_URL", "");
    vi.stubEnv("FIREWORKS_API_KEY", "fireworks-token");
    vi.stubEnv("FIREWORKS_BASE_URL", "");

    // Keep the real fetch and environment dispatcher. Replace only the final
    // network dispatch so HTTPS and pinned subscription hosts need no live server.
    network = new MockAgent();
    network.disableNetConnect();
    for (const origin of [
      "https://api.x.ai",
      "https://cli-chat-proxy.grok.com",
      "https://api.fireworks.ai",
      "http://api.example",
    ]) {
      network
        .get(origin)
        .intercept({ path: /\/models$/, method: "GET" })
        .reply(200, { data: [] }, { headers: { "content-type": "application/json" } });
    }
    const dispatch = (options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) =>
      network.get(String(options.origin)).dispatch(options, handler);
    proxyDispatch = vi.spyOn(ProxyAgent.prototype, "dispatch").mockImplementation(dispatch);
    directDispatch = vi.spyOn(Agent.prototype, "dispatch").mockImplementation(dispatch);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await network.close();
  });

  async function listModels(route: (typeof routes)[number]) {
    if (route === "fireworks") {
      const { getFireworksClient } = await import("../src/fireworks/client.js");
      await getFireworksClient().models.list();
    } else {
      const { getXaiClient } = await import("../src/xai/client.js");
      const access = route === "xai:api" ? "api" : "subscription";
      await (await getXaiClient("grok-4.7", access)).models.list();
    }
  }

  describe.each(routes)("%s", (route) => {
    it.each([
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "https_proxy",
      "http_proxy",
    ])("uses %s for HTTPS requests", async (variable) => {
      vi.stubEnv(variable, "http://proxy.example:8080");
      await listModels(route);
      expect(proxyDispatch).toHaveBeenCalledTimes(1);
      expect(directDispatch).not.toHaveBeenCalled();
    });

    it.each(["NO_PROXY", "no_proxy"])("bypasses the proxy for %s hosts", async (variable) => {
      vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
      vi.stubEnv(variable, "api.x.ai,cli-chat-proxy.grok.com,api.fireworks.ai");
      await listModels(route);
      expect(directDispatch).toHaveBeenCalledTimes(1);
      expect(proxyDispatch).not.toHaveBeenCalled();
    });

    it("sends requests directly when no proxy is configured", async () => {
      await listModels(route);
      expect(directDispatch).toHaveBeenCalledTimes(1);
      expect(proxyDispatch).not.toHaveBeenCalled();
    });
  });

  it.each([
    "xai:api",
    "fireworks",
  ] as const)("uses HTTP_PROXY for %s HTTP overrides", async (route) => {
    vi.stubEnv("HTTP_PROXY", "http://proxy.example:8080");
    vi.stubEnv("XAI_BASE_URL", "http://api.example/v1");
    vi.stubEnv("FIREWORKS_BASE_URL", "http://api.example/v1");
    await listModels(route);
    expect(proxyDispatch).toHaveBeenCalledTimes(1);
    expect(directDispatch).not.toHaveBeenCalled();
  });
});
