import { describe, expect, it } from "vitest";

import { getGeminiBackend } from "../src/google/client.js";

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(updates)) {
    prev[key] = process.env[key];
    const next = updates[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(updates)) {
      const value = prev[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("Gemini client", () => {
  it("prefers Vertex auth when a Google service account is configured", () => {
    withEnv(
      {
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
          project_id: "test-project",
          client_email: "service@example.com",
          private_key: "secret",
        }),
        GEMINI_API_KEY: "gemini-key",
        GOOGLE_API_KEY: "google-key",
      },
      () => {
        expect(getGeminiBackend()).toBe("vertex");
      },
    );
  });

  it("uses the API-key backend when no Google service account is configured", () => {
    withEnv(
      {
        GOOGLE_SERVICE_ACCOUNT_JSON: undefined,
        GEMINI_API_KEY: "gemini-key",
        GOOGLE_API_KEY: undefined,
      },
      () => {
        expect(getGeminiBackend()).toBe("api");
      },
    );
  });
});
