export type Subscription = { provider: "openai" | "xai"; accountId: string; email: string | null; label: string | null; name: string | null; plan: string | null; enabled: boolean; expiresAt: number; updatedAt: number; lastSelectedAt: number | null; selectionCount: number };
export type ApiKey = { id: string; name: string; tokenPrefix: string; enabled: boolean; accountIds: string[] | null; requestCount: number; lastUsedAt: number | null };
export type KeyTestResult = { ok: boolean; code: string; message: string; checkedAt: number; durationMs: number; client?: { id: string; name: string }; subscription?: { provider: "openai" | "xai"; accountId: string; email: string | null; label: string | null; plan: string | null }; expiresAt?: number };
export type AuditEvent = { id: number; occurredAt: number; clientId: string; clientName: string; accountId: string | null; outcome: string };
export type UsageRow = { id: string; name: string; issued: number; failures: number };
export type Stats = { totals: { issued: number; failures: number }; daily: { day: string; issued: number; failures: number }[]; byKey: UsageRow[]; bySubscription: UsageRow[] };
export type UsageWindow = { usedPercent: number | null; resetAt: number | null; windowSeconds: number | null };
export type Quota = { accountId: string; plan: string | null; checkedAt: number; primary: UsageWindow | null; secondary: UsageWindow | null };
export type LoginAttempt = { provider?: "openai" | "xai"; id: string; userCode: string; verificationUrl: string; intervalMs: number; expiresAt: number };
export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.message || body.error || `Request failed (${response.status})`, response.status);
  return body as T;
}
export const count = (value: number | null | undefined) => Number(value || 0).toLocaleString();
export const date = (value: number | null | undefined) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never';
export const accountName = (account: Subscription) => account.label || account.email || account.name || (account.provider === 'xai' ? 'Grok subscription' : 'ChatGPT subscription');

export const accountLabel = (account: Subscription | undefined) => account ? `${account.provider === "xai" ? "Grok" : "ChatGPT"} · ${accountName(account)}` : "Removed account";
