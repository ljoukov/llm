<script lang="ts">
  import type { Admin } from './admin.svelte.js';
  import KeyTestResult from './KeyTestResult.svelte';
  import { accountName, date } from './api.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import { Input } from '#lib/components/ui/input/index.js';
  import { Label } from '#lib/components/ui/label/index.js';
  import { Checkbox } from '#lib/components/ui/checkbox/index.js';
  import { Switch } from '#lib/components/ui/switch/index.js';
  import { Separator } from '#lib/components/ui/separator/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
  import * as Card from '#lib/components/ui/card/index.js';
  let { a }: { a: Admin } = $props();
  $effect(() => { if (!a.secretOpen) a.secret = ''; });
  $effect(() => { if (!a.keyTestOpen && !a.secretOpen) a.clearKeyTest(); });
  $effect(() => { if (!a.addOpen && a.attempt) a.cancelAttempt(); });
</script>
<Dialog.Root bind:open={a.addOpen}><Dialog.Content class="max-h-[90svh] overflow-y-auto sm:max-w-lg"><Dialog.Header><Dialog.Title>Add a subscription</Dialog.Title><Dialog.Description>Approve a ChatGPT login, or import an existing Codex auth.json.</Dialog.Description></Dialog.Header><div class="space-y-5"><div class="space-y-2"><Label for="subscription-label">Label</Label><Input id="subscription-label" bind:value={a.label} maxlength={100} placeholder="e.g. Personal Pro" /></div>
{#if a.attempt}<Card.Root><Card.Header><Card.Title class="text-base">Approve in ChatGPT</Card.Title><Card.Description>Open the sign-in page, choose your account, and enter this code.</Card.Description></Card.Header><Card.Content class="space-y-4"><p class="break-all font-mono text-2xl tracking-widest" aria-label="Sign-in code">{a.attempt.userCode}</p><div class="flex flex-wrap gap-2"><Button href={a.attempt.verificationUrl} target="_blank" rel="noopener noreferrer">Open ChatGPT</Button><Button variant="outline" onclick={() => a.copy(a.attempt!.userCode)}>Copy code</Button></div><p class="text-xs text-muted-foreground">Waiting for approval · expires {date(a.attempt.expiresAt)}</p><p class="text-xs text-muted-foreground">Device code login must be enabled in the account’s ChatGPT security settings.</p></Card.Content></Card.Root>{:else}<Button class="w-full" onclick={() => a.connect()} disabled={a.busy}>Continue with ChatGPT</Button>{/if}
<Separator /><div class="space-y-2"><Label for="auth-file">Or import Codex auth.json</Label><Input id="auth-file" type="file" accept=".json,application/json" onchange={(event) => { a.file = event.currentTarget.files?.[0] || null; }} /><p class="text-xs text-muted-foreground">Your login is uploaded over HTTPS and stored on the server.</p></div><Button variant="outline" class="w-full" onclick={() => a.importAccount()} disabled={a.busy || !a.file}>Import subscription</Button></div></Dialog.Content></Dialog.Root>
<Dialog.Root bind:open={a.keyOpen}><Dialog.Content class="max-h-[90svh] overflow-y-auto sm:max-w-lg"><Dialog.Header><Dialog.Title>{a.editing ? 'Manage API key' : 'Create API key'}</Dialog.Title><Dialog.Description>Choose which subscriptions this application may use.</Dialog.Description></Dialog.Header><form class="space-y-5" onsubmit={(event) => { event.preventDefault(); void a.saveKey(); }}><div class="space-y-2"><Label for="key-name">Key name</Label><Input id="key-name" bind:value={a.keyName} required maxlength={100} placeholder="e.g. Production app" /></div><div class="flex items-center justify-between gap-4 rounded-lg border p-4"><Label for="scope-all" class="leading-relaxed">All enabled subscriptions<span class="block text-xs font-normal text-muted-foreground">Includes future additions</span></Label><Switch id="scope-all" bind:checked={a.all} /></div><div class="space-y-3 rounded-lg border p-4">
{#each a.accounts as account}<div class="flex items-start gap-3"><Checkbox id={'scope-' + account.accountId} bind:checked={a.selected[account.accountId]} disabled={a.all} /><Label for={'scope-' + account.accountId} class="min-w-0 break-all leading-snug">{accountName(account)}{#if account.email && account.label}<span class="mt-1 block text-xs font-normal text-muted-foreground">{account.email}</span>{/if}{#if !account.enabled}<span class="block text-xs font-normal text-muted-foreground">Currently disabled</span>{/if}</Label></div>{:else}<p class="text-sm text-muted-foreground">No subscriptions connected yet.</p>{/each}<p class="text-xs text-muted-foreground">An empty selection grants no subscription access.</p></div>
{#if a.editing}<div class="flex items-center justify-between gap-4"><Label for="key-enabled">Key enabled</Label><Switch id="key-enabled" bind:checked={a.keyEnabled} /></div>{/if}<Dialog.Footer><Button type="button" variant="outline" onclick={() => { a.keyOpen = false; }}>Cancel</Button><Button type="submit" disabled={a.busy}>{a.editing ? 'Save changes' : 'Create key'}</Button></Dialog.Footer></form>{#if a.editing}{@const key = a.editing}<Separator /><div class="flex flex-wrap justify-between gap-2"><Button variant="outline" size="sm" onclick={() => a.rotateKey(key)}>Rotate key</Button><Button variant="destructive" size="sm" onclick={() => a.removeKey(key)}>Delete key</Button></div>{/if}</Dialog.Content></Dialog.Root>
<Dialog.Root bind:open={a.secretOpen}><Dialog.Content><Dialog.Header><Dialog.Title>Save your API key</Dialog.Title><Dialog.Description>This key is shown once. Save it before closing this dialog.</Dialog.Description></Dialog.Header><p id="one-time-secret" class="break-all rounded-lg border bg-muted p-4 font-mono text-sm">{a.secret}</p><p class="text-sm text-muted-foreground">Use it as <code class="font-mono text-xs">CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY</code> with this application’s URL.</p><KeyTestResult result={a.keyTestResult} /><Dialog.Footer class="flex-wrap"><Button variant="outline" onclick={() => a.testKey(a.secret, a.secretKeyId)} disabled={a.testingKey}>{a.testingKey ? 'Testing…' : 'Test key'}</Button><Button variant="outline" onclick={() => a.copy(a.secret)}>Copy key</Button><Button onclick={() => { a.secretOpen = false; }}>I’ve saved it</Button></Dialog.Footer></Dialog.Content></Dialog.Root>
<Dialog.Root bind:open={a.keyTestOpen}>
  <Dialog.Content class="max-h-[90svh] overflow-y-auto sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Test API key</Dialog.Title>
      <Dialog.Description>{a.keyTestTarget ? `Check access for ${a.keyTestTarget.name}.` : 'Check an application’s access to its selected subscriptions.'} Paste the full API key to test it.</Dialog.Description>
    </Dialog.Header>
    <form class="space-y-4" onsubmit={(event) => { event.preventDefault(); void a.testKey(); }}>
      <div class="space-y-2">
        <Label for="test-api-key">API key</Label>
        <Input id="test-api-key" type="password" autocomplete="off" spellcheck={false} maxlength={4096} bind:value={a.testKeyValue} placeholder="cgptc_…" required disabled={a.testingKey} />
      </div>
      <Button type="submit" disabled={a.testingKey || !a.testKeyValue.trim()}>{a.testingKey ? 'Testing…' : 'Test key'}</Button>
    </form>
    <KeyTestResult result={a.keyTestResult} />
    <p class="text-xs text-muted-foreground">Checks key authentication and subscription token issuance. Successful checks appear in grant statistics. The pasted key is cleared after testing.</p>
    <Dialog.Footer><Button variant="outline" onclick={() => { a.keyTestOpen = false; }}>Done</Button></Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
<AlertDialog.Root bind:open={a.confirmOpen}><AlertDialog.Content><AlertDialog.Header><AlertDialog.Title>{a.confirmTitle}</AlertDialog.Title><AlertDialog.Description>{a.confirmText}</AlertDialog.Description></AlertDialog.Header><AlertDialog.Footer><AlertDialog.Cancel>Cancel</AlertDialog.Cancel><AlertDialog.Action onclick={() => { if (a.confirmation) void a.perform(a.confirmation); }}>{a.confirmLabel}</AlertDialog.Action></AlertDialog.Footer></AlertDialog.Content></AlertDialog.Root>
<Dialog.Root bind:open={a.renameOpen}><Dialog.Content><Dialog.Header><Dialog.Title>Rename subscription</Dialog.Title><Dialog.Description>Choose a label to help you recognize this account.</Dialog.Description></Dialog.Header><form class="space-y-5" onsubmit={(event) => { event.preventDefault(); void a.saveLabel(); }}><div class="space-y-2"><Label for="account-label">Label</Label><Input id="account-label" bind:value={a.renamedLabel} maxlength={100} /></div><Dialog.Footer><Button type="submit" disabled={a.busy}>Save label</Button></Dialog.Footer></form></Dialog.Content></Dialog.Root>
