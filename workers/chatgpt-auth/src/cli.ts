#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";

import {
  encodeChatGptAuthJsonB64,
  readChatGptAuthProfileFromFile,
  type ChatGptAuthProfile,
} from "../../../src/openai/chatgpt-auth.js";

type ProviderConfig = {
  baseUrl: string;
  adminKey: string;
};

type JsonObject = Record<string, unknown>;

function resolveProviderConfig(): ProviderConfig {
  const baseUrl = process.env.CHATGPT_AUTH_TOKEN_PROVIDER_URL?.trim();
  const adminKey =
    process.env.CHATGPT_AUTH_ADMIN_API_KEY?.trim() || process.env.CHATGPT_AUTH_API_KEY?.trim();
  const missing = [
    ...(baseUrl ? [] : ["CHATGPT_AUTH_TOKEN_PROVIDER_URL"]),
    ...(adminKey ? [] : ["CHATGPT_AUTH_ADMIN_API_KEY (or CHATGPT_AUTH_API_KEY)"]),
  ];
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(" and ")}.`);
  }
  if (!baseUrl || !adminKey) throw new Error("Token provider configuration is incomplete.");
  return { baseUrl: baseUrl.replace(/\/+$/u, ""), adminKey };
}

async function providerRequest(route: string, init: RequestInit = {}): Promise<JsonObject> {
  const config = resolveProviderConfig();
  const response = await fetch(`${config.baseUrl}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.adminKey}`,
      "x-chatgpt-auth": config.adminKey,
      Accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let payload: JsonObject;
  try {
    payload = text ? (JSON.parse(text) as JsonObject) : {};
  } catch {
    payload = { message: text };
  }
  if (!response.ok) {
    throw new Error(
      `Token provider request failed (${response.status}): ${String(
        payload.message ?? payload.error ?? text,
      )}`,
    );
  }
  return payload;
}

async function uploadProfile(profile: ChatGptAuthProfile, label?: string): Promise<JsonObject> {
  return providerRequest("/v1/seed", {
    method: "POST",
    body: JSON.stringify({
      authJsonB64: encodeChatGptAuthJsonB64(profile),
      ...(label?.trim() ? { label: label.trim() } : {}),
    }),
  });
}

function runCodexLogin(options: {
  codexHome: string;
  codexCommand: string;
  deviceAuth: boolean;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["login", "-c", 'cli_auth_credentials_store="file"'];
    if (options.deviceAuth) args.push("--device-auth");
    const child = spawn(options.codexCommand, args, {
      stdio: "inherit",
      env: { ...process.env, CODEX_HOME: options.codexHome },
    });
    child.once("error", (error) => {
      reject(
        new Error(
          `Could not run ${options.codexCommand}. Install the Codex CLI or use the import command. (${error.message})`,
        ),
      );
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`Codex login exited with ${signal ? `signal ${signal}` : `code ${code}`}.`),
        );
    });
  });
}

async function loginAndUpload(options: {
  label?: string;
  deviceAuth?: boolean;
  codex?: string;
}): Promise<void> {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "llm-chatgpt-login-"));
  fs.chmodSync(temporaryHome, 0o700);
  try {
    await runCodexLogin({
      codexHome: temporaryHome,
      codexCommand: options.codex ?? "codex",
      deviceAuth: options.deviceAuth ?? false,
    });
    const profile = readChatGptAuthProfileFromFile(path.join(temporaryHome, "auth.json"));
    const result = await uploadProfile(profile, options.label);
    console.log(
      `Added ${String(result.label ?? result.email ?? result.accountId)} (${String(result.accountId)}).`,
    );
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
}

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return path.resolve(filePath);
}

function defaultCodexAuthPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "auth.json");
}

function formatTimestamp(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "-";
  return new Date(value).toISOString();
}

function printAccounts(payload: JsonObject): void {
  const accounts = Array.isArray(payload.accounts) ? (payload.accounts as JsonObject[]) : [];
  console.table(
    accounts.map((account) => ({
      label: account.label ?? "",
      email: account.email ?? "",
      accountId: account.accountId,
      enabled: account.enabled,
      expiresAt: formatTimestamp(account.expiresAt),
      lastSelectedAt: formatTimestamp(account.lastSelectedAt),
      selections: account.selectionCount,
    })),
  );
}

function printClients(payload: JsonObject): void {
  const clients = Array.isArray(payload.clients) ? (payload.clients as JsonObject[]) : [];
  console.table(
    clients.map((client) => ({
      name: client.name,
      id: client.id,
      prefix: client.tokenPrefix,
      enabled: client.enabled,
      requests: client.requestCount,
      lastUsedAt: formatTimestamp(client.lastUsedAt),
      createdAt: formatTimestamp(client.createdAt),
    })),
  );
}

function printEvents(payload: JsonObject): void {
  const events = Array.isArray(payload.events) ? (payload.events as JsonObject[]) : [];
  console.table(
    events.map((event) => ({
      time: formatTimestamp(event.occurredAt),
      caller: event.clientName,
      clientId: event.clientId,
      accountId: event.accountId ?? "",
      outcome: event.outcome,
      requestId: event.requestId ?? "",
    })),
  );
}

function printOneTimeClientToken(payload: JsonObject): void {
  const client = (payload.client ?? {}) as JsonObject;
  console.log(`Client: ${String(client.name ?? "")} (${String(client.id ?? payload.id ?? "")})`);
  console.log(`Token: ${String(payload.token)}`);
  console.log("Store this value now; the Worker keeps only its SHA-256 hash.");
}

const program = new Command()
  .name("chatgpt-auth")
  .description("Manage the Cloudflare ChatGPT subscription-token pool.");

program
  .command("login")
  .description("Log in through Codex in an isolated temporary store and add the account.")
  .option("--label <label>", "Human-readable account label")
  .option("--device-auth", "Use Codex device-code authentication")
  .option("--codex <command>", "Codex CLI executable", "codex")
  .action(loginAndUpload);

program
  .command("import")
  .description("Import a Codex auth.json without changing it.")
  .option("--file <path>", "Codex auth file")
  .option("--label <label>", "Human-readable account label")
  .action(async (options: { file?: string; label?: string }) => {
    const authPath = options.file ? expandHome(options.file) : defaultCodexAuthPath();
    const profile = readChatGptAuthProfileFromFile(authPath);
    const result = await uploadProfile(profile, options.label);
    console.log(
      `Added ${String(result.label ?? result.email ?? result.accountId)} (${String(result.accountId)}).`,
    );
  });

const account = program.command("account").description("Manage subscription accounts.");

account.command("list").action(async () => printAccounts(await providerRequest("/v1/accounts")));

account.command("label <account-id> <label>").action(async (accountId: string, label: string) => {
  await providerRequest(`/v1/accounts/${encodeURIComponent(accountId)}`, {
    method: "PATCH",
    body: JSON.stringify({ label }),
  });
  console.log(`Updated ${accountId}.`);
});

for (const enabled of [true, false]) {
  account
    .command(`${enabled ? "enable" : "disable"} <account-id>`)
    .action(async (accountId: string) => {
      await providerRequest(`/v1/accounts/${encodeURIComponent(accountId)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      console.log(`${enabled ? "Enabled" : "Disabled"} ${accountId}.`);
    });
}

