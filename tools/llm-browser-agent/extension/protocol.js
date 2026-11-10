import { createDomainPolicyController } from "./domain-policy.js";

/** Only the locally paired process can send browser commands. */
export function validateBridgeUrl(value) {
  if (typeof value !== "string") throw new Error("Enter the connection URL from the local bridge.");
  const url = new URL(value.trim());
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/extension" ||
    url.hash ||
    !/^[0-9a-f]{64}$/.test(url.searchParams.get("token") ?? "") ||
    [...url.searchParams.keys()].length !== 1
  ) {
    throw new Error("Use ws://127.0.0.1:<port>/extension?token=<64 hexadecimal characters>.");
  }
  return url.href;
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireTabId(params) {
  if (!Number.isSafeInteger(params.tabId) || params.tabId <= 0) {
    throw new Error("tabId must be a positive integer.");
  }
  return params.tabId;
}

function cleanTab(tab) {
  return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "", active: tab.active };
}

/** Creates a dispatcher independent of the model runner and popup. */
export function createDispatcher(browser) {
  const domainPolicy = createDomainPolicyController(browser);
  const hasPolicyApis = Boolean(
    browser.storage?.local?.get || browser.declarativeNetRequest?.getSessionRules,
  );
  const attached = new Set();
  const attaching = new Map();
  const verifiedBlankTabs = new Set();
  const trustedLoaders = new Map();
  const freshCandidates = new Map();
  const protectedTabs = new Set();
  const pendingFreshLoads = new Map();
  const historyTransitions = new Set();
  let policyGeneration = 0;
  let generation = 0;
  const restrictedCommands = new Set([
    "Accessibility.getFullAXTree",
    "DOM.scrollIntoViewIfNeeded",
    "DOM.getBoxModel",
    "DOM.resolveNode",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Page.getFrameTree",
    "Page.captureScreenshot",
    "Page.getNavigationHistory",
    "Page.navigateToHistoryEntry",
    "Page.navigate",
    "Page.reload",
    "Runtime.releaseObject",
  ]);

  function clearTabTrust(tabId) {
    trustedLoaders.delete(tabId);
    freshCandidates.delete(tabId);
    protectedTabs.delete(tabId);
    pendingFreshLoads.delete(tabId);
    historyTransitions.delete(tabId);
  }

  function clearDocumentTrust() {
    trustedLoaders.clear();
    freshCandidates.clear();
    protectedTabs.clear();
    pendingFreshLoads.clear();
    historyTransitions.clear();
  }

  function trustLoader(tabId, loaderId) {
    if (typeof loaderId !== "string" || !loaderId)
      throw new Error("Domain policy: Chrome did not provide a document loader identity.");
    const loaders = trustedLoaders.get(tabId) ?? new Set();
    loaders.add(loaderId);
    trustedLoaders.set(tabId, loaders);
    protectedTabs.add(tabId);
  }

  async function mainFrame(tabId) {
    const tree = await browser.debugger.sendCommand({ tabId }, "Page.getFrameTree", {});
    const frame = (await sanitizeFrameTree({ frame: tree.frameTree?.frame }, tabId)).frame;
    if (!frame || typeof frame.id !== "string")
      throw new Error("Chrome did not return a main-frame identity.");
    return frame;
  }

  async function requireFreshDocument(tabId) {
    if (!domainPolicy.restricted()) return;
    const currentPolicyGeneration = policyGeneration;
    const frame = await mainFrame(tabId);
    const loaderId = frame.loaderId;
    if (trustedLoaders.get(tabId)?.has(loaderId)) {
      historyTransitions.delete(tabId);
      return;
    }
    if (historyTransitions.has(tabId))
      throw new Error(
        "Domain policy: this restored document needs an explicit reload before it can be read.",
      );
    const pending = pendingFreshLoads.get(tabId);
    const explicitFreshLoader =
      pending?.generation === policyGeneration &&
      pending.expectedLoader === loaderId &&
      loaderId !== pending.previousLoader;
    const eventProvesFreshLoader =
      freshCandidates.get(tabId)?.has(loaderId) &&
      (!pending || loaderId !== pending.previousLoader);
    if (explicitFreshLoader || eventProvesFreshLoader) {
      const state = remoteValue(
        await browser.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        }),
      );
      if (state !== "complete")
        throw new Error("Browser document is still loading; retry after navigation.");
      if (currentPolicyGeneration !== policyGeneration)
        throw new Error("Domain policy: permissions changed while the document was loading.");
      trustLoader(tabId, loaderId);
      pendingFreshLoads.delete(tabId);
      return;
    }
    if (pending?.generation === policyGeneration)
      throw new Error("Browser document refresh is still in progress; retry after navigation.");
    throw new Error(
      "Domain policy: explicitly reload or navigate this tab before reading pre-existing content.",
    );
  }

  async function checkTab(tabId) {
    // Chrome always supplies tabs.get. Optionality preserves small pure mocks
    // used by the unrestricted transport tests.
    if (browser.tabs?.get) {
      const tab = await browser.tabs.get(tabId);
      domainPolicy.assertUrl(tab.url ?? "about:blank");
      if (tab.pendingUrl) domainPolicy.assertUrl(tab.pendingUrl);
      return tab;
    }
  }

  async function prepare(tabId, checkFrames = true) {
    if (!hasPolicyApis) {
      await attach(tabId);
      return;
    }
    const startedGeneration = generation;
    const stillConnected = () => {
      if (startedGeneration !== generation)
        throw new Error("Browser connection closed while preparing the tab.");
    };
    await checkTab(tabId);
    stillConnected();
    await domainPolicy.control(tabId);
    stillConnected();
    await checkTab(tabId);
    stillConnected();
    await attach(tabId);
    stillConnected();
    if (domainPolicy.restricted()) {
      await browser.debugger.sendCommand({ tabId }, "Network.setBypassServiceWorker", {
        bypass: true,
      });
      await browser.debugger.sendCommand({ tabId }, "Page.enable", {});
      if (checkFrames) {
        await requireFreshDocument(tabId);
        const tree = await allowedFrameTree(tabId);
        if (tree.frameTree?.frame?.url === "about:blank") verifiedBlankTabs.add(tabId);
      }
    }
  }

  async function frameOwnerNode(tabId, frameId) {
    const owner = await browser.debugger.sendCommand({ tabId }, "DOM.getFrameOwner", { frameId });
    const described = await browser.debugger.sendCommand({ tabId }, "DOM.describeNode", {
      ...(Number.isSafeInteger(owner.backendNodeId)
        ? { backendNodeId: owner.backendNodeId }
        : { nodeId: owner.nodeId }),
      depth: 0,
    });
    return described.node;
  }

  async function inlineSrcdocScope(tabId, frame, parentScope) {
    if (
      frame.url !== "about:srcdoc" ||
      !parentScope?.allowed ||
      !parentScope.origin ||
      frame.parentId !== parentScope.frameId ||
      !domainPolicy.allows(parentScope.origin)
    )
      return null;
    try {
      const owner = await frameOwnerNode(tabId, frame.id);
      if (
        owner?.localName !== "iframe" ||
        (typeof owner.frameId === "string" && owner.frameId !== frame.id)
      )
        return null;
      const attributes = owner.attributes;
      if (Array.isArray(attributes)) {
        for (let index = 0; index + 1 < attributes.length; index += 2) {
          if (attributes[index] === "srcdoc") return parentScope.origin;
        }
      }
    } catch {}
    return null;
  }

  async function sanitizeFrameTree(node, tabId, parentScope) {
    const frame = node?.frame;
    if (!frame || typeof frame.url !== "string") return node;
    // A denied subframe becomes Chrome's empty error document. It carries no
    // denied-site document content; do not expose its unreachable URL metadata.
    const placeholder = frame.url === "chrome-error://chromewebdata/";
    // Chrome sometimes exposes blocked error frames with an empty URL and an
    // opaque origin. That shape is ambiguous, so keep the entire tab unreadable
    // rather than treating an unverified document as a neutral placeholder.
    const inheritedDocument = frame.url === "about:srcdoc" || frame.url.startsWith("blob:");
    let scopeOrigin = diagnosticOrigin(frame.url);
    if (!placeholder && !inheritedDocument) domainPolicy.assertUrl(frame.url);
    if (!placeholder && inheritedDocument) {
      if (
        typeof frame.securityOrigin !== "string" ||
        ["", "://", "null"].includes(frame.securityOrigin)
      ) {
        scopeOrigin = await inlineSrcdocScope(tabId, frame, parentScope);
        if (!scopeOrigin)
          throw new Error(
            "Domain policy: unverified opaque inline frame is outside the allowed scope.",
          );
      } else {
        domainPolicy.assertUrl(frame.securityOrigin);
        scopeOrigin = diagnosticOrigin(frame.securityOrigin);
      }
      if (frame.url.startsWith("blob:")) domainPolicy.assertUrl(new URL(frame.url).origin);
    }
    if (
      !placeholder &&
      frame.url === "about:blank" &&
      typeof frame.securityOrigin === "string" &&
      !["", "://", "null"].includes(frame.securityOrigin)
    ) {
      domainPolicy.assertUrl(frame.securityOrigin);
      scopeOrigin = diagnosticOrigin(frame.securityOrigin);
    }
    const { unreachableUrl: _unreachableUrl, ...cleanFrame } = frame;
    if (placeholder) {
      cleanFrame.url = "about:blank";
      cleanFrame.securityOrigin = "://";
      scopeOrigin = null;
    }
    return {
      ...node,
      frame: cleanFrame,
      ...(node.childFrames
        ? {
            childFrames: await Promise.all(
              node.childFrames.map((child) =>
                sanitizeFrameTree(child, tabId, {
                  frameId: frame.id,
                  origin: scopeOrigin,
                  allowed: true,
                }),
              ),
            ),
          }
        : {}),
    };
  }

  async function allowedFrameTree(tabId) {
    const result = await browser.debugger.sendCommand({ tabId }, "Page.getFrameTree", {});
    try {
      return { ...result, frameTree: await sanitizeFrameTree(result.frameTree, tabId) };
    } catch {
      throw new Error(
        "Domain policy: this tab contains a loaded frame outside the allowed scope. Navigate or reload it before reading.",
      );
    }
  }

  function remoteValue(result) {
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "Chrome page operation failed.",
      );
    return result.result?.value;
  }

  function diagnosticOrigin(value, base) {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value, base);
      if (["http:", "https:"].includes(url.protocol)) return url.origin;
      if (url.protocol === "blob:") {
        const origin = new URL(url.origin);
        if (["http:", "https:"].includes(origin.protocol)) return origin.origin;
      }
    } catch {}
    return null;
  }

  async function inspectPolicy(tabId) {
    await prepare(tabId, false);
    const result = await browser.debugger.sendCommand({ tabId }, "Page.getFrameTree", {});
    const root = result.frameTree;
    const mainFrame = (await sanitizeFrameTree({ frame: root?.frame }, tabId)).frame;
    if (!mainFrame) throw new Error("Chrome did not return a main frame.");
    const tab = await checkTab(tabId);
    const topOrigin =
      diagnosticOrigin(mainFrame.url) ??
      diagnosticOrigin(mainFrame.securityOrigin) ??
      diagnosticOrigin(tab?.url);
    const frames = [];
    async function visit(node, parentUrl, parentScope) {
      const frame = node?.frame;
      if (!frame) return;
      const frameUrl = typeof frame.url === "string" ? frame.url : "";
      const kind =
        frameUrl === "chrome-error://chromewebdata/"
          ? "chrome-error"
          : frameUrl === "about:srcdoc"
            ? "srcdoc"
            : frameUrl === "about:blank"
              ? "blank"
              : frameUrl.startsWith("blob:")
                ? "blob"
                : diagnosticOrigin(frameUrl)
                  ? "document"
                  : "opaque";
      let origin = diagnosticOrigin(frameUrl);
      let source = origin ? "frame-url" : "unavailable";
      if (!origin) {
        origin = diagnosticOrigin(frame.securityOrigin);
        if (origin) source = "security-origin";
      }
      if (!origin && frameUrl === "about:srcdoc") {
        origin = await inlineSrcdocScope(tabId, frame, parentScope);
        if (origin) source = "inline-parent";
      }
      if (
        !origin &&
        frameUrl !== "about:srcdoc" &&
        typeof frame.parentId === "string" &&
        typeof frame.id === "string"
      ) {
        try {
          const owner = await frameOwnerNode(tabId, frame.id);
          const attributes = owner?.attributes;
          if (Array.isArray(attributes)) {
            for (let index = 0; index + 1 < attributes.length; index += 2) {
              if (attributes[index] === "src") {
                origin = diagnosticOrigin(attributes[index + 1], parentUrl);
                if (origin) source = "iframe-src";
                break;
              }
            }
          }
        } catch {}
      }
      const allowed =
        (parentScope?.allowed ?? true) &&
        (origin
          ? domainPolicy.allows(origin)
          : frameUrl === "about:blank" && ["", "://", "null"].includes(frame.securityOrigin));
      frames.push({
        frameId: frame.id,
        ...(typeof frame.parentId === "string" ? { parentFrameId: frame.parentId } : {}),
        origin,
        allowed,
        kind,
        source,
      });
      for (const child of node.childFrames ?? [])
        await visit(child, frameUrl || parentUrl, { frameId: frame.id, origin, allowed });
    }
    await visit(root, mainFrame.url);
    await checkTab(tabId);
    return { topOrigin, frames };
  }

  async function fixedRead(tabId, field) {
    if (field === "navigation") {
      // Reload needs an allowed top-document identity even when an old embedded
      // frame is outside scope. Return no embedded-frame metadata or content.
      await prepare(tabId, false);
      const tree = await browser.debugger.sendCommand({ tabId }, "Page.getFrameTree", {});
      const frame = (await sanitizeFrameTree({ frame: tree.frameTree?.frame }, tabId)).frame;
      if (!frame || typeof frame.id !== "string" || typeof frame.url !== "string")
        throw new Error("Chrome did not return a main-frame navigation identity.");
      await checkTab(tabId);
      return { id: frame.id, loaderId: frame.loaderId, url: frame.url };
    }
    const expressions = {
      title: "document.title",
      readyState: "document.readyState",
      viewport: "({width:innerWidth,height:innerHeight,scrollX,scrollY})",
    };
    if (!Object.hasOwn(expressions, field)) throw new Error("Unknown page.read field.");
    await prepare(tabId);
    const result = remoteValue(
      await browser.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: expressions[field],
        returnByValue: true,
      }),
    );
    await checkTab(tabId);
    if (domainPolicy.restricted()) {
      await requireFreshDocument(tabId);
      await allowedFrameTree(tabId);
    }
    return result;
  }

  async function fixedFill(tabId, backendNodeId, text) {
    if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0 || typeof text !== "string")
      throw new Error("page.fill requires backendNodeId and text.");
    await prepare(tabId);
    const resolved = await browser.debugger.sendCommand({ tabId }, "DOM.resolveNode", {
      backendNodeId,
    });
    const objectId = resolved.object?.objectId;
    if (typeof objectId !== "string")
      throw new Error("Cannot resolve this element; take a new snapshot.");
    try {
      const value = remoteValue(
        await browser.debugger.sendCommand({ tabId }, "Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: `function(text) {
          this.focus();
          if (this.isContentEditable) this.textContent = text;
          else if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this instanceof HTMLSelectElement) {
            if (this.disabled || this.readOnly) throw new Error('Element is disabled or read-only.');
            const prototype = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : this instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, 'value').set.call(this, text);
          } else throw new Error('Element is not editable.');
          this.dispatchEvent(new Event('input', {bubbles:true,composed:true}));
          this.dispatchEvent(new Event('change', {bubbles:true}));
          return {filled:true};
        }`,
          arguments: [{ value: text }],
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        }),
      );
      await checkTab(tabId);
      if (domainPolicy.restricted()) {
        await requireFreshDocument(tabId);
        await allowedFrameTree(tabId);
      }
      return value;
    } finally {
      await browser.debugger
        .sendCommand({ tabId }, "Runtime.releaseObject", { objectId })
        .catch(() => {});
    }
  }

  async function attach(tabId) {
    if (attached.has(tabId)) return;
    if (attaching.has(tabId)) return attaching.get(tabId);
    const startedGeneration = generation;
    const promise = (async () => {
      await browser.debugger.attach({ tabId }, "1.3");
      if (startedGeneration !== generation) {
        await browser.debugger.detach({ tabId }).catch(() => {});
        throw new Error("Browser connection closed while attaching.");
      }
      attached.add(tabId);
    })();
    attaching.set(tabId, promise);
    try {
      await promise;
    } finally {
      if (attaching.get(tabId) === promise) attaching.delete(tabId);
    }
  }

  async function detach(tabId) {
    await attaching.get(tabId)?.catch(() => {});
    // Never detach a debugger attached by DevTools or another extension.
    if (!attached.has(tabId)) return;
    attached.delete(tabId);
    await browser.debugger.detach({ tabId }).catch(() => {});
  }

  return {
    async onTabCreated(tab) {
      await domainPolicy.onCreated(tab);
    },
    async onTabRemoved(tabId) {
      attached.delete(tabId);
      clearTabTrust(tabId);
      verifiedBlankTabs.delete(tabId);
      await domainPolicy.forget(tabId);
    },
    onTabUpdated(tabId, changeInfo) {
      if (changeInfo.url) verifiedBlankTabs.delete(tabId);
    },
    onDetach(source) {
      if (source.tabId !== undefined) {
        attached.delete(source.tabId);
        clearTabTrust(source.tabId);
      }
    },
    onEvent(source, method, params) {
      if (
        method !== "Page.frameNavigated" ||
        !domainPolicy.restricted() ||
        source.sessionId ||
        !Number.isSafeInteger(source.tabId)
      )
        return;
      const frame = params?.frame;
      if (!frame || frame.parentId || typeof frame.loaderId !== "string") return;
      const tabId = source.tabId;
      if (params.type === "BackForwardCacheRestore") {
        if (!trustedLoaders.get(tabId)?.has(frame.loaderId)) {
          historyTransitions.add(tabId);
          pendingFreshLoads.delete(tabId);
          freshCandidates.delete(tabId);
        } else historyTransitions.delete(tabId);
        return;
      }
      if (params.type !== "Navigation") return;
      const pending = pendingFreshLoads.get(tabId);
      if (!protectedTabs.has(tabId) && pending?.generation !== policyGeneration) return;
      if (pending?.generation === policyGeneration && frame.loaderId === pending.previousLoader)
        return;
      if (pending?.expectedLoader && frame.loaderId !== pending.expectedLoader) return;
      if (historyTransitions.has(tabId)) return;
      const candidates = freshCandidates.get(tabId) ?? new Set();
      candidates.add(frame.loaderId);
      freshCandidates.set(tabId, candidates);
    },
    async detachAll() {
      generation += 1;
      clearDocumentTrust();
      await Promise.all([...attached].map(detach));
      // In-flight attaches notice the changed generation and detach themselves.
      await Promise.allSettled([...attaching.values()]);
      await domainPolicy.clear();
      verifiedBlankTabs.clear();
    },
    async dispatch(request) {
      const startedGeneration = generation;
      if (!isRecord(request) || typeof request.id !== "string" || !request.id) {
        throw new Error("Requests require a nonempty string id.");
      }
      if (typeof request.method !== "string" || !isRecord(request.params)) {
        throw new Error("Requests require a method and object params.");
      }
      const { method, params } = request;
      if (hasPolicyApis) await domainPolicy.ready;
      if (startedGeneration !== generation)
        throw new Error("Browser connection closed before the command started.");
      switch (method) {
        case "policy.get":
          return domainPolicy.get();
        case "policy.inspect":
          return inspectPolicy(requireTabId(params));
        case "policy.set": {
          const policy = await domainPolicy.set(params.policy);
          policyGeneration += 1;
          clearDocumentTrust();
          verifiedBlankTabs.clear();
          return policy;
        }
        case "tabs.list":
          return (await browser.tabs.query({}))
            .filter(
              (tab) =>
                domainPolicy.allows(tab.url ?? "about:blank") &&
                (!tab.pendingUrl || domainPolicy.allows(tab.pendingUrl)) &&
                (!domainPolicy.restricted() ||
                  tab.url !== "about:blank" ||
                  verifiedBlankTabs.has(tab.id)),
            )
            .map(cleanTab);
        case "tabs.create": {
          if (typeof params.url !== "string") throw new Error("url must be a string.");
          domainPolicy.assertUrl(params.url);
          // Install tab-scoped rules on a neutral tab before the first request.
          const tab = await browser.tabs.create({ url: "about:blank" });
          try {
            await domainPolicy.control(tab.id);
            verifiedBlankTabs.add(tab.id);
            if (domainPolicy.restricted()) {
              await prepare(tab.id, false);
              const blank = await mainFrame(tab.id);
              if (blank.url !== "about:blank")
                throw new Error(
                  "Domain policy: a new tab left its neutral document before protection was installed.",
                );
              trustLoader(tab.id, blank.loaderId);
              if (params.url !== "about:blank")
                pendingFreshLoads.set(tab.id, {
                  generation: policyGeneration,
                  previousLoader: blank.loaderId,
                });
            }
            return cleanTab(
              params.url === "about:blank"
                ? tab
                : await browser.tabs.update(tab.id, { url: params.url }),
            );
          } catch (error) {
            await browser.tabs.remove(tab.id).catch(() => {});
            await domainPolicy.forget(tab.id);
            throw error;
          }
        }
        case "tabs.close": {
          const tabId = requireTabId(params);
          if (domainPolicy.restricted()) await prepare(tabId);
          else await checkTab(tabId);
          await browser.tabs.remove(tabId);
          attached.delete(tabId);
          clearTabTrust(tabId);
          verifiedBlankTabs.delete(tabId);
          await domainPolicy.forget(tabId);
          return { closed: true };
        }
        case "tabs.activate": {
          const tabId = requireTabId(params);
          if (domainPolicy.restricted()) await prepare(tabId);
          else await checkTab(tabId);
          await domainPolicy.control(tabId);
          return cleanTab(await browser.tabs.update(tabId, { active: true }));
        }
        case "debugger.detach":
          clearTabTrust(requireTabId(params));
          await detach(requireTabId(params));
          return { detached: true };
        case "page.read":
          return fixedRead(requireTabId(params), params.field);
        case "page.fill":
          return fixedFill(requireTabId(params), params.backendNodeId, params.text);
        case "cdp.send": {
          const tabId = requireTabId(params);
          if (
            typeof params.method !== "string" ||
            !/^[A-Za-z]+\.[A-Za-z][A-Za-z0-9]*$/.test(params.method)
          ) {
            throw new Error("method must be a CDP Domain.command name.");
          }
          if (!isRecord(params.params)) throw new Error("CDP params must be an object.");
          if (domainPolicy.restricted() && !restrictedCommands.has(params.method))
            throw new Error(
              "Domain policy: this raw CDP command is disabled while site restrictions are active.",
            );
          const navigates = [
            "Page.navigate",
            "Page.reload",
            "Page.navigateToHistoryEntry",
          ].includes(params.method);
          if (params.method === "Page.navigate") domainPolicy.assertUrl(params.params.url);
          await prepare(tabId, !navigates);
          if (params.method === "Page.navigateToHistoryEntry") {
            const history = await browser.debugger.sendCommand(
              { tabId },
              "Page.getNavigationHistory",
              {},
            );
            const target = history.entries?.find((entry) => entry.id === params.params.entryId);
            if (!target) throw new Error("Unknown history entry.");
            domainPolicy.assertUrl(target.url);
            if (domainPolicy.restricted()) {
              pendingFreshLoads.delete(tabId);
              historyTransitions.add(tabId);
            }
          }
          if (params.method === "Page.getFrameTree" && domainPolicy.restricted()) {
            const tree = await allowedFrameTree(tabId);
            await requireFreshDocument(tabId);
            return tree;
          }
          let beforeNavigation;
          if (
            domainPolicy.restricted() &&
            ["Page.navigate", "Page.reload"].includes(params.method)
          ) {
            beforeNavigation = await mainFrame(tabId);
            historyTransitions.delete(tabId);
            pendingFreshLoads.set(tabId, {
              generation: policyGeneration,
              previousLoader: beforeNavigation.loaderId,
            });
          }
          const result =
            (await browser.debugger.sendCommand({ tabId }, params.method, params.params)) ?? {};
          if (navigates) {
            if (domainPolicy.restricted() && beforeNavigation) {
              const pending = pendingFreshLoads.get(tabId);
              if (pending && typeof result.loaderId === "string")
                pending.expectedLoader = result.loaderId;
              if (
                params.method === "Page.navigate" &&
                !result.loaderId &&
                trustedLoaders.get(tabId)?.has(beforeNavigation.loaderId)
              )
                pendingFreshLoads.delete(tabId);
            }
            return result;
          }
          await checkTab(tabId);
          if (domainPolicy.restricted()) {
            await requireFreshDocument(tabId);
            await allowedFrameTree(tabId);
          }
          if (params.method === "Page.getNavigationHistory") {
            const currentId = result.entries?.[result.currentIndex]?.id;
            const entries = (result.entries ?? []).filter((entry) =>
              domainPolicy.allows(entry.url),
            );
            return {
              ...result,
              entries,
              currentIndex: entries.findIndex((entry) => entry.id === currentId),
            };
          }
          return result;
        }
        default:
          throw new Error(`Unknown bridge method: ${method}`);
      }
    },
  };
}
