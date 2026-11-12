import { EnvHttpProxyAgent } from "undici";

import { getRuntimeSingleton } from "./runtimeSingleton.js";

const state = getRuntimeSingleton(Symbol.for("@ljoukov/llm.proxyFetchState"), () => ({
  dispatcher: undefined as EnvHttpProxyAgent | undefined,
}));

/** Honor HTTP(S)_PROXY and NO_PROXY for native REST endpoints, including Node 22. */
export const proxyFetch: typeof fetch = (input, init) => {
  state.dispatcher ??= new EnvHttpProxyAgent({
    bodyTimeout: 15 * 60_000,
    headersTimeout: 15 * 60_000,
  });
  const options = { ...init, dispatcher: state.dispatcher };
  // Node's bundled undici-types and the installed undici package can differ in version.
  return fetch(input, options as unknown as Parameters<typeof fetch>[1]);
};
