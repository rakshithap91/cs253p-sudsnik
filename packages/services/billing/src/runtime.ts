import type { Envelope, Handler, ServiceDeps, Topic } from "@sudsnik/contracts";
import { err, sudsnikError, type Result } from "@sudsnik/kernel";

export interface BillingRuntime {
  applyEvent(envelope: Envelope): Promise<Result<void>>;
}

const runtimes = new WeakMap<ServiceDeps, BillingRuntime>();

export function bindRuntime(deps: ServiceDeps, runtime: BillingRuntime): void {
  runtimes.set(deps, runtime);
}

export function handlerFor(topic: Topic): Handler {
  return {
    topic,
    async handle(envelope, deps) {
      const rt = runtimes.get(deps);
      if (!rt) return err(sudsnikError("INTERNAL", `billing has no runtime bound for ${topic}`));
      return rt.applyEvent(envelope);
    },
  };
}
