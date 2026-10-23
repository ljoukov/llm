import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";

const XAI_ISSUER = "https://auth.x.ai";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const LEGACY_SCOPE = "https://accounts.x.ai/sign-in";
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const EXPIRY_BUFFER_MS = 30_000;
const HELPER_WAIT_MS = 45_000;

type GrokCredential = {
  key: string;
  auth_mode: string;
  create_time?: string;
  expires_at?: string;
  oidc_issuer?: string;
};

export type XaiSubscriptionAuth = {
  token: string;
  clientVersion: string;
};

const authState = getRuntimeSingleton(Symbol.for("@ljoukov/llm.xaiSubscriptionAuth"), () => ({
  versions: new Map<string, Promise<string>>(),
  refreshes: new Map<string, Promise<void>>(),
}));

function authError(reason: string): Error {
  return new Error(`Grok subscription authentication ${reason}. Run \`grok login\` and retry.`);
}

function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

function authPath(): string {
  return process.env.GROK_AUTH_PATH || path.join(grokHome(), "auth.json");
}

function authScope(): string {
  const issuer = process.env.GROK_OIDC_ISSUER || process.env.GROK_OAUTH2_ISSUER || XAI_ISSUER;
  const clientId =
    process.env.GROK_OIDC_CLIENT_ID || process.env.GROK_OAUTH2_CLIENT_ID || XAI_CLIENT_ID;
  requireXaiIssuer(issuer);
  return `${XAI_ISSUER}::${clientId}`;
}

function requireXaiIssuer(value: unknown): void {
  if (typeof value !== "string" || value.replace(/\/+$/u, "") !== XAI_ISSUER) {
    throw authError("requires an official auth.x.ai account session");
  }
}

function parseCredential(value: unknown): GrokCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw authError("has no saved session");
  }
  const credential = value as Record<string, unknown>;
  if (
    typeof credential.key !== "string" ||
    !credential.key.trim() ||
    !/^[!-~]+$/u.test(credential.key)
  ) {
    throw authError("has an invalid saved session");
  }
  // Plain API keys must never satisfy an explicitly selected subscription route.
  // The official CLI also refuses the deprecated WebLogin / grok credentials.
  if (credential.auth_mode !== "oidc" && credential.auth_mode !== "external") {
    throw authError("requires a current account login rather than an API key or legacy login");
  }
  // Enterprise CLI issuers belong to their configured deployment. Never send
  // those credentials to this library's pinned public xAI subscription endpoint.
  requireXaiIssuer(credential.oidc_issuer);
  for (const field of ["create_time", "expires_at", "oidc_issuer"] as const) {
    if (credential[field] != null && typeof credential[field] !== "string") {
      throw authError("has invalid saved session metadata");
    }
  }
  return credential as GrokCredential;
}

async function readCredential(): Promise<GrokCredential> {
  const scope = authScope();
  const inline = process.env.GROK_AUTH;
  let document: unknown;
  try {
    document = JSON.parse(inline || (await fs.readFile(authPath(), "utf8"))) as unknown;
  } catch {
    // Parse and filesystem errors can contain token material or private file contents.
    throw authError("could not read a valid saved session");
  }
  if (inline) return parseCredential(document);
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw authError("has no saved session");
  }
  const store = document as Record<string, unknown>;
  return parseCredential(store[scope] ?? store[LEGACY_SCOPE]);
}

function tokenExpiresAt(credential: GrokCredential): number {
  const expiresAt = credential.expires_at
    ? Date.parse(credential.expires_at)
    : Date.parse(credential.create_time || "") + TOKEN_TTL_MS;
  if (!Number.isFinite(expiresAt)) {
    throw authError("has no valid session expiration");
  }
  const payload = credential.key.split(".")[1];
  if (!payload) return expiresAt;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) {
      return Math.min(expiresAt, claims.exp * 1_000);
    }
  } catch {
    // Opaque tokens are supported; decoding a JWT here is only an expiry hint.
  }
  return expiresAt;
}

function isUsable(credential: GrokCredential): boolean {
  return tokenExpiresAt(credential) > Date.now() + EXPIRY_BUFFER_MS;
}

function getClientVersion(): Promise<string> {
  const key = `${process.env.PATH || ""}\n${grokHome()}`;
  const cached = authState.versions.get(key);
  if (cached) return cached;
  const promise = new Promise<string>((resolve, reject) => {
    execFile("grok", ["--version"], { timeout: 5_000, maxBuffer: 4_096 }, (error, stdout) => {
      const version = stdout.match(/\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/u)?.[1];
      if (error || !version) {
        reject(authError("requires an installed Grok CLI on PATH"));
      } else {
        resolve(version);
      }
    });
  });
  authState.versions.set(key, promise);
  void promise.catch(() => authState.versions.delete(key));
  return promise;
}

function startCliRefresh(): Promise<void> {
  const env = { ...process.env };
  // Resolve relative overrides before running outside the caller's project.
  env.GROK_HOME = path.resolve(grokHome());
  env.GROK_AUTH_PATH = path.resolve(authPath());
  // Keep the helper on the account route even when API credentials coexist.
  for (const name of [
    "XAI_API_KEY",
    "GROK_CODE_XAI_API_KEY",
    "GROK_API_KEY",
    "GROK_DEPLOYMENT_KEY",
  ]) {
    delete env[name];
  }
  env.GROK_DISABLE_API_KEY_AUTH = "1";
  return new Promise<void>((resolve, reject) => {
    const child = spawn("grok", ["--no-auto-update", "models"], {
      cwd: os.tmpdir(),
      env,
      stdio: "ignore",
      windowsHide: true,
    });
    // A rotating refresh token can be consumed before the new token reaches disk.
    // Never kill this official lock-owning process when our caller times out.
    child.unref();
    child.once("error", () => reject(authError("could not start the Grok CLI refresh helper")));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(authError("could not refresh its saved session"));
    });
  });
}

async function refreshWithCli(): Promise<void> {
  if (process.env.GROK_AUTH) {
    throw authError("cannot refresh inline GROK_AUTH; replace it with a fresh session");
  }
  const key = `${path.resolve(authPath())}\n${authScope()}`;
  let refresh = authState.refreshes.get(key);
  if (!refresh) {
    refresh = startCliRefresh();
    authState.refreshes.set(key, refresh);
    const pending = refresh;
    void pending
      .finally(() => {
        if (authState.refreshes.get(key) === pending) authState.refreshes.delete(key);
      })
      .catch(() => {});
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      refresh,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(authError("refresh is still running; wait for the Grok CLI and retry")),
          HELPER_WAIT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Reuse Grok CLI login; only the official CLI may rotate its refresh tokens. */
export async function getXaiSubscriptionAuth(
  options: { forceRefresh?: boolean } = {},
): Promise<XaiSubscriptionAuth> {
  let credential = await readCredential();
  const clientVersion = await getClientVersion();
  if (options.forceRefresh || !isUsable(credential)) {
    await refreshWithCli();
    // `grok models` may succeed from its catalog cache without refreshing. Its
    // exit status is not proof of freshness; validate the resulting disk token.
    credential = await readCredential();
    if (!isUsable(credential)) throw authError("has an expired saved session");
  }
  return { token: credential.key, clientVersion };
}
