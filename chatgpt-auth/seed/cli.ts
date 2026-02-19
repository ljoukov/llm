#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import readline from "node:readline";
import { URL } from "node:url";

import { exchangeChatGptOauthCode } from "../../src/openai/chatgpt-auth.ts";
import { loadLocalEnv } from "../../src/utils/env.ts";

const CHATGPT_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";
const DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const FALLBACK_MODELS_CLIENT_VERSION = "0.0.0";
const DEFAULT_SMOKE_INPUT = "hi";

type CliOptions = {
  workerUrl: string;
  apiKey: string;
  redirectUri: string;
  timeoutMs: number;
  openBrowser: boolean;
  smokeCheck: boolean;
  smokeModel?: string;
  smokeInput: string;
};

async function main(): Promise<void> {
  loadLocalEnv();
  const options = parseCliOptions(process.argv.slice(2));

  const pkce = createPkce();
  const authorizeUrl = buildChatGptAuthorizeUrl({
    challenge: pkce.challenge,
    state: pkce.state,
    redirectUri: options.redirectUri,
  });

  process.stdout.write("OpenAI login URL:\n");
  process.stdout.write(`${authorizeUrl}\n\n`);

  if (options.openBrowser) {
    const opened = await tryOpenBrowser(authorizeUrl);
    if (!opened) {
      process.stdout.write("Could not auto-open a browser. Open the URL above manually.\n\n");
    }
  }

  let code: string;
  try {
    code = await waitForOauthCode({
      expectedState: pkce.state,
      redirectUri: options.redirectUri,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    const manualInput = await prompt("Paste redirect URL (or code): ");
    code = parseOAuthRedirect(manualInput, pkce.state).code;
  }

  const profile = await exchangeChatGptOauthCode({
    code,
    verifier: pkce.verifier,
    redirectUri: options.redirectUri,
  });

  const seeded = await seedWorker({
    workerUrl: options.workerUrl,
    apiKey: options.apiKey,
    token: {
      accessToken: profile.access,
      refreshToken: profile.refresh,
      expiresAt: profile.expires,
      accountId: profile.accountId,
      idToken: profile.idToken,
    },
  });

  process.stdout.write("\nSeed completed.\n");
  process.stdout.write(`Worker: ${options.workerUrl}\n`);
  process.stdout.write(`Account ID: ${seeded.accountId}\n`);
  process.stdout.write(`Expires at: ${new Date(seeded.expiresAt).toISOString()}\n`);
  if (seeded.accessTokenPreview) {
    process.stdout.write(`Access token: ${seeded.accessTokenPreview}\n`);
  }
  if (seeded.refreshTokenPreview) {
    process.stdout.write(`Refresh token: ${seeded.refreshTokenPreview}\n`);
  }

  if (options.smokeCheck) {
    const resolvedSmokeModel = await resolveSmokeModel({
      requestedModel: options.smokeModel,
      accessToken: profile.access,
      accountId: profile.accountId,
    });
    if (resolvedSmokeModel.source === "catalog") {
      process.stdout.write(
        `Resolved smoke model from ChatGPT catalog: ${resolvedSmokeModel.model}\n`,
      );
    }

    process.stdout.write(
      `\nRunning post-seed smoke check via llm package (${resolvedSmokeModel.model}) ...\n`,
    );
    const smokeResult = await runPostSeedSmokeCheck({
      workerUrl: options.workerUrl,
      apiKey: options.apiKey,
      model: resolvedSmokeModel.model,
      input: options.smokeInput,
    });
    process.stdout.write("Smoke check passed.\n");
    process.stdout.write(`Model version: ${smokeResult.modelVersion}\n`);
    process.stdout.write(`Output: ${JSON.stringify(smokeResult.text)}\n`);
    if (smokeResult.costUsd !== null) {
      process.stdout.write(`Cost USD: ${smokeResult.costUsd}\n`);
    }
  } else {
    process.stdout.write("\nSkipped post-seed smoke check (--skip-smoke-check).\n");
  }
}

function parseCliOptions(argv: string[]): CliOptions {
  let workerUrl =
    process.env.CHATGPT_AUTH_TOKEN_PROVIDER_URL ?? process.env.CHATGPT_AUTH_SERVER_URL ?? "";
  let apiKey =
    process.env.CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY ?? process.env.CHATGPT_AUTH_API_KEY ?? "";
  let redirectUri = DEFAULT_REDIRECT_URI;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let openBrowser = true;
  let smokeCheck = true;
  let smokeModel: string | undefined;
  let smokeInput = DEFAULT_SMOKE_INPUT;

  const requireValue = (flag: string, value: string | undefined): string => {
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        printHelpAndExit(0);
        break;
      case "--worker-url":
        workerUrl = requireValue(arg, argv[i + 1]);
        i += 1;
        break;
      case "--api-key":
        apiKey = requireValue(arg, argv[i + 1]);
        i += 1;
        break;
      case "--redirect-uri":
        redirectUri = requireValue(arg, argv[i + 1]);
        i += 1;
        break;
      case "--timeout-ms": {
        const raw = requireValue(arg, argv[i + 1]);
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid --timeout-ms value: ${raw}`);
        }
        timeoutMs = parsed;
        i += 1;
        break;
      }
      case "--no-open":
        openBrowser = false;
        break;
      case "--skip-smoke-check":
        smokeCheck = false;
        break;
      case "--smoke-model":
        smokeModel = normalizeSmokeModel(requireValue(arg, argv[i + 1]));
        i += 1;
        break;
      case "--smoke-input":
        smokeInput = requireValue(arg, argv[i + 1]);
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!workerUrl.trim()) {
    throw new Error("Missing worker URL. Set --worker-url or CHATGPT_AUTH_TOKEN_PROVIDER_URL.");
  }
  if (!apiKey.trim()) {
    throw new Error("Missing API key. Set --api-key or CHATGPT_AUTH_API_KEY.");
  }

  return {
    workerUrl: workerUrl.replace(/\/+$/u, ""),
    apiKey: apiKey.trim(),
    redirectUri,
    timeoutMs,
    openBrowser,
    smokeCheck,
    smokeModel,
    smokeInput,
  };
}

function printHelpAndExit(code: number): never {
  const usage = [
    "Usage:",
    "  npm run chatgpt-auth:seed -- [options]",
    "",
    "Options:",
    "  --worker-url <url>     Token provider base URL (default: CHATGPT_AUTH_TOKEN_PROVIDER_URL).",
    "  --api-key <key>        Token provider API key (default: CHATGPT_AUTH_API_KEY).",
    `  --redirect-uri <uri>   OAuth redirect URI (default: ${DEFAULT_REDIRECT_URI}).`,
    `  --timeout-ms <ms>      Callback wait timeout (default: ${DEFAULT_TIMEOUT_MS}).`,
    "  --no-open              Do not auto-open browser.",
    "  --skip-smoke-check     Do not run post-seed inference check.",
    "  --smoke-model <id>     Override smoke model (accepts chatgpt-* id or bare slug).",
    `  --smoke-input <text>   Prompt used for smoke check (default: ${JSON.stringify(DEFAULT_SMOKE_INPUT)}).`,
    "  -h, --help             Show this help.",
    "",
    "Example:",
    "  npm run chatgpt-auth:seed -- --worker-url https://chatgpt-auth.example.workers.dev",
  ].join("\n");
  process.stdout.write(`${usage}\n`);
  process.exit(code);
}

function normalizeSmokeModel(value: string): string {
  const model = value.trim();
  if (!model) {
    throw new Error("Empty --smoke-model value.");
  }
  return model.startsWith("chatgpt-") ? model : `chatgpt-${model}`;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function createPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = toBase64Url(randomBytes(64));
  const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
  const state = toBase64Url(randomBytes(32));
  return { verifier, challenge, state };
}

function buildChatGptAuthorizeUrl({
  challenge,
  state,
  redirectUri,
}: {
  challenge: string;
  state: string;
  redirectUri: string;
}): string {
  const url = new URL(CHATGPT_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CHATGPT_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "llm-chatgpt-auth-seed");
  return url.toString();
}

async function waitForOauthCode(options: {
  expectedState: string;
  redirectUri: string;
  timeoutMs: number;
}): Promise<string> {
  const redirect = new URL(options.redirectUri);
  if (redirect.protocol !== "http:") {
    throw new Error("Redirect URI must use http:// for local callback.");
  }
  if (redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") {
    throw new Error("Redirect URI host must be localhost or 127.0.0.1.");
  }

  const expectedPath = redirect.pathname || "/";
  const listenPort =
    redirect.port.length > 0
      ? Number.parseInt(redirect.port, 10)
      : redirect.protocol === "https:"
        ? 443
        : 80;
  if (!Number.isFinite(listenPort) || listenPort <= 0) {
    throw new Error(`Invalid redirect URI port: ${redirect.port || "<none>"}`);
  }

  process.stdout.write(
    `Waiting for OAuth callback on ${redirect.hostname}:${listenPort}${expectedPath} ...\n`,
  );

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", `${redirect.protocol}//${redirect.host}`);
      if (requestUrl.pathname !== expectedPath) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const errorParam = requestUrl.searchParams.get("error");
      if (errorParam) {
        const description = requestUrl.searchParams.get("error_description") ?? "";
        finish(
          new Error(
            `OAuth authorization failed: ${errorParam}${description ? ` (${description})` : ""}`,
          ),
        );
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Authorization failed. You can close this tab and return to the terminal.");
        return;
      }

      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");
      if (!code) {
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Missing OAuth code. You can close this tab and return to the terminal.");
        return;
      }
      if (!state || state !== options.expectedState) {
        finish(new Error("OAuth redirect state did not match."));
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Invalid OAuth state. You can close this tab and return to the terminal.");
        return;
      }

      finish(code);
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Login complete. You can close this tab and return to the terminal.");
    });

    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for OAuth callback."));
    }, options.timeoutMs);

    server.on("error", (error) => finish(error));
    server.listen(listenPort, redirect.hostname);

    function finish(result: string | Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      if (typeof result === "string") {
        resolve(result);
      } else {
        reject(result);
      }
    }
  });
}

