/** Browser actions over the independently owned Chrome extension bridge. */
export interface BrowserTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

type TabAction = { tabId: number };
export type BrowserAction =
  | { action: "tabs" }
  | { action: "open"; url: string }
  | ({ action: "activate" | "close" | "back" | "forward" | "reload" | "screenshot" } & TabAction)
  | ({ action: "snapshot"; maxChars?: number } & TabAction)
  | ({ action: "navigate"; url: string } & TabAction)
  | ({ action: "click"; ref?: string; x?: number; y?: number } & TabAction)
  | ({ action: "fill"; ref: string; text: string } & TabAction)
  | ({ action: "press"; key: string } & TabAction)
  | ({ action: "scroll"; x: number; y: number } & TabAction)
  | ({ action: "evaluate"; expression: string } & TabAction)
  | ({ action: "wait"; expression?: string; timeoutMs?: number } & TabAction);

type RecordValue = Record<string, unknown>;
type Frame = { id: string; loaderId?: string; url: string };
type AxValue = { value?: unknown };
type AxNode = {
  nodeId: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: { name: string; value?: AxValue }[];
  childIds?: string[];
  frameId?: string;
};
type Reference = { backendNodeId: number; role: string; name: string };
type DocumentState = { documentId: string; refs: Map<string, Reference> };

export type BrowserSnapshot = {
  tabId: number;
  url: string;
  title: string;
  documentId: string;
  text: string;
  truncated: boolean;
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const record = (value: unknown): RecordValue => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Chrome returned an invalid object response.");
  }
  return value as RecordValue;
};
const errorText = (value: unknown) => (value instanceof Error ? value.message : String(value));
const isPolicyError = (value: unknown) => errorText(value).startsWith("Domain policy:");
const IMAGE_DATA_URL_PREFIX = "data:image/jpeg;base64,";
const MAX_INLINE_IMAGE_CHARS = 700000;
const MAX_RUN_IMAGE_CHARS = 8 * 1024 * 1024;
const SCREENSHOT_SCALES = [1, 0.75, 0.5, 0.35, 0.25, 0.125] as const;

/** There is deliberately no website/domain allowlist or injected policy prompt here. */
export function validateBrowserUrl(value: string): string {
  if (value === "about:blank") return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Browser navigation requires an absolute HTTP(S) URL or about:blank.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser navigation requires an HTTP(S) URL or about:blank.");
  }
  return url.href;
}

function requireTabId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("tabId must be a positive integer.");
  return value;
}

function finiteCoordinate(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
}

function remoteResult(response: unknown): unknown {
  const data = record(response);
  if (data.exceptionDetails) {
    const details = record(data.exceptionDetails);
    const exception = details.exception ? record(details.exception) : undefined;
    throw new Error(
      String(exception?.description ?? details.text ?? "JavaScript evaluation failed."),
    );
  }
  const result = record(data.result);
  if (result.subtype === "error")
    throw new Error(String(result.description ?? "JavaScript error."));
  if (typeof result.unserializableValue === "string") return result.unserializableValue;
  if (result.type === "undefined") return null;
  return result.value ?? null;
}

function quote(value: unknown, limit = 2000): string {
  const text = String(value ?? "");
  return JSON.stringify(text.length > limit ? `${text.slice(0, limit)}…` : text);
}

function observedLinkUrl(node: AxNode): string | undefined {
  if (node.role?.value !== "link") return undefined;
  const value = node.properties?.find((property) => property.name === "url")?.value?.value;
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.href.length <= 4096) {
      return url.href;
    }
  } catch {
    // Invalid or relative metadata is not a usable observed navigation target.
  }
  return undefined;
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Browser operation deadline exceeded.")),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One session owns its element references; Chrome keeps the actual tabs and logins. */
export class BrowserSession {
  private readonly documents = new Map<number, DocumentState>();
  private nextRef = 1;
  private tail: Promise<void> = Promise.resolve();
  private readonly isMac: boolean;
  private generation = 0;
  private mediaCharsUsed = 0;

