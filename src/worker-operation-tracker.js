// Observability only: arguments, responses, credentials and URLs are never retained.
export class OperationTracker {
  constructor(now = () => Date.now()) { this.now = now; this.active = new Map(); this.sequence = 0; }
  snapshot() { return [...this.active.values()].map(x => ({ operation: x.operation, elapsedMs: this.now() - x.startedAt })); }
  wrap(target, name) {
    const tracker = this, methods = new Map();
    return new Proxy(target, { get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      if (!methods.has(property)) methods.set(property, function(...args) {
        const id = ++tracker.sequence;
        tracker.active.set(id, { operation: name + '.' + String(property), startedAt: tracker.now() });
        try {
          const result = value.apply(object, args);
          if (result && typeof result.then === 'function') return Promise.resolve(result).catch(error => { if (error && typeof error === 'object') error.operation ??= name + '.' + String(property); throw error; }).finally(() => tracker.active.delete(id));
          tracker.active.delete(id); return result;
        } catch (error) { tracker.active.delete(id); throw error; }
      });
      return methods.get(property);
    } });
  }
}
