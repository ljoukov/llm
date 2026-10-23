/** Redact known credential values at logging sinks, including late-loaded env values. */
function knownSecrets(): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (
      !/api.?key|token|password|secret|credential|private.?key|service.?account|cookie/iu.test(
        name,
      ) ||
      typeof value !== "string" ||
      value.length < 8
    ) {
      continue;
    }
    values.add(value);
    values.add(JSON.stringify(value).slice(1, -1));
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function redactLogSecrets(value: string): string {
  let text = value;
  for (const secret of knownSecrets()) {
    text = text.split(secret).join("[REDACTED]");
  }
  return text;
}

function safeChunk(value: string, final: boolean): { text: string; tail: string } {
  const text = redactLogSecrets(value);
  let keep = 0;
  for (const secret of knownSecrets()) {
    for (let length = Math.min(secret.length - 1, text.length); length > keep; length--) {
      if (text.endsWith(secret.slice(0, length))) {
        keep = length;
        break;
      }
    }
  }
  const safe = text.slice(0, text.length - keep);
  // Single letters and short words are not useful credential fragments. Preserve
  // them at close rather than corrupting ordinary text such as a proof ending in s.
  if (final && keep < 8) {
    return { text, tail: "" };
  }
  return final
    ? { text: safe + (keep > 0 ? "[REDACTED_PARTIAL_SECRET]" : ""), tail: "" }
    : { text: safe, tail: text.slice(text.length - keep) };
}

export function redactFinalLogText(value: string): string {
  return safeChunk(value, true).text;
}

/** Keep a possible credential prefix private until its next chunk or terminal close. */
export function createLogTextRedactor(): (value: string, final?: boolean) => string {
  let tail = "";
  return (value, final = false) => {
    const next = safeChunk(tail + value, final);
    tail = next.tail;
    return next.text;
  };
}
