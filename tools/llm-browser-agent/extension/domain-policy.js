export const DEFAULT_DOMAIN_POLICY = Object.freeze({ mode: "all", allow: [], block: [] });

function isDnsLabel(value) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

export function parseDomainPolicyEntry(value) {
  if (typeof value !== "string")
    throw new Error("Domain policy: expected an HTTP(S) origin or wildcard origin.");
  const input = value.trim();
  const wildcard = input.includes("*");
  let candidate = input;
  if (wildcard) {
    const match = /^(https?):\/\/\*\.([^/?#*]+)\/?$/i.exec(input);
    if (!match)
      throw new Error(
        "Domain policy: only a complete leftmost *. hostname label may be a wildcard.",
      );
    candidate = `${match[1]}://${match[2]}`;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Domain policy: invalid HTTP(S) origin.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname.includes("*")
  ) {
    throw new Error("Domain policy: use HTTP(S) origins without paths or credentials.");
  }
  if (wildcard) {
    const labels = url.hostname.split(".");
    if (
      labels.length < 2 ||
      labels.some((label) => !isDnsLabel(label)) ||
      /^(?:\d+\.){3}\d+$/.test(url.hostname)
    ) {
      throw new Error(
        "Domain policy: wildcard bases need at least two DNS labels and cannot be IP addresses.",
      );
    }
  }
  return {
    scheme: url.protocol,
    baseHost: url.hostname,
    port: url.port,
    wildcard,
    canonical: wildcard ? `${url.protocol}//*.${url.host}` : url.origin,
  };
}

function entryMatchesUrl(entry, url) {
  const rule = parseDomainPolicyEntry(entry);
  if (rule.scheme !== url.protocol || rule.port !== url.port) return false;
  if (url.hostname === rule.baseHost) return true;
  if (!rule.wildcard || !url.hostname.endsWith(`.${rule.baseHost}`)) return false;
  return url.hostname
    .slice(0, -(rule.baseHost.length + 1))
    .split(".")
    .every(isDnsLabel);
}

function entryRegex(entry) {
  const rule = parseDomainPolicyEntry(entry);
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Chrome's 2 KB compiled-regex budget cannot represent a 63-character bound
  // here. Keep origin/label boundaries in DNR; the trusted matcher above also
  // enforces DNS label length before any tab can be read or acted on.
  const subdomains = rule.wildcard ? "([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)*" : "";
  return `^${escapeRegex(rule.scheme)}//${subdomains}${escapeRegex(rule.baseHost)}${rule.port ? `:${escapeRegex(rule.port)}` : ""}/`;
}

export function normalizeDomainPolicy(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["all", "allowlist"].includes(value.mode)
  ) {
    throw new Error("Domain policy: expected mode all or allowlist.");
  }
  const normalizeList = (list) => {
    if (
      !Array.isArray(list) ||
      list.length > 400 ||
      list.some((item) => typeof item !== "string")
    ) {
      throw new Error(
        "Domain policy: allow and block must contain at most 400 HTTP(S) origin patterns.",
      );
    }
    return [...new Set(list.map((item) => parseDomainPolicyEntry(item).canonical))].sort();
  };
  return { mode: value.mode, allow: normalizeList(value.allow), block: normalizeList(value.block) };
}

export function isRestrictedPolicy(policy) {
  return policy.mode === "allowlist" || policy.block.length > 0;
}

export function policyAllowsUrl(policy, value) {
  if (value === "about:blank") return true;
  if (typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
  if (policy.block.some((entry) => entryMatchesUrl(entry, url))) return false;
  return policy.mode === "all" || policy.allow.some((entry) => entryMatchesUrl(entry, url));
}

export function buildNavigationRules(policy, controlledTabIds) {
  if (!isRestrictedPolicy(policy) || controlledTabIds.length === 0) return [];
  let nextId = 1;
  const condition = {
    tabIds: [...controlledTabIds].sort((a, b) => a - b),
    resourceTypes: ["main_frame", "sub_frame"],
  };
  const rules = [];
  if (policy.mode === "allowlist") {
    rules.push({
      id: nextId++,
      priority: 10,
      action: { type: "block" },
      condition: { ...condition, regexFilter: "^https?://" },
    });
    for (const origin of policy.allow) {
      rules.push({
        id: nextId++,
        priority: 20,
        action: { type: "allow" },
        condition: { ...condition, regexFilter: entryRegex(origin) },
      });
    }
  }
  for (const origin of policy.block) {
    rules.push({
      id: nextId++,
      priority: 30,
      action: { type: "block" },
      condition: { ...condition, regexFilter: entryRegex(origin) },
    });
  }
  return rules;
}

/** Owns only this extension's session rules and the tabs claimed by the harness. */
export function createDomainPolicyController(browser) {
  let policy = normalizeDomainPolicy(DEFAULT_DOMAIN_POLICY);
  let currentRuleIds = [];
  const controlled = new Set();
  let updates = Promise.resolve();
  const ready = (async () => {
    if (browser.storage?.local?.get) {
      const stored = await browser.storage.local.get(["domainPolicy"]);
      if (stored.domainPolicy !== undefined) {
        try {
          policy = normalizeDomainPolicy(stored.domainPolicy);
        } catch {
          policy = { mode: "allowlist", allow: [], block: [] };
        }
      }
    }
    if (browser.declarativeNetRequest?.getSessionRules) {
      const rules = await browser.declarativeNetRequest.getSessionRules();
      currentRuleIds = rules.map((rule) => rule.id);
      for (const rule of rules)
        for (const tabId of rule.condition.tabIds ?? []) controlled.add(tabId);
      if (rules.length) await apply();
    }
  })();
  // Keep load failures observable to commands without an unhandled rejection.
  void ready.catch(() => {});

  function enqueue(update) {
    const result = updates.then(update);
    updates = result.catch(() => {});
    return result;
  }

  async function apply(nextPolicy = policy) {
    const rules = buildNavigationRules(nextPolicy, [...controlled]);
    if (!browser.declarativeNetRequest?.updateSessionRules) {
      if (isRestrictedPolicy(nextPolicy))
        throw new Error("Domain policy: Chrome navigation enforcement is unavailable.");
      return;
    }
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: currentRuleIds,
      addRules: rules,
    });
    currentRuleIds = rules.map((rule) => rule.id);
  }

  return {
    ready,
    get() {
      return { mode: policy.mode, allow: [...policy.allow], block: [...policy.block] };
    },
    restricted() {
      return isRestrictedPolicy(policy);
    },
    allows(url) {
      return policyAllowsUrl(policy, url);
    },
    assertUrl(url) {
      if (!policyAllowsUrl(policy, url))
        throw new Error("Domain policy: this URL is outside the allowed browser scope.");
    },
    async set(value) {
      const next = normalizeDomainPolicy(value);
      await ready;
      return enqueue(async () => {
        await apply(next);
        try {
          await browser.storage?.local?.set({ domainPolicy: next });
        } catch (error) {
          await apply(policy);
          throw error;
        }
        policy = next;
        return this.get();
      });
    },
    async control(tabId) {
      await ready;
      return enqueue(async () => {
        if (controlled.has(tabId)) return;
        controlled.add(tabId);
        try {
          await apply();
        } catch (error) {
          controlled.delete(tabId);
          throw error;
        }
      });
    },
    async forget(tabId) {
      await ready;
      return enqueue(async () => {
        if (controlled.delete(tabId)) await apply();
      });
    },
    async clear() {
      await ready;
      return enqueue(async () => {
        controlled.clear();
        await apply();
      });
    },
    async onCreated(tab) {
      await ready;
      if (!controlled.has(tab.openerTabId)) return;
      await this.control(tab.id);
      if (!policyAllowsUrl(policy, tab.pendingUrl ?? tab.url ?? "about:blank")) {
        await browser.tabs.remove(tab.id);
        await this.forget(tab.id);
      }
    },
  };
}