function parseOAuthRedirect(
  input: string,
  expectedState: string,
): { code: string; state?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty OAuth redirect input.");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? undefined;
    if (!code) {
      throw new Error("OAuth redirect URL is missing code parameter.");
    }
    if (state !== expectedState) {
      throw new Error("OAuth redirect state did not match.");
    }
    return { code, state };
  }

  if (trimmed.includes("=")) {
    const params = new URLSearchParams(trimmed.startsWith("?") ? trimmed.slice(1) : trimmed);
    const code = params.get("code");
    const state = params.get("state") ?? undefined;
    if (!code) {
      throw new Error("OAuth redirect input is missing code parameter.");
    }
    if (state !== expectedState) {
      throw new Error("OAuth redirect state did not match.");
    }
    return { code, state };
  }

  return { code: trimmed };
}

async function seedWorker(options: {
  workerUrl: string;
  apiKey: string;
  token: {
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    expiresAt: number;
    accountId: string;
  };
}): Promise<{
  accountId: string;
  expiresAt: number;
  accessTokenPreview?: string;
  refreshTokenPreview?: string;
}> {
  const url = `${options.workerUrl}/v1/seed`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${options.apiKey}`,
      "x-chatgpt-auth": options.apiKey,
    },
    body: JSON.stringify(options.token),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Seed failed (${response.status}): ${raw}`);
  }
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Seed succeeded but response was not valid JSON: ${raw}`);
  }
  return {
    accountId: String(payload.accountId ?? options.token.accountId),
    expiresAt: Number(payload.expiresAt ?? options.token.expiresAt),
    accessTokenPreview:
      typeof payload.accessTokenPreview === "string" ? payload.accessTokenPreview : undefined,
    refreshTokenPreview:
      typeof payload.refreshTokenPreview === "string" ? payload.refreshTokenPreview : undefined,
  };
}

type CatalogModel = {
  slug: string;
  supported_in_api?: boolean;
  visibility?: string;
  priority?: number;
};

async function resolveSmokeModel(options: {
  requestedModel?: string;
  accessToken: string;
  accountId: string;
}): Promise<{
  model: string;
  source: "requested" | "catalog";
}> {
  if (options.requestedModel) {
    return { model: options.requestedModel, source: "requested" };
  }

  try {
    const models = await fetchChatGptCatalogModels({
      accessToken: options.accessToken,
      accountId: options.accountId,
      clientVersion: resolveModelsClientVersion(),
    });
    const selected = selectLowestCostSmokeCandidate(models);
    if (selected) {
      return { model: `chatgpt-${selected.slug}`, source: "catalog" };
    }
    throw new Error("no supported API models in catalog");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not resolve smoke model from ChatGPT catalog (${reason}). Pass --smoke-model or --skip-smoke-check.`,
    );
  }
}

