const runtimeSingletonStoreKey = Symbol.for("@ljoukov/llm.runtimeSingletonStore");

type RuntimeSingletonStore = Map<symbol, unknown>;

type GlobalWithRuntimeSingletonStore = typeof globalThis & {
  [runtimeSingletonStoreKey]?: RuntimeSingletonStore;
};

function getRuntimeSingletonStore(): RuntimeSingletonStore {
  const globalObject = globalThis as GlobalWithRuntimeSingletonStore;
  const existingStore = globalObject[runtimeSingletonStoreKey];
  if (existingStore) {
    return existingStore;
  }
  const store = new Map<symbol, unknown>();
  Object.defineProperty(globalObject, runtimeSingletonStoreKey, {
    value: store,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return store;
}

export function getRuntimeSingleton<T>(key: symbol, create: () => T): T {
  const store = getRuntimeSingletonStore();
  const existingValue = store.get(key);
  if (existingValue !== undefined) {
    return existingValue as T;
  }
  const createdValue = create();
  store.set(key, createdValue);
  return createdValue;
}

export function resetRuntimeSingletonsForTesting(): void {
  const globalObject = globalThis as GlobalWithRuntimeSingletonStore;
  globalObject[runtimeSingletonStoreKey]?.clear();
}
