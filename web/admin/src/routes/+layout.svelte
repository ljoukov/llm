<script lang="ts">
	import './layout.css';
	import type { LayoutProps } from './$types';
	import { ModeWatcher } from 'mode-watcher';
	import { Toaster } from '#lib/components/ui/sonner/index.js';

	let { children }: LayoutProps = $props();
</script>

<ModeWatcher disableHeadScriptInjection />
{@render children()}
<Toaster richColors />
