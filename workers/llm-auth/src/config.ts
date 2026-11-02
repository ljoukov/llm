#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../../../src/utils/env.js";

loadLocalEnv();
const root = fileURLToPath(new URL("..", import.meta.url));
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in your environment or ignored .env.local.`);
  return value;
};
const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.json"), "utf8"));
config.name = required("LLM_AUTH_WORKER_NAME");
if (process.env.LLM_AUTH_HOSTNAME?.trim())
  config.routes = [{ pattern: process.env.LLM_AUTH_HOSTNAME.trim(), custom_domain: true }];
if (process.env.LLM_AUTH_GROK_CLIENT_VERSION?.trim())
  config.vars.LLM_AUTH_GROK_CLIENT_VERSION = process.env.LLM_AUTH_GROK_CLIENT_VERSION.trim();
config.main = path.join(root, "src/index.ts");
config.assets.directory = path.resolve(root, "../../web/admin/build");
config.d1_databases[0].database_name = required("LLM_AUTH_DATABASE_NAME");
config.d1_databases[0].database_id = required("LLM_AUTH_DATABASE_ID");
config.d1_databases[0].migrations_dir = path.join(root, "migrations");
const folder = path.join(root, ".runtime");
fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
const destination = path.join(folder, "wrangler.json");
fs.writeFileSync(destination, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(destination);