account.command("remove <account-id>").action(async (accountId: string) => {
  await providerRequest(`/v1/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
  console.log(`Removed ${accountId}.`);
});

account.command("refresh [account-id]").action(async (accountId?: string) => {
  const result = await providerRequest("/v1/refresh", {
    method: "POST",
    body: JSON.stringify(accountId ? { accountId } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
});

const client = program.command("client").description("Manage named token-provider callers.");

client.command("list").action(async () => printClients(await providerRequest("/v1/clients")));

client.command("create <name>").action(async (name: string) => {
  const result = await providerRequest("/v1/clients", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  printOneTimeClientToken(result);
});

client.command("rename <client-id> <name>").action(async (clientId: string, name: string) => {
  await providerRequest(`/v1/clients/${encodeURIComponent(clientId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  console.log(`Renamed ${clientId}.`);
});

client.command("enable <client-id>").action(async (clientId: string) => {
  await providerRequest(`/v1/clients/${encodeURIComponent(clientId)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: true }),
  });
  console.log(`Enabled ${clientId}.`);
});

client.command("revoke <client-id>").action(async (clientId: string) => {
  await providerRequest(`/v1/clients/${encodeURIComponent(clientId)}`, { method: "DELETE" });
  console.log(`Revoked ${clientId}.`);
});

client.command("rotate <client-id>").action(async (clientId: string) => {
  const result = await providerRequest(`/v1/clients/${encodeURIComponent(clientId)}/rotate`, {
    method: "POST",
  });
  printOneTimeClientToken(result);
});

program
  .command("events")
  .description("Show recent caller-to-subscription-account token issuances.")
  .option("--limit <number>", "Number of events", "100")
  .option("--client <client-id>", "Filter by caller id")
  .action(async (options: { limit: string; client?: string }) => {
    const query = new URLSearchParams({ limit: options.limit });
    if (options.client) query.set("clientId", options.client);
    printEvents(await providerRequest(`/v1/events?${query}`));
  });

program.parseAsync().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
