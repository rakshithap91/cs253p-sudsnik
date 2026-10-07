import type { Ctx } from "@sudsnik/contracts";
import { CANCELLABLE_STATES, type Order } from "@sudsnik/contracts/services/orders";
import { err, ok, sudsnikError, type Result } from "@sudsnik/kernel";
import { COMPENSATION, ORIGIN, OrdersService } from "../../core/OrdersService.js";

/**
 * Cancel on the customer's word (system-spec §9.3, issue #859). State, `cancel` step, and `order.cancelled` commit
 * in one transaction through the same `cancelInPlace` the system cancel uses; the refund runs after the commit and
 * records its own outcome, so a crash in between leaves a refund for reconciliation, never an unrecorded one (ADR-0002).
 */
export class CompensatingOrdersService extends OrdersService {
  async cancel(orderId: string, reason: string, ctx: Ctx): Promise<Result<Order>> {
    const cancelled = this.inTransaction((): Result<{ order: Order; refund: boolean }> => {
      // Read inside the transaction, so the state checked is the state written over.
      const order = this.find(ctx.tenantId, orderId);
      if (!order) return err(sudsnikError("NOT_FOUND", `no order ${orderId}`));
      if (!CANCELLABLE_STATES.includes(order.state)) return err(sudsnikError("CONFLICT", `order ${orderId} is ${order.state} and cannot be cancelled`));
      const compensations = this.cancelInPlace(order, reason, ORIGIN.customer, { correlationId: ctx.correlationId });
      return ok({ order, refund: compensations.includes(COMPENSATION.refund) });
    });
    if (!cancelled.ok) return cancelled;
    if (cancelled.value.refund) await this.refundFor(cancelled.value.order, ctx.correlationId);
    return this.get(orderId, ctx);
  }
}
