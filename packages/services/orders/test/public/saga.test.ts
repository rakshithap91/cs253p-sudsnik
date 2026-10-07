import { afterEach, describe, expect, it } from "vitest";
import type { Order } from "@sudsnik/contracts/services/orders";
import { boot, cancel, deliver, driveTo, fakeBilling, getOrder, headers, place, readDb, steps, type Stack } from "../helpers.js";

// Characterization tests for the order saga (Week 1 plan, section 1). Tests 1-5 pin the customer cancel; 6-8 pin
// the system cancel that already works, whose pieces (cancelInPlace, refundFor) the customer cancel shares.

let stack: Stack;
afterEach(() => stack.app.sudsnik.drain());

/** order.cancelled envelopes this order has put in the outbox, published or not. */
function cancelledEvents(order: Order): Array<{ reason: string; origin: string; compensations: string[] }> {
  return readDb(stack.deps, (db) =>
    (db.prepare("select payload from outbox where topic = 'order.cancelled' order by seq").all() as Array<{ payload: string }>)
      .map((r) => JSON.parse(r.payload) as { orderId: string; reason: string; origin: string; compensations: string[] })
      .filter((p) => p.orderId === order.orderId),
  );
}

const pickupFailed = (o: Order) => ({ orderId: o.orderId, podId: o.podId, habitatId: o.habitatId, reason: "no window", attempts: 3 });

describe("customer cancel", () => {
  it("1. cancels a scheduled order and answers 200 with it", async () => {
    stack = await boot({ billing: false });
    const order = await driveTo(stack, await place(stack.app), "scheduled");
    const res = await cancel(stack.app, order.orderId, "crew changed their mind");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orderId: order.orderId, state: "cancelled", cancelReason: "crew changed their mind" });
    expect((await getOrder(stack.app, order.orderId)).state).toBe("cancelled");
  });

  it("2. records a cancel step and puts exactly one order.cancelled, origin customer, in the outbox", async () => {
    stack = await boot({ billing: false });
    const order = await place(stack.app);
    await cancel(stack.app, order.orderId, "not needed");
    expect(steps(stack.deps, order.orderId).map((s) => s.step)).toEqual(["place", "cancel"]);
    expect(cancelledEvents(order)).toEqual([{ orderId: order.orderId, reason: "not needed", origin: "customer", compensations: [] }]);
  });

  it("3. is 404 for another tenant's order and for an unknown id, and changes nothing", async () => {
    stack = await boot({ billing: false });
    const order = await place(stack.app);
    expect((await cancel(stack.app, order.orderId, "x", "op2")).statusCode).toBe(404);
    expect((await cancel(stack.app, "01M3SNH40TNZFG7QZ4C5WW96MZ", "x")).statusCode).toBe(404);
    expect((await getOrder(stack.app, order.orderId)).state).toBe("placed");
    expect(cancelledEvents(order)).toEqual([]);
  });

  it("4. replays the same answer for the same idempotency key, and publishes once", async () => {
    stack = await boot({ billing: false });
    const order = await place(stack.app);
    const h = headers("op1", `cancel-${order.orderId}`);
    const send = () => stack.app.inject({ method: "POST", url: `/orders/${order.orderId}/cancel`, headers: h, payload: { reason: "twice" } });
    const a = await send();
    const b = await send();
    expect(b.statusCode).toBe(a.statusCode);
    expect(b.json()).toEqual(a.json());
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(cancelledEvents(order)).toHaveLength(1);
  });

  it("5. is 409 CONFLICT outside CANCELLABLE_STATES, including an order already cancelled", async () => {
    stack = await boot({ billing: false });
    const washing = await driveTo(stack, await place(stack.app), "washing");
    const res = await cancel(stack.app, washing.orderId);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("CONFLICT");
    expect((await getOrder(stack.app, washing.orderId)).state).toBe("washing");

    const placed = await place(stack.app);
    expect((await cancel(stack.app, placed.orderId)).statusCode).toBe(200);
    expect((await cancel(stack.app, placed.orderId)).statusCode).toBe(409);
    expect(cancelledEvents(placed)).toHaveLength(1);
  });

  it("refunds an authorized order after recording the cancel, and answers with payment refunded", async () => {
    stack = await boot();
    const billing = fakeBilling(stack.deps);
    const order = await place(stack.app);
    const res = await cancel(stack.app, order.orderId);
    expect(res.json()).toMatchObject({ state: "cancelled", payment: "refunded" });
    expect(billing.refunds).toBe(1);
    expect(steps(stack.deps, order.orderId).map((s) => s.step)).toEqual(["place", "authorize", "cancel", "refund"]);
    expect(cancelledEvents(order)[0]?.compensations).toEqual(["refund"]);
  });

  it("leaves the refund pending for reconciliation when billing is unavailable", async () => {
    stack = await boot(); // the default fake billing client fails UNAVAILABLE, which is retryable
    const order = await place(stack.app);
    const res = await cancel(stack.app, order.orderId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "cancelled" });
    expect(steps(stack.deps, order.orderId).map((s) => s.step)).toContain("cancel");
  });
});

describe("system cancel (already working; the customer cancel shares its pieces)", () => {
  it("6. pickup.failed cancels a placed order with origin system and no compensations", async () => {
    stack = await boot({ billing: false });
    const order = await place(stack.app);
    await deliver(stack.deps, "pickup.failed", pickupFailed(order));
    expect((await getOrder(stack.app, order.orderId)).state).toBe("cancelled");
    expect(steps(stack.deps, order.orderId).map((s) => s.step)).toEqual(["place", "pickup.failed", "cancel"]);
    const events = cancelledEvents(order);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ origin: "system", compensations: [] });
  });

  it("7. on an authorized order, records the cancel step before the refund step", async () => {
    stack = await boot();
    const billing = fakeBilling(stack.deps);
    const order = await place(stack.app);
    await deliver(stack.deps, "pickup.failed", pickupFailed(order));
    expect(billing.refunds).toBe(1);
    expect(cancelledEvents(order)[0]?.compensations).toEqual(["refund"]);
    const recorded = steps(stack.deps, order.orderId).map((s) => s.step);
    expect(recorded.indexOf("cancel")).toBeLessThan(recorded.indexOf("refund"));
  });

  it("8. applies a redelivered envelope once", async () => {
    stack = await boot({ billing: false });
    const order = await place(stack.app);
    const envelope = await deliver(stack.deps, "pickup.failed", pickupFailed(order));
    for (const r of await stack.deps.bus.deliver(envelope)) expect(r.ok).toBe(true);
    expect(steps(stack.deps, order.orderId).map((s) => s.step)).toEqual(["place", "pickup.failed", "cancel"]);
    expect(cancelledEvents(order)).toHaveLength(1);
  });
});