  constructor(
    private readonly transport: BrowserTransport,
    options: { platform?: string } = {},
  ) {
    this.isMac = (options.platform ?? process.platform) === "darwin";
  }

  private cdp(tabId: number, method: string, params: RecordValue = {}): Promise<unknown> {
    return this.transport.request("cdp.send", { tabId: requireTabId(tabId), method, params });
  }

  /** Invalidate references when the caller changes browser permissions. */
  reset(): void {
    this.generation++;
    this.documents.clear();
    this.resetMediaBudget();
  }

  /** Start a fresh model-turn image budget without invalidating DOM references. */
  resetMediaBudget(): void {
    this.mediaCharsUsed = 0;
  }

  private readPage(tabId: number, field: "title" | "readyState" | "viewport"): Promise<unknown> {
    return this.transport.request("page.read", { tabId: requireTabId(tabId), field });
  }

  private async frame(tabId: number): Promise<Frame> {
    const result = record(await this.cdp(tabId, "Page.getFrameTree"));
    return record(record(result.frameTree).frame) as Frame;
  }

  private async reloadNavigationFrame(tabId: number): Promise<Frame> {
    // Reload must be able to replace an allowed main document that still has a
    // previously loaded blocked child. This exposes only its navigation marker;
    // content operations continue to require the full frame-policy check.
    const frame = record(
      await this.transport.request("page.read", {
        tabId: requireTabId(tabId),
        field: "navigation",
      }),
    );
    if (
      typeof frame.id !== "string" ||
      typeof frame.url !== "string" ||
      (frame.loaderId !== undefined && typeof frame.loaderId !== "string")
    ) {
      throw new Error("Chrome returned an invalid main-frame navigation response.");
    }
    return { id: frame.id, url: frame.url, loaderId: frame.loaderId as string | undefined };
  }

  private documentId(frame: Frame): string {
    return `${frame.id}:${frame.loaderId ?? frame.url}`;
  }

