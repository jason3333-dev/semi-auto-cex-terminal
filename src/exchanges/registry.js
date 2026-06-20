import { MememaxOrderlyAdapter } from "./mememax-orderly.js";
import { assertAdapterShape, ExchangeError } from "./types.js";

const registry = new Map();

export function registerExchange(adapter) {
  assertAdapterShape(adapter);
  registry.set(adapter.id, adapter);
}

registerExchange(new MememaxOrderlyAdapter());

export function listExchanges() {
  return Array.from(registry.values()).map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    modes: adapter.modes
  }));
}

export function getExchange(id) {
  const adapter = registry.get(id);
  if (!adapter) {
    throw new ExchangeError(`Unsupported exchange "${id}"`);
  }
  return adapter;
}
