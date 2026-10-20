import {
  DEFAULT_CURRENCY,
  EXPECTED_CYCLE_UNITS,
  makeEnvelope,
  payloadSchemas,
  serviceUrlVar,
  type Ctx,
  type Envelope,
  type ServiceDeps,
} from "@sudsnik/contracts";
import type { PaymentsWebhook } from "@sudsnik/contracts/mocks/payments";
import type { BillingService, Charge, LedgerEntry, LedgerFilter, Quote } from "@sudsnik/contracts/services/billing";
import type { Outbox } from "@sudsnik/infra-queue";
import { err, newId, ok, sudsnikError, type Result } from "@sudsnik/kernel";
import { quoteMinor, priceMinor, washBaseMinor, type PricingTier } from "./pricing.js";
import { BillingRepository } from "./repository.js";
import type { BillingRuntime } from "./runtime.js";

export function createBillingService(deps: ServiceDeps, repo: BillingRepository, outbox: Outbox): BillingService & BillingRuntime {
  const payments = deps.clients.payments;
  const callbackUrl = `${String(deps.env[serviceUrlVar("billing")] ?? "").replace(/\/$/, "")}/callbacks`;

  function now(): number {
    return deps.clock.now();
  }

  function operatorOf(tenantId: string) {
    return repo.operator(tenantId) ?? { tenantId, pricingTier: "standard" as PricingTier, region: "us", currency: DEFAULT_CURRENCY };
  }

  function payCtx(orderId: string, ctx: Ctx, kind: "authorize" | "capture" | "refund"): Ctx {
    return { tenantId: ctx.tenantId, correlationId: ctx.correlationId, idempotencyKey: `${kind}-${orderId}` };
  }

  function append(kind: LedgerEntry["kind"], charge: Charge, amount: number, at: number, ref?: string): boolean {
    return repo.insertLedger({
      entryId: newId(),
      tenantId: charge.tenantId,
      orderId: charge.orderId,
      kind,
      amount,
      currency: charge.currency,
      at,
      ...(ref ? { ref } : {}),
    });
  }

  function enqueueCaptured(charge: Charge, cause: { correlationId: string; causationId?: string }): void {
    outbox.enqueue(
      makeEnvelope({
        topic: "charge.captured",
        tenantId: charge.tenantId,
        occurredAt: charge.updatedAt,
        correlationId: cause.correlationId,
        ...(cause.causationId ? { causationId: cause.causationId } : {}),
        payload: { orderId: charge.orderId, chargeId: charge.chargeId, amount: charge.amount, currency: charge.currency },
      }),
    );
  }

  function enqueueFailed(orderId: string, tenantId: string, reason: string, cause: { correlationId: string; causationId?: string }): void {
    outbox.enqueue(
      makeEnvelope({
        topic: "charge.failed",
        tenantId,
        occurredAt: now(),
        correlationId: cause.correlationId,
        ...(cause.causationId ? { causationId: cause.causationId } : {}),
        payload: { orderId, reason },
      }),
    );
  }

  function enqueueRefunded(charge: Charge, refundId: string, amount: number, cause: { correlationId: string }): void {
    outbox.enqueue(
      makeEnvelope({
        topic: "refund.issued",
        tenantId: charge.tenantId,
        occurredAt: charge.updatedAt,
        correlationId: cause.correlationId,
        payload: { orderId: charge.orderId, refundId, amount, currency: charge.currency },
      }),
    );
  }

  function settleCaptured(charge: Charge, amount: number, currency: string, cause: { correlationId: string; causationId?: string }): Charge {
    if (charge.state === "captured") return charge;
    const next: Charge = { ...charge, amount, currency, state: "captured", updatedAt: now() };
    repo.saveCharge(next);
    if (append("capture", next, amount, next.updatedAt, next.paymentRef)) enqueueCaptured(next, cause);
    return next;
  }

  const service: BillingService & BillingRuntime = {
    async quote(orderId, ctx) {
      const op = operatorOf(ctx.tenantId);
      const amount = quoteMinor(op.pricingTier, op.currency);
      const q: Quote = {
        orderId,
        amount,
        currency: op.currency,
        breakdown: { base: washBaseMinor(op.pricingTier, op.currency), cycleUnits: EXPECTED_CYCLE_UNITS, tier: op.pricingTier },
      };
      return ok(q);
    },

    async authorize(orderId, amount, ctx) {
      const existing = repo.chargeForOrder(ctx.tenantId, orderId);
      if (existing) return ok(existing);
      const op = operatorOf(ctx.tenantId);
      const paid = await payments.authorize(
        { orderId, amount, currency: op.currency, callbackUrl },
        payCtx(orderId, ctx, "authorize"),
      );
      if (!paid.ok) return paid;
      const at = now();
      const charge: Charge = {
        chargeId: newId(),
        tenantId: ctx.tenantId,
        orderId,
        amount: paid.value.amount,
        currency: paid.value.currency,
        state: "authorized",
        paymentRef: paid.value.paymentRef,
        updatedAt: at,
      };
      repo.transaction(() => {
        repo.touchOrder(orderId, ctx.tenantId);
        repo.insertCharge(charge);
        append("authorize", charge, charge.amount, at, charge.paymentRef);
      });
      return ok(charge);
    },

    async capture(orderId, ctx) {
      const charge = repo.chargeForOrder(ctx.tenantId, orderId);
      if (!charge) return err(sudsnikError("NOT_FOUND", `no charge for ${orderId}`));
      if (charge.state === "captured") return ok(charge);
      if (charge.state !== "authorized" || !charge.paymentRef) return err(sudsnikError("CONFLICT", `charge is ${charge.state}`));
      const order = repo.order(orderId);
      const op = operatorOf(ctx.tenantId);
      const units = order?.cycleUnits ?? EXPECTED_CYCLE_UNITS;
      const wanted = Math.min(priceMinor(op.pricingTier, charge.currency, units), charge.amount);
      const paid = await payments.capture(charge.paymentRef, wanted, payCtx(orderId, ctx, "capture"));
      if (!paid.ok) {
        if (!paid.error.retryable) {
          repo.transaction(() => {
            repo.saveCharge({ ...charge, state: "failed", updatedAt: now() });
            enqueueFailed(orderId, ctx.tenantId, paid.error.message, { correlationId: ctx.correlationId });
          });
        }
        return paid;
      }
      const settled = repo.transaction(() => settleCaptured(charge, paid.value.amount, paid.value.currency, { correlationId: ctx.correlationId }));
      return ok(settled);
    },

    async refund(orderId, ctx) {
      const charge = repo.chargeForOrder(ctx.tenantId, orderId);
      if (!charge) return err(sudsnikError("NOT_FOUND", `no charge for ${orderId}`));
      if (charge.state === "refunded") return ok(charge);
      const at = now();
      const next: Charge = { ...charge, amount: 0, state: "refunded", updatedAt: at };
      repo.transaction(() => {
        repo.saveCharge(next);
        append("refund", next, 0, at, next.paymentRef);
        enqueueRefunded(next, newId(), 0, { correlationId: ctx.correlationId });
      });
      return ok(next);
    },

    async ledger(filter: LedgerFilter, ctx) {
      return ok(repo.listLedger(ctx.tenantId, filter));
    },

    async applyEvent(envelope: Envelope): Promise<Result<void>> {
      const parsed = payloadSchemas[envelope.topic].safeParse(envelope.payload);
      if (!parsed.success) return err(sudsnikError("INVALID", `bad ${envelope.topic} payload: ${parsed.error.message}`));
      const at = envelope.occurredAt;
      if (envelope.topic === "operator.updated") {
        if (!repo.claimEnvelope(envelope.id, envelope.topic, at)) return ok(undefined);
        const p = parsed.data as { operatorId: string; pricingTier: PricingTier; region: string; currency: string };
        repo.upsertOperator({ tenantId: p.operatorId, pricingTier: p.pricingTier, region: p.region, currency: p.currency });
        return ok(undefined);
      }
      if (envelope.topic === "wash.completed") {
        const p = parsed.data as { orderId: string; cycleUnits: number };
        if (!repo.claimEnvelope(envelope.id, envelope.topic, at)) return ok(undefined);
        repo.setCycleUnits(p.orderId, envelope.tenantId, p.cycleUnits);
        const order = repo.order(p.orderId);
        if (order?.returned) {
          const captured = await service.capture(p.orderId, { tenantId: envelope.tenantId, correlationId: envelope.correlationId, idempotencyKey: `capture-${p.orderId}` });
          if (!captured.ok && captured.error.retryable) return captured;
        }
        return ok(undefined);
      }
      if (envelope.topic === "order.returned") {
        const p = parsed.data as { orderId: string };
        repo.markReturned(p.orderId, envelope.tenantId);
        const captured = await service.capture(p.orderId, { tenantId: envelope.tenantId, correlationId: envelope.correlationId, idempotencyKey: `capture-${p.orderId}` });
        if (!captured.ok && captured.error.retryable) return captured;
        repo.claimEnvelope(envelope.id, envelope.topic, at);
        return ok(undefined);
      }
      return ok(undefined);
    },
  };

  return Object.assign(service, {
    async paymentsWebhook(body: PaymentsWebhook, ctx: Ctx): Promise<Result<{ accepted: boolean; duplicate: boolean }>> {
      return repo.transaction(() => {
        if (!repo.claimWebhook(body.id, body.atMs)) return ok({ accepted: true, duplicate: true });
        const charge = repo.chargeByPaymentRef(body.paymentRef) ?? repo.chargeForOrder(ctx.tenantId || body.orderId, body.orderId);
        if (!charge) return ok({ accepted: true, duplicate: false });
        const cause = { correlationId: ctx.correlationId, causationId: body.id };
        if (body.event === "captured") settleCaptured(charge, body.amount, body.currency, cause);
        else if (body.event === "refunded") {
          if (charge.state !== "refunded") {
            const next: Charge = { ...charge, amount: body.amount, currency: body.currency, state: "refunded", updatedAt: now() };
            repo.saveCharge(next);
            if (append("refund", next, body.amount, next.updatedAt, next.paymentRef)) enqueueRefunded(next, newId(), body.amount, cause);
          }
        } else if (body.event === "failed" && charge.state !== "failed") {
          repo.saveCharge({ ...charge, state: "failed", updatedAt: now() });
          enqueueFailed(charge.orderId, charge.tenantId, "payments webhook failed", cause);
        }
        return ok({ accepted: true, duplicate: false });
      });
    },
  });
}

export type BillingAppService = ReturnType<typeof createBillingService>;
