import type { Envelope, Handler, ServiceDeps, Topic } from "@sudsnik/contracts";
import { ok, type Result } from "@sudsnik/kernel";

/**
 * Hollow billing keeps no ledger, so an event it consumes is acknowledged and dropped. That is the degraded path
 * the judge accepts: settlement is only judged while `billing.enabled` is on (`apps/sim/src/judge.ts`).
 */
export class HollowConsumer implements Handler {
  constructor(readonly topic: Topic) {}

  async handle(_envelope: Envelope, _deps: ServiceDeps): Promise<Result<void>> {
    return ok(undefined);
  }
}
