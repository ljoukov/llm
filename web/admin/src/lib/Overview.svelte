<script lang="ts">
  import type { Admin } from './admin.svelte.js';
  import { accountLabel, count } from './api.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Card from '#lib/components/ui/card/index.js';
  import * as Table from '#lib/components/ui/table/index.js';
  import * as Alert from '#lib/components/ui/alert/index.js';
  import EventTable from './EventTable.svelte';
  let { a }: { a: Admin } = $props();
</script>
<div class="space-y-6">
  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{#each [
    { label: 'Subscriptions', value: a.accounts.length, detail: a.accounts.filter((account) => account.enabled).length + ' enabled accounts' },
    { label: 'Active API keys', value: a.keys.filter((key) => key.enabled).length, detail: 'Individually assigned access' },
    { label: 'Grants · ' + a.days + 'd', value: a.stats.totals.issued, detail: 'Credentials issued to applications' },
    { label: 'Failed selections · ' + a.days + 'd', value: a.stats.totals.failures, detail: 'Unavailable or expired accounts' }
  ] as metric}<Card.Root><Card.Header class="pb-2"><Card.Description>{metric.label}</Card.Description><Card.Title class="text-3xl tabular-nums">{count(metric.value)}</Card.Title></Card.Header><Card.Content><p class="text-xs text-muted-foreground">{metric.detail}</p></Card.Content></Card.Root>{/each}</div>
  <Card.Root><Card.Header class="flex-row justify-between gap-4"><div class="space-y-1"><Card.Title>Access over time</Card.Title><Card.Description>Token grants by day · UTC</Card.Description></div><div class="flex gap-1">{#each [7,30] as days}<Button size="sm" variant={a.days === days ? 'secondary' : 'ghost'} onclick={() => { a.days = days; void a.perform(() => a.load()); }}>{days}d</Button>{/each}</div></Card.Header><Card.Content><Table.Root><Table.Header><Table.Row><Table.Head>Date</Table.Head><Table.Head class="text-right">Granted</Table.Head><Table.Head class="text-right">Failed</Table.Head></Table.Row></Table.Header><Table.Body>{#each a.stats.daily as row}<Table.Row><Table.Cell>{row.day}</Table.Cell><Table.Cell class="text-right tabular-nums">{count(row.issued)}</Table.Cell><Table.Cell class="text-right tabular-nums">{count(row.failures)}</Table.Cell></Table.Row>{:else}<Table.Row><Table.Cell colspan={3} class="h-24 text-center text-muted-foreground">No activity in this period.</Table.Cell></Table.Row>{/each}</Table.Body></Table.Root></Card.Content></Card.Root>
  <Alert.Root><Alert.Title>What these statistics measure</Alert.Title><Alert.Description>Counts show token grants, not model-token consumption or billing. Check each subscription for account-wide limits. History begins with the multi-account upgrade.</Alert.Description></Alert.Root>
  <div class="grid gap-6 lg:grid-cols-2">{#each [{ title: 'By API key', rows: a.stats.byKey }, { title: 'By subscription', rows: a.stats.bySubscription }] as group}<Card.Root><Card.Header><Card.Title>{group.title}</Card.Title></Card.Header><Card.Content><Table.Root><Table.Header><Table.Row><Table.Head>Name</Table.Head><Table.Head class="text-right">Grants</Table.Head><Table.Head class="text-right">Failures</Table.Head></Table.Row></Table.Header><Table.Body>{#each group.rows as row}<Table.Row><Table.Cell class="max-w-56 truncate font-medium">{group.title === 'By subscription' ? accountLabel(a.accounts.find((account) => account.accountId === row.id)) : row.name === 'admin' ? 'Admin key' : row.name}</Table.Cell><Table.Cell class="text-right">{count(row.issued)}</Table.Cell><Table.Cell class="text-right">{count(row.failures)}</Table.Cell></Table.Row>{:else}<Table.Row><Table.Cell colspan={3} class="h-24 text-center text-muted-foreground">No activity yet.</Table.Cell></Table.Row>{/each}</Table.Body></Table.Root></Card.Content></Card.Root>{/each}</div>
  <Card.Root><Card.Header><Card.Title>Recent activity</Card.Title></Card.Header><Card.Content><EventTable events={a.events.slice(0,8)} accounts={a.accounts} /></Card.Content></Card.Root>
</div>