  private async evaluate(tabId: number, expression: string, timeoutMs?: number): Promise<unknown> {
    return remoteResult(
      await this.cdp(tabId, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        ...(timeoutMs === undefined ? {} : { timeout: Math.max(1, timeoutMs) }),
      }),
    );
  }

  private async reference(tabId: number, ref: string): Promise<Reference> {
    const state = this.documents.get(tabId);
    const reference = state?.refs.get(ref);
    if (!state || !reference) {
      throw new Error(`Unknown or expired element reference ${ref}; take a new snapshot.`);
    }
    if (state.documentId !== this.documentId(await this.frame(tabId))) {
      this.documents.delete(tabId);
      throw new Error(`Element reference ${ref} is stale after navigation; take a new snapshot.`);
    }
    if (this.documents.get(tabId) !== state) {
      throw new Error(
        `Element reference ${ref} expired when permissions changed; take a new snapshot.`,
      );
    }
    return reference;
  }

  async snapshot(tabId: number, maxChars = 24000): Promise<BrowserSnapshot> {
    requireTabId(tabId);
    const generation = this.generation;
    if (!Number.isSafeInteger(maxChars) || maxChars < 256 || maxChars > 100000) {
      throw new Error("maxChars must be an integer between 256 and 100000.");
    }
    // Retrying once avoids associating an old tree with a new document during navigation.
    for (let attempt = 0; attempt < 2; attempt++) {
      const frame = await this.frame(tabId);
      const documentId = this.documentId(frame);
      const title = await this.readPage(tabId, "title");
      const response = record(await this.cdp(tabId, "Accessibility.getFullAXTree"));
      const nodes = (Array.isArray(response.nodes) ? response.nodes : []) as AxNode[];
      if (this.documentId(await this.frame(tabId)) !== documentId) continue;

      const previous = this.documents.get(tabId);
      const oldRefs = new Map<number, string>();
      if (previous?.documentId === documentId) {
        for (const [ref, value] of previous.refs) oldRefs.set(value.backendNodeId, ref);
      }
      const refs = new Map<string, Reference>();
      const index = new Map(nodes.map((node) => [node.nodeId, node]));
      const childIds = new Set(nodes.flatMap((node) => node.childIds ?? []));
      const roots = nodes.filter((node) => !childIds.has(node.nodeId));
      const visited = new Set<string>();
      const lines: string[] = [];
      let length = 0;
      let truncated = false;
      const add = (line: string) => {
        const remaining = maxChars - length;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        if (line.length + 1 > remaining) {
          lines.push(line.slice(0, Math.max(0, remaining - 1)));
          length = maxChars;
          truncated = true;
        } else {
          lines.push(line);
          length += line.length + 1;
        }
      };
      const visit = (node: AxNode, depth: number, actualDepth = 0) => {
        if (visited.has(node.nodeId)) return;
        visited.add(node.nodeId);
        if (visited.size > 12000 || actualDepth > 128) {
          truncated = true;
          return;
        }
        if (length >= maxChars) {
          truncated = true;
          return;
        }
        const role = String(node.role?.value ?? "unknown");
        const name = String(node.name?.value ?? "");
        const meaningful =
          !node.ignored && ((role !== "none" && role !== "generic") || name.length > 0);
        if (meaningful) {
          let ref = "";
          const backendNodeId = node.backendDOMNodeId;
          if (
            typeof backendNodeId === "number" &&
            Number.isSafeInteger(backendNodeId) &&
            backendNodeId > 0
          ) {
            ref = oldRefs.get(backendNodeId) ?? `e${this.nextRef++}`;
          }
          const properties = (node.properties ?? [])
            .filter((prop) =>
              [
                "checked",
                "disabled",
                "expanded",
                "focused",
                "selected",
                "required",
                "level",
              ].includes(prop.name),
            )
            .map((prop) => `${prop.name}=${quote(prop.value?.value, 80)}`);
          const linkUrl = observedLinkUrl(node);
          const baseLine = `${"  ".repeat(Math.min(depth, 16))}${ref ? `[${ref}] ` : ""}${role}${name ? ` ${quote(name)}` : ""}${node.value?.value !== undefined ? ` value=${quote(node.value.value)}` : ""}${node.frameId ? ` frame=${node.frameId}` : ""}${properties.length ? ` ${properties.join(" ")}` : ""}`;
          const linkPart = linkUrl ? ` url=${quote(linkUrl, 4096)}` : "";
          // A shortened URL must never look like an observed navigation target.
          const linkFits = baseLine.length + linkPart.length + 1 <= maxChars - length;
          const line = linkFits ? `${baseLine}${linkPart}` : baseLine;
          if (linkPart && !linkFits) truncated = true;
          const before = length;
          add(line);
          // Only publish a ref if its complete line was included in this snapshot.
          if (ref && backendNodeId !== undefined && length - before === line.length + 1)
            refs.set(ref, { backendNodeId, role, name });
        }
        for (const childId of node.childIds ?? []) {
          const child = index.get(childId);
          if (child) visit(child, depth + (meaningful ? 1 : 0), actualDepth + 1);
        }
      };
      for (const root of roots) visit(root, 0);
      if (generation !== this.generation) {
        throw new Error(
          "Browser permissions changed while taking a snapshot; take a new snapshot.",
        );
      }
      this.documents.set(tabId, { documentId, refs });
      return {
        tabId,
        url: frame.url,
        title: String(title ?? ""),
        documentId,
        text: lines.join("\n"),
        truncated,
      };
    }
    throw new Error("Page navigated while taking a snapshot; try again.");
  }

  private async waitReady(
    tabId: number,
    options: {
      loaderId?: string;
      url?: string;
      previousDocumentId?: string;
      nonBlank?: boolean;
    } = {},
  ): Promise<void> {
    const deadline = Date.now() + 10000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const frame = await beforeDeadline(this.frame(tabId), deadline);
        const ready = await beforeDeadline(this.readPage(tabId, "readyState"), deadline);
        const documentMatches = !options.loaderId || frame.loaderId === options.loaderId;
        const urlMatches = !options.url || frame.url === options.url;
        const changed =
          !options.previousDocumentId || this.documentId(frame) !== options.previousDocumentId;
        const loaded = !options.nonBlank || frame.url !== "about:blank";
        if (
          documentMatches &&
          urlMatches &&
          changed &&
          loaded &&
          (ready === "interactive" || ready === "complete")
        )
          return;
      } catch (error) {
        if (isPolicyError(error)) throw error;
        lastError = error;
      }
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    throw new Error(
      `Page did not become ready within 10 seconds${lastError ? `: ${errorText(lastError)}` : "."}`,
    );
  }

  private async click(
    tabId: number,
    input: { ref?: string; x?: number; y?: number },
  ): Promise<void> {
    let x: number;
    let y: number;
    if (input.ref) {
      if (input.x !== undefined || input.y !== undefined)
        throw new Error("Click accepts either ref or x/y coordinates.");
      const node = await this.reference(tabId, input.ref);
      await this.cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId });
      const box = record(
        record(await this.cdp(tabId, "DOM.getBoxModel", { backendNodeId: node.backendNodeId }))
          .model,
      );
      const quad = box.content as number[];
      if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) {
        throw new Error(
          "Element has no visible box; take a new snapshot or use screenshot coordinates.",
        );
      }
      const [x1, y1, x2, y2, x3, y3, x4, y4] = quad as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      x = (x1 + x2 + x3 + x4) / 4;
      y = (y1 + y2 + y3 + y4) / 4;
    } else {
      x = finiteCoordinate(input.x, "x");
      y = finiteCoordinate(input.y, "y");
    }
    await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  private async fill(tabId: number, ref: string, text: string): Promise<void> {
    const node = await this.reference(tabId, ref);
    // The extension owns this fixed editing implementation; no caller JavaScript
    // is needed for fill even when a domain policy disables arbitrary evaluation.
    await this.transport.request("page.fill", { tabId, backendNodeId: node.backendNodeId, text });
  }

  private async press(tabId: number, shortcut: string): Promise<void> {
    if (typeof shortcut !== "string" || !shortcut.length)
      throw new Error("key must be a key name or shortcut such as Enter or Control+a.");
    const parts = shortcut.split("+");
    const rawKey = parts.pop();
    if (!rawKey) throw new Error("Keyboard shortcut must end with a key name.");
    const modifierFlags: Record<string, number> = {
      alt: 1,
      control: 2,
      ctrl: 2,
      meta: 4,
      command: 4,
      cmd: 4,
      shift: 8,
    };
    let modifiers = 0;
    for (const part of parts) {
      const flag = modifierFlags[part.toLowerCase()];
      if (!flag) throw new Error(`Unknown keyboard modifier ${part}.`);
      modifiers |= flag;
    }
    const special: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
      enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
      tab: { key: "Tab", code: "Tab", keyCode: 9 },
      escape: { key: "Escape", code: "Escape", keyCode: 27 },
      esc: { key: "Escape", code: "Escape", keyCode: 27 },
      backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      delete: { key: "Delete", code: "Delete", keyCode: 46 },
      space: { key: " ", code: "Space", keyCode: 32, text: " " },
      arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
      arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      home: { key: "Home", code: "Home", keyCode: 36 },
      end: { key: "End", code: "End", keyCode: 35 },
      pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
      pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
    };
    let key = special[rawKey.toLowerCase()];
    if (!key && [...rawKey].length === 1) {
      const code = /^[a-z]$/i.test(rawKey)
        ? `Key${rawKey.toUpperCase()}`
        : /^\d$/.test(rawKey)
          ? `Digit${rawKey}`
          : rawKey === " "
            ? "Space"
            : "";
      key = { key: rawKey, code, keyCode: rawKey.toUpperCase().charCodeAt(0), text: rawKey };
    }
    if (!key)
      throw new Error(`Unsupported key ${rawKey}; use a standard key name or single character.`);
    const event = {
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
      modifiers,
    };
    // CDP key events do not run macOS native key bindings. Explicit Blink editing
    // commands are needed for shortcuts such as Command+A to change selection.
    const primaryModifier = this.isMac ? 4 : 2;
    const shifted = (modifiers & 8) !== 0;
    let command: string | undefined;
    if (modifiers === primaryModifier || modifiers === (primaryModifier | 8)) {
      const character = rawKey.toLowerCase();
      if (character === "z") command = shifted ? "redo" : "undo";
      else if (!shifted) {
        const editingCommands: Record<string, string> = {
          a: "selectAll",
          c: "copy",
          v: "paste",
          x: "cut",
          ...(!this.isMac ? { y: "redo" } : {}),
        };
        command = editingCommands[character];
      }
    }
    const text = (modifiers & 7) === 0 ? key.text : undefined;
    await this.cdp(tabId, "Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      ...event,
      ...(command ? { commands: [command] } : {}),
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await this.cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...event });
  }

  private async screenshot(tabId: number): Promise<unknown> {
    const remaining = MAX_RUN_IMAGE_CHARS - this.mediaCharsUsed;
    const imageBudget = Math.min(MAX_INLINE_IMAGE_CHARS, remaining);
    if (imageBudget <= IMAGE_DATA_URL_PREFIX.length) {
      throw new Error("The inline screenshot budget for this model run is exhausted.");
    }
    let viewport: { x: number; y: number; width: number; height: number } | undefined;
    for (const scale of SCREENSHOT_SCALES) {
      if (scale !== 1 && !viewport) {
        const raw = record(await this.readPage(tabId, "viewport"));
        viewport = {
          x: finiteCoordinate(raw.scrollX, "viewport scrollX"),
          y: finiteCoordinate(raw.scrollY, "viewport scrollY"),
          width: finiteCoordinate(raw.width, "viewport width"),
          height: finiteCoordinate(raw.height, "viewport height"),
        };
        if (viewport.width <= 0 || viewport.height <= 0) {
          throw new Error("Chrome returned an empty screenshot viewport.");
        }
      }
      const result = record(
        await this.cdp(tabId, "Page.captureScreenshot", {
          format: "jpeg",
          quality: 70,
          captureBeyondViewport: false,
          ...(viewport ? { clip: { ...viewport, scale } } : {}),
        }),
      );
      if (typeof result.data !== "string" || result.data.length === 0) {
        throw new Error("Chrome did not return screenshot data.");
      }
      const encodedLength = IMAGE_DATA_URL_PREFIX.length + result.data.length;
      if (encodedLength <= imageBudget) {
        this.mediaCharsUsed += encodedLength;
        return [
          {
            type: "input_image",
            image_url: `${IMAGE_DATA_URL_PREFIX}${result.data}`,
            filename: "browser.jpg",
          },
        ];
      }
    }
    if (remaining < MAX_INLINE_IMAGE_CHARS) {
      throw new Error(
        "Screenshot cannot fit the remaining inline image budget for this model run.",
      );
    }
    throw new Error("Screenshot remains too large for inline image output after six captures.");
  }

  execute(input: BrowserAction): Promise<unknown> {
    // A model may emit several calls at once. Browser state and element refs are sequential.
    const operation = this.tail.then(() => this.dispatch(input));
    this.tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  private async dispatch(input: BrowserAction): Promise<unknown> {
    if (input.action === "tabs") return this.transport.request("tabs.list");
    if (input.action === "open") {
      const url = validateBrowserUrl(input.url);
      const tab = record(await this.transport.request("tabs.create", { url }));
      const tabId = Number(tab.id);
      requireTabId(tabId);
      await this.waitReady(tabId, { nonBlank: url !== "about:blank" });
      return this.snapshot(tabId);
    }
    const tabId = requireTabId(input.tabId);
    switch (input.action) {
      case "activate":
        return this.transport.request("tabs.activate", { tabId });
      case "close": {
        this.documents.delete(tabId);
        return this.transport.request("tabs.close", { tabId });
      }
      case "snapshot":
        return this.snapshot(tabId, input.maxChars);
      case "navigate": {
        this.documents.delete(tabId);
        const result = record(
          await this.cdp(tabId, "Page.navigate", { url: validateBrowserUrl(input.url) }),
        );
        if (result.errorText) throw new Error(String(result.errorText));
        await this.waitReady(tabId, {
          loaderId: typeof result.loaderId === "string" ? result.loaderId : undefined,
        });
        return this.snapshot(tabId);
      }
      case "back":
      case "forward": {
        const history = record(await this.cdp(tabId, "Page.getNavigationHistory"));
        const index = Number(history.currentIndex) + (input.action === "back" ? -1 : 1);
        const entry = Array.isArray(history.entries)
          ? (history.entries[index] as RecordValue | undefined)
          : undefined;
        if (!entry) throw new Error(`No ${input.action} history entry.`);
        this.documents.delete(tabId);
        await this.cdp(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
        await this.waitReady(tabId, { url: typeof entry.url === "string" ? entry.url : undefined });
        return this.snapshot(tabId);
      }
      case "reload": {
        const previousDocumentId = this.documentId(await this.reloadNavigationFrame(tabId));
        this.documents.delete(tabId);
        await this.cdp(tabId, "Page.reload");
        // The reload acknowledgement can arrive before the old child frames are
        // gone. Wait for a new main loader before reading the guarded frame tree.
        const deadline = Date.now() + 10000;
        while (true) {
          const frame = await beforeDeadline(this.reloadNavigationFrame(tabId), deadline);
          if (this.documentId(frame) !== previousDocumentId) break;
          if (Date.now() >= deadline)
            throw new Error("Reload did not start a new document within 10 seconds.");
          await delay(Math.min(100, Math.max(1, deadline - Date.now())));
        }
        await this.waitReady(tabId, { previousDocumentId });
        return this.snapshot(tabId);
      }
      case "click":
        await this.click(tabId, input);
        return { tabId, clicked: true };
      case "fill":
        await this.fill(tabId, input.ref, input.text);
        return { tabId, filled: true };
      case "press":
        await this.press(tabId, input.key);
        return { tabId, pressed: input.key };
      case "scroll": {
        const deltaX = finiteCoordinate(input.x, "x");
        const deltaY = finiteCoordinate(input.y, "y");
        const viewport = record(await this.readPage(tabId, "viewport"));
        const width = finiteCoordinate(viewport.width, "viewport width");
        const height = finiteCoordinate(viewport.height, "viewport height");
        await this.cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: width / 2,
          y: height / 2,
          deltaX,
          deltaY,
        });
        return { tabId, scrolled: true };
      }
      case "screenshot":
        return this.screenshot(tabId);
      case "evaluate":
        return this.evaluate(tabId, input.expression);
      case "wait": {
        const timeoutMs = input.timeoutMs ?? 10000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
          throw new Error("timeoutMs must be an integer between 1 and 30000.");
        const expression = input.expression;
        const deadline = Date.now() + timeoutMs;
        let lastError: unknown;
        do {
          try {
            if (
              await beforeDeadline(
                expression === undefined
                  ? this.readPage(tabId, "readyState").then((value) => value === "complete")
                  : this.evaluate(tabId, expression, deadline - Date.now()),
                deadline,
              )
            )
              return { tabId, matched: true };
          } catch (error) {
            if (isPolicyError(error)) throw error;
            lastError = error;
          }
          await delay(Math.min(100, Math.max(1, deadline - Date.now())));
        } while (Date.now() < deadline);
        throw new Error(
          `Wait predicate did not become true within ${timeoutMs}ms${lastError ? `: ${errorText(lastError)}` : "."}`,
        );
      }
    }
  }
}
