<script lang="ts">
  import * as Table from '#lib/components/ui/table/index.js';
  import { Badge } from '#lib/components/ui/badge/index.js';
  import { date, type AuditEvent, type Subscription } from './api.js';
  let { events, accounts }: { events: AuditEvent[]; accounts: Subscription[] } = $props();
</script>
<Table.Root><Table.Header><Table.Row><Table.Head>Time</Table.Head><Table.Head>API key</Table.Head><Table.Head>Subscription</Table.Head><Table.Head>Outcome</Table.Head></Table.Row></Table.Header><Table.Body>
  {#each events as event}<Table.Row><Table.Cell class="whitespace-nowrap text-muted-foreground">{date(event.occurredAt)}</Table.Cell><Table.Cell>{event.clientName}</Table.Cell><Table.Cell>{accounts.find((account) => account.accountId === event.accountId)?.email || event.accountId || '—'}</Table.Cell><Table.Cell><Badge variant={event.outcome === 'issued' ? 'secondary' : 'destructive'}>{event.outcome === 'issued' ? 'Granted' : event.outcome.replaceAll('_', ' ')}</Badge></Table.Cell></Table.Row>{:else}<Table.Row><Table.Cell colspan={4} class="h-24 text-center text-muted-foreground">No activity yet.</Table.Cell></Table.Row>{/each}
</Table.Body></Table.Root>
