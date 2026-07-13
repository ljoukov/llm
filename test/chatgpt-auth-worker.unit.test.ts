import { describe, expect, it } from "vitest";

import worker from "../workers/chatgpt-auth/src/index.js";

type Row = Record<string, unknown>;

class MemoryStatement {
  readonly #database: MemoryD1;
  readonly #query: string;
  #values: unknown[] = [];

  constructor(database: MemoryD1, query: string) {
    this.#database = database;
    this.#query = query.replace(/\s+/gu, " ").trim().toLowerCase();
  }

  bind(...values: unknown[]): this {
    this.#values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.#query.startsWith("select id, name from chatgpt_auth_clients where token_hash")) {
      const row = [...this.#database.clients.values()].find(
        (client) => client.token_hash === this.#values[0] && client.enabled === 1,
      );
      return (row ? { id: row.id, name: row.name } : null) as T | null;
    }
    if (
      this.#query.startsWith("select id, access_token") &&
      this.#query.includes("where id = ?1")
    ) {
      return (this.#database.accounts.get(String(this.#values[0])) ?? null) as T | null;
    }
    if (this.#query.startsWith("update chatgpt_auth_state set last_selected_at")) {
      const [selectedAt, ...excluded] = this.#values;
      const candidates = [...this.#database.accounts.values()]
        .filter((row) => row.enabled === 1 && !excluded.includes(row.id))
        .sort(
          (left, right) =>
            Number(left.last_selected_at) - Number(right.last_selected_at) ||
            Number(left.selection_count) - Number(right.selection_count) ||
            String(left.id).localeCompare(String(right.id)),
        );
      const selected = candidates[0];
      if (!selected) return null;
      selected.last_selected_at = selectedAt;
      selected.selection_count = Number(selected.selection_count) + 1;
      return { ...selected } as T;
    }
    if (
      this.#query.startsWith("select id, name, token_prefix") &&
      this.#query.includes("where id")
    ) {
      return (this.#database.clients.get(String(this.#values[0])) ?? null) as T | null;
    }
    throw new Error(`Unhandled first query: ${this.#query}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.#query.startsWith("select id, access_token")) {
      const enabledOnly = this.#query.includes("where enabled = 1");
      return {
        results: [...this.#database.accounts.values()]
          .filter((row) => !enabledOnly || row.enabled === 1)
          .sort((left, right) =>
            String(left.account_id).localeCompare(String(right.account_id)),
          ) as T[],
      };
    }
    if (this.#query.startsWith("select id, name, token_prefix")) {
      return { results: [...this.#database.clients.values()] as T[] };
    }
    if (this.#query.startsWith("select e.id, e.occurred_at")) {
      const filteredClient = this.#query.includes("where e.client_id = ?")
        ? String(this.#values[0])
        : null;
      const limit = Number(this.#values.at(-1));
      const rows = this.#database.events
        .filter((event) => !filteredClient || event.client_id === filteredClient)
        .sort(
          (left, right) =>
            Number(right.occurred_at) - Number(left.occurred_at) ||
            Number(right.id) - Number(left.id),
        )
        .slice(0, limit)
        .map((event) => ({
          ...event,
          client_name:
            event.client_id === "admin"
              ? "Admin"
              : (this.#database.clients.get(String(event.client_id))?.name ?? event.client_id),
        }));
      return { results: rows as T[] };
    }
    throw new Error(`Unhandled all query: ${this.#query}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.#query.startsWith("insert into chatgpt_auth_state")) {
      const [
        id,
        accessToken,
        refreshToken,
        idToken,
        expiresAt,
        accountId,
        email,
        label,
        updatedAt,
      ] = this.#values;
      const existing = this.#database.accounts.get(String(id));
      this.#database.accounts.set(String(id), {
        id,
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: idToken,
        expires_at: expiresAt,
        account_id: accountId,
        email: email ?? existing?.email ?? null,
        label: label ?? existing?.label ?? null,
        enabled: 1,
        updated_at: updatedAt,
        lock_until: null,
        last_selected_at: existing?.last_selected_at ?? 0,
        selection_count: existing?.selection_count ?? 0,
      });
      return { meta: { changes: 1 } };
    }
    if (this.#query.startsWith("insert into chatgpt_auth_clients")) {
      const [id, name, tokenHash, tokenPrefix, now] = this.#values;
      this.#database.clients.set(String(id), {
        id,
        name,
        token_hash: tokenHash,
        token_prefix: tokenPrefix,
        enabled: 1,
        created_at: now,
        updated_at: now,
        last_used_at: null,
        request_count: 0,
      });
      return { meta: { changes: 1 } };
    }
    if (this.#query.startsWith("insert into chatgpt_auth_token_events")) {
      const [occurredAt, clientId, accountId, outcome, requestId] = this.#values;
      this.#database.events.push({
        id: this.#database.events.length + 1,
        occurred_at: occurredAt,
        client_id: clientId,
        account_id: accountId,
        outcome,
        request_id: requestId,
      });
      return { meta: { changes: 1 } };
    }
    if (this.#query.includes("set last_used_at = ?1, request_count = request_count + 1")) {
      const [now, id] = this.#values;
      const client = this.#database.clients.get(String(id));
      if (!client) return { meta: { changes: 0 } };
      client.last_used_at = now;
      client.updated_at = now;
      client.request_count = Number(client.request_count) + 1;
      return { meta: { changes: 1 } };
    }
    if (this.#query.startsWith("update chatgpt_auth_state set label = ?1")) {
      const [label, enabled, updatedAt, id] = this.#values;
      const account = this.#database.accounts.get(String(id));
      if (!account) return { meta: { changes: 0 } };
      account.label = label;
      account.enabled = enabled;
      account.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    if (this.#query.startsWith("delete from chatgpt_auth_state")) {
      return { meta: { changes: this.#database.accounts.delete(String(this.#values[0])) ? 1 : 0 } };
    }
    if (this.#query.startsWith("update chatgpt_auth_clients set enabled = 0")) {
      const [updatedAt, id] = this.#values;
      const client = this.#database.clients.get(String(id));
      if (!client) return { meta: { changes: 0 } };
      client.enabled = 0;
      client.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled run query: ${this.#query}`);
  }
}

class MemoryD1 {
  readonly accounts = new Map<string, Row>();
  readonly clients = new Map<string, Row>();
  readonly events: Row[] = [];

  prepare(query: string): MemoryStatement {
    return new MemoryStatement(this, query);
  }
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function adminRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://auth.example${path}`, {
    ...init,
    headers: { authorization: "Bearer admin-secret", ...(init?.headers ?? {}) },
  });
}

async function readJson(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

type JsonObject = Record<string, any>;

describe("chatgpt-auth worker", () => {
  it("rotates subscription accounts and audits named callers", async () => {
    const database = new MemoryD1();
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: database } as never;
    const expiresAt = Date.now() + 4 * 60 * 60 * 1000;

    for (const suffix of ["b", "a"]) {
      const accountId = `acct_${suffix}`;
      const idToken = makeJwt({ email: `${suffix}@example.com`, chatgpt_account_id: accountId });
      const response = await worker.fetch(
        adminRequest("/v1/seed", {
          method: "POST",
          body: JSON.stringify({
            accessToken: `access_${suffix}`,
            refreshToken: `refresh_${suffix}`,
            idToken,
            expiresAt,
            accountId,
            label: `Account ${suffix.toUpperCase()}`,
          }),
        }),
        env,
      );
      expect(response.status).toBe(200);
    }

    const createResponse = await worker.fetch(
      adminRequest("/v1/clients", {
        method: "POST",
        body: JSON.stringify({ name: "Vercel production" }),
      }),
      env,
    );
    expect(createResponse.status).toBe(201);
    const created = await readJson(createResponse);
    const clientToken = String(created.token);
    const clientId = String(created.client.id);

    const selectedAccounts: string[] = [];
    for (let index = 0; index < 4; index++) {
      const response = await worker.fetch(
        new Request("https://auth.example/v1/token", {
          headers: { authorization: `Bearer ${clientToken}`, "x-request-id": `request-${index}` },
        }),
        env,
      );
      expect(response.status).toBe(200);
      const payload = await readJson(response);
      selectedAccounts.push(String(payload.accountId));
      expect(payload.caller).toEqual({ id: clientId, name: "Vercel production" });
    }
    expect(selectedAccounts).toEqual(["acct_a", "acct_b", "acct_a", "acct_b"]);

    const clients = await readJson(await worker.fetch(adminRequest("/v1/clients"), env));
    expect(clients.clients[0]).toMatchObject({
      id: clientId,
      name: "Vercel production",
      requestCount: 4,
      enabled: true,
    });

    const events = await readJson(
      await worker.fetch(adminRequest(`/v1/events?clientId=${encodeURIComponent(clientId)}`), env),
    );
    expect(events.events).toHaveLength(4);
    expect(events.events[0]).toMatchObject({
      clientId,
      clientName: "Vercel production",
      accountId: "acct_b",
      outcome: "issued",
    });

    const forbidden = await worker.fetch(
      new Request("https://auth.example/v1/accounts", {
        headers: { authorization: `Bearer ${clientToken}` },
      }),
      env,
    );
    expect(forbidden.status).toBe(403);
  });

  it("skips disabled subscription accounts", async () => {
    const database = new MemoryD1();
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: database } as never;
    const expiresAt = Date.now() + 4 * 60 * 60 * 1000;
    for (const accountId of ["acct_a", "acct_b"]) {
      database.accounts.set(accountId, {
        id: accountId,
        access_token: `access_${accountId}`,
        refresh_token: `refresh_${accountId}`,
        id_token: null,
        expires_at: expiresAt,
        account_id: accountId,
        email: null,
        label: null,
        enabled: 1,
        updated_at: Date.now(),
        lock_until: null,
        last_selected_at: 0,
        selection_count: 0,
      });
    }

    const disable = await worker.fetch(
      adminRequest("/v1/accounts/acct_b", {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
      env,
    );
    expect(disable.status).toBe(200);

    for (let index = 0; index < 3; index++) {
      const payload = await readJson(await worker.fetch(adminRequest("/v1/token"), env));
      expect(payload.accountId).toBe("acct_a");
    }
  });
});
