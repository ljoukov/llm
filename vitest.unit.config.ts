import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { LLM_AUTH_URL: "", LLM_AUTH_API_KEY: "", LLM_PROXY_URL: "", LLM_PROXY_API_KEY: "" },
    include: ["test/**/*.unit.test.ts"],
    exclude: ["test/**/*.integration.test.ts"],
  },
});
