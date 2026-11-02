<script lang="ts">
  import { CircleCheck, CircleAlert } from '@lucide/svelte';
  import type { KeyTestResult as Result } from './api.js';
  import { date } from './api.js';
  import * as Alert from '#lib/components/ui/alert/index.js';
  let { result }: { result: Result | null } = $props();
</script>

{#if result}
  <Alert.Root variant={result.ok ? 'default' : 'destructive'} aria-live="polite">
    {#if result.ok}<CircleCheck class="size-4" />{:else}<CircleAlert class="size-4" />{/if}
    <Alert.Title>{result.ok ? 'Key works' : 'Key check failed'}</Alert.Title>
    <Alert.Description class="space-y-3">
      <p>{result.message}</p>
      {#if result.client || result.subscription}
        <dl class="grid min-w-0 gap-2 text-sm">
          {#if result.client}<div><dt class="font-medium">API key</dt><dd class="break-all">{result.client.name}</dd></div>{/if}
          {#if result.subscription}
            <div><dt class="font-medium">Selected subscription</dt><dd class="break-all">{result.subscription.email || result.subscription.label || result.subscription.accountId}</dd></div>
            {#if result.subscription.plan}<div><dt class="font-medium">Plan</dt><dd>{result.subscription.plan}</dd></div>{/if}
          {/if}
          {#if result.expiresAt}<div><dt class="font-medium">Token expires</dt><dd>{date(result.expiresAt)}</dd></div>{/if}
        </dl>
      {/if}
      <p class="text-xs">Checked {date(result.checkedAt)} · {result.durationMs} ms</p>
    </Alert.Description>
  </Alert.Root>
{/if}