async function fetchChatGptCatalogModels(options: {
  accessToken: string;
  accountId: string;
  clientVersion: string;
}): Promise<CatalogModel[]> {
  const url = new URL(CHATGPT_CODEX_MODELS_ENDPOINT);
  url.searchParams.set("client_version", options.clientVersion);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      authorization: `Bearer ${options.accessToken}`,
      "chatgpt-account-id": options.accountId,
      originator: "llm-chatgpt-auth-seed",
      accept: "application/json",
      "user-agent": "llm-chatgpt-auth-seed",
    },
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`catalog request failed (${response.status})`);
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("catalog response was not JSON");
  }
  const modelsRaw = payload?.models;
  if (!Array.isArray(modelsRaw)) {
    throw new Error("catalog response missing models array");
  }

  return modelsRaw
    .map((item) => ({
      slug: typeof item?.slug === "string" ? item.slug : "",
      supported_in_api:
        typeof item?.supported_in_api === "boolean" ? item.supported_in_api : undefined,
      visibility: typeof item?.visibility === "string" ? item.visibility : undefined,
      priority: Number.isFinite(item?.priority) ? Number(item.priority) : undefined,
    }))
    .filter((item) => item.slug.length > 0);
}

function selectLowestCostSmokeCandidate(models: CatalogModel[]): CatalogModel | null {
  const apiModels = models.filter((model) => model.supported_in_api !== false);
  if (apiModels.length === 0) {
    return null;
  }

  const visible = apiModels.filter((model) => (model.visibility ?? "list") === "list");
  const pool = visible.length > 0 ? visible : apiModels;
  const ranked = [...pool].sort((a, b) => {
    const scoreDiff = smokeModelCostScore(a.slug) - smokeModelCostScore(b.slug);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return modelPriority(a) - modelPriority(b);
  });
  return ranked[0] ?? null;
}

