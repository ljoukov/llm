import { toast } from 'svelte-sonner';
import { api, ApiError, type ApiKey, type AuditEvent, type KeyTestResult, type LoginAttempt, type Quota, type Stats, type Subscription } from './api.js';

export class Admin {
  ready = $state(false); authenticated = $state(false); email = $state<string | null>(null);
  config = $state({ googleEnabled: false, keyLoginEnabled: false }); loginError = $state(''); loginKey = $state('');
  busy = $state(false); loading = $state(false); view = $state('overview'); days = $state(7); activityKey = $state('');
  accounts = $state<Subscription[]>([]); keys = $state<ApiKey[]>([]); events = $state<AuditEvent[]>([]);
  stats = $state<Stats>({ totals: { issued: 0, failures: 0 }, daily: [], byKey: [], bySubscription: [] });
  quotas = $state<Record<string, Quota | { error: string }>>({});
  addOpen = $state(false); label = $state(''); file = $state<File | null>(null); attempt = $state<LoginAttempt | null>(null);
  keyOpen = $state(false); editing = $state<ApiKey | null>(null); keyName = $state(''); keyEnabled = $state(true);
  all = $state(true); selected = $state<Record<string, boolean>>({}); secretOpen = $state(false); secret = $state('');
  secretKeyId = $state(''); keyTestOpen = $state(false); keyTestTarget = $state<ApiKey | null>(null);
  testKeyValue = $state(''); testingKey = $state(false); keyTestResult = $state<KeyTestResult | null>(null);
  renameOpen = $state(false); renaming = $state<Subscription | null>(null); renamedLabel = $state('');
  confirmOpen = $state(false); confirmTitle = $state(''); confirmText = $state(''); confirmLabel = $state('Continue');
  confirmation: (() => Promise<void>) | null = null;
  timer?: ReturnType<typeof setTimeout>;
  private keyTestSequence = 0;

  report(error: unknown) { if (error instanceof ApiError && error.status === 401) this.authenticated = false; toast.error(error instanceof Error ? error.message : 'Request failed.'); }
  async perform(action: () => Promise<void>) { this.busy = true; try { await action(); } catch (error) { this.report(error); } finally { this.busy = false; } }
  async load() {
    this.loading = true;
    try {
      const [accounts, keys, stats, events] = await Promise.all([api<{ accounts: Subscription[] }>('/v1/health'), api<{ clients: ApiKey[] }>('/v1/clients'), api<Stats>(`/v1/stats?days=${this.days}`), api<{ events: AuditEvent[] }>(`/v1/events?limit=100${this.activityKey ? `&clientId=${encodeURIComponent(this.activityKey)}` : ''}`)]);
      this.accounts = accounts.accounts; this.keys = keys.clients; this.stats = stats; this.events = events.events;
    } finally { this.loading = false; }
  }
  async init() {
    const url = new URL(location.href);
    const errors: Record<string, string> = { not_allowed: 'This Google account does not have admin access.', expired: 'Sign-in expired. Please try again.', invalid_state: 'Sign-in could not be validated. Please try again.', verification_failed: 'Google sign-in could not be verified.', cancelled: 'Google sign-in was cancelled.' };
    this.loginError = errors[url.searchParams.get('auth_error') || ''] || '';
    try {
      this.config = await api('/admin/config');
      const ticket = new URLSearchParams(url.hash.slice(1)).get('login');
      if (ticket) { history.replaceState(null, '', '/'); await api('/admin/session', { method: 'POST', body: JSON.stringify({ ticket }) }); }
      const session = await api<{ email: string | null }>('/v1/session');
      this.authenticated = true; this.email = session.email; await this.load();
    } catch (error) { if (!(error instanceof ApiError && error.status === 401)) this.loginError = error instanceof Error ? error.message : 'Could not load the application.'; }
    finally { this.ready = true; }
  }
  async keyLogin() { await this.perform(async () => { const key = this.loginKey; this.loginKey = ''; await api('/admin/session', { method: 'POST', body: JSON.stringify({ key }) }); this.authenticated = true; await this.load(); }); }
  async logout() { await this.perform(async () => { await api('/admin/session', { method: 'DELETE' }); this.authenticated = false; this.email = null; this.accounts = []; this.keys = []; this.quotas = {}; }); }
  openAdd() { this.label = ''; this.file = null; this.attempt = null; this.addOpen = true; }
  cancelAttempt() { clearTimeout(this.timer); if (this.attempt) { const id = this.attempt.id; this.attempt = null; void api(`/v1/login/${id}`, { method: 'DELETE' }).catch(() => {}); } }
  async connect() { await this.perform(async () => { this.attempt = await api('/v1/login/start', { method: 'POST', body: JSON.stringify({ label: this.label || undefined }) }); const current = this.attempt!; this.timer = setTimeout(() => this.poll(current), current.intervalMs); }); }
  async poll(current: LoginAttempt) {
    if (this.attempt?.id !== current.id) return;
    try {
      const result = await api<{ status: string; intervalMs?: number }>(`/v1/login/${current.id}/poll`, { method: 'POST' });
      if (this.attempt?.id !== current.id) return;
      if (result.status === 'completed') { this.attempt = null; this.addOpen = false; this.view = 'subscriptions'; await this.load(); toast.success('Subscription connected.'); }
      else if (result.status === 'pending') this.timer = setTimeout(() => this.poll(current), Math.max(5000, result.intervalMs || current.intervalMs));
      else { this.attempt = null; toast.error('Sign-in expired. Start a new connection.'); }
    } catch (error) { this.attempt = null; this.report(error); }
  }
  async importAccount() { await this.perform(async () => { if (!this.file || this.file.size > 262144) throw new Error('Choose a Codex auth.json file smaller than 256 KB.'); const data = JSON.parse(await this.file.text()); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a Codex auth.json object.'); await api('/v1/seed', { method: 'POST', body: JSON.stringify({ ...data, label: this.label || undefined }) }); this.addOpen = false; this.view = 'subscriptions'; await this.load(); toast.success('Subscription imported.'); }); }
  newKey(key: ApiKey | null = null) { this.editing = key; this.keyName = key?.name || ''; this.keyEnabled = key?.enabled ?? true; this.all = !key || key.accountIds === null; this.selected = Object.fromEntries(this.accounts.map((account) => [account.accountId, key?.accountIds?.includes(account.accountId) ?? false])); this.keyOpen = true; }
  async saveKey() { await this.perform(async () => { const body = { name: this.keyName, enabled: this.keyEnabled, accountIds: this.all ? null : Object.entries(this.selected).filter(([, value]) => value).map(([id]) => id) }; const result = await api<{ token?: string; client?: ApiKey }>(this.editing ? `/v1/clients/${encodeURIComponent(this.editing.id)}` : '/v1/clients', { method: this.editing ? 'PATCH' : 'POST', body: JSON.stringify(body) }); this.keyOpen = false; await this.load(); if (result.token) { this.secret = result.token; this.secretKeyId = result.client!.id; this.keyTestResult = null; this.secretOpen = true; } else toast.success('Key updated.'); }); }
  openKeyTest(key: ApiKey | null = null) { this.keyTestTarget = key; this.testKeyValue = ''; this.keyTestResult = null; this.keyTestOpen = true; }
  clearKeyTest() { this.keyTestSequence++; this.testKeyValue = ''; this.keyTestResult = null; this.testingKey = false; }
  async testKey(token = this.testKeyValue, clientId = this.keyTestTarget?.id) {
    if (this.testingKey) return;
    const sequence = ++this.keyTestSequence;
    this.testingKey = true; this.keyTestResult = null; this.testKeyValue = '';
    try {
      const result = await api<KeyTestResult>('/v1/clients/test', { method: 'POST', body: JSON.stringify({ token, ...(clientId ? { clientId } : {}) }) });
      if (sequence !== this.keyTestSequence) return;
      this.keyTestResult = result;
      await this.load();
    } catch (error) {
      if (sequence !== this.keyTestSequence) return;
      if (error instanceof ApiError && error.status === 401) this.authenticated = false;
      this.keyTestResult = { ok: false, code: 'check_failed', message: error instanceof Error ? error.message : 'The key check could not be completed.', checkedAt: Date.now(), durationMs: 0 };
    } finally { if (sequence === this.keyTestSequence) this.testingKey = false; }
  }
  confirm(title: string, description: string, label: string, action: () => Promise<void>) { this.keyOpen = false; this.confirmTitle = title; this.confirmText = description; this.confirmLabel = label; this.confirmation = action; this.confirmOpen = true; }
  async checkQuota(account: Subscription) { await this.perform(async () => { try { this.quotas[account.accountId] = await api<Quota>(`/v1/accounts/${encodeURIComponent(account.accountId)}/usage`, { method: 'POST' }); } catch (error) { this.quotas[account.accountId] = { error: error instanceof Error ? error.message : 'Limits unavailable.' }; } }); }
  async toggleAccount(account: Subscription) { await this.perform(async () => { await api(`/v1/accounts/${encodeURIComponent(account.accountId)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !account.enabled }) }); await this.load(); }); }
  async refreshAccount(account: Subscription) { await this.perform(async () => { await api('/v1/refresh', { method: 'POST', body: JSON.stringify({ accountId: account.accountId }) }); await this.load(); toast.success('Token refreshed.'); }); }
  rename(account: Subscription) { this.renaming = account; this.renamedLabel = account.label || ''; this.renameOpen = true; }
  async saveLabel() { await this.perform(async () => { if (!this.renaming) return; await api(`/v1/accounts/${encodeURIComponent(this.renaming.accountId)}`, { method: 'PATCH', body: JSON.stringify({ label: this.renamedLabel }) }); this.renameOpen = false; await this.load(); }); }
  removeAccount(account: Subscription) { this.confirm('Remove subscription?', 'This removes the stored login. Keys restricted to this account lose access. You can connect it again later.', 'Remove subscription', async () => { await api(`/v1/accounts/${encodeURIComponent(account.accountId)}`, { method: 'DELETE' }); await this.load(); toast.success('Subscription removed.'); }); }
  rotateKey(key: ApiKey) { this.confirm('Rotate API key?', 'The current key will stop working. Save its replacement and update your application.', 'Rotate key', async () => { const result = await api<{ token: string }>(`/v1/clients/${encodeURIComponent(key.id)}/rotate`, { method: 'POST' }); await this.load(); this.secret = result.token; this.secretKeyId = key.id; this.keyTestResult = null; this.secretOpen = true; }); }
  removeKey(key: ApiKey) { this.confirm('Delete API key?', 'New grants stop immediately. Tokens already issued remain valid until expiry. Activity history is retained.', 'Delete key', async () => { await api(`/v1/clients/${encodeURIComponent(key.id)}`, { method: 'DELETE' }); await this.load(); toast.success('API key deleted.'); }); }
  async copy(value: string) { try { await navigator.clipboard.writeText(value); toast.success('Copied.'); } catch (error) { this.report(error); } }
}