function smokeModelCostScore(slug: string): number {
  const normalized = slug.toLowerCase();
  if (normalized.includes("codex-mini")) {
    return 0;
  }
  if (normalized.includes("mini")) {
    return 1;
  }
  return 2;
}

function modelPriority(model: CatalogModel): number {
  return Number.isFinite(model.priority) ? Number(model.priority) : Number.MAX_SAFE_INTEGER;
}

function resolveModelsClientVersion(): string {
  try {
    const packageJsonUrl = new URL("../../package.json", import.meta.url);
    const raw = fs.readFileSync(packageJsonUrl, "utf8");
    const payload = JSON.parse(raw) as { version?: unknown };
    const rawVersion =
      typeof payload.version === "string" ? payload.version.trim() : FALLBACK_MODELS_CLIENT_VERSION;
    const semver = rawVersion.match(/^\d+\.\d+\.\d+/u)?.[0];
    if (semver) {
      return semver;
    }
  } catch {
    // Fall through to fallback value.
  }
  return FALLBACK_MODELS_CLIENT_VERSION;
}

async function runPostSeedSmokeCheck(options: {
  workerUrl: string;
  apiKey: string;
  model: string;
  input: string;
}): Promise<{ text: string; modelVersion: string; costUsd: number | null }> {
  process.env.CHATGPT_AUTH_TOKEN_PROVIDER_URL = options.workerUrl;
  process.env.CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY = options.apiKey;
  process.env.CHATGPT_AUTH_API_KEY = options.apiKey;

  const { generateText } = await import("../../src/index.ts");
  const result = await generateText({
    model: options.model,
    input: options.input,
  });

  return {
    text: result.text,
    modelVersion: result.modelVersion,
    costUsd: Number.isFinite(result.costUsd) ? result.costUsd : null,
  };
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function tryOpenBrowser(url: string): Promise<boolean> {
  if (process.platform === "darwin") {
    return spawnDetached("open", [url]);
  }
  if (process.platform === "win32") {
    return spawnDetached("cmd", ["/c", "start", "", url]);
  }
  if (process.platform === "linux") {
    return spawnDetached("xdg-open", [url]);
  }
  return false;
}

function spawnDetached(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => resolve(false));
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
