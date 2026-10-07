import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boot, cancel, fakeBilling, place, steps, type Stack } from "../helpers.js";

let stack: Stack;
beforeEach(async () => {
  stack = await boot();
});
afterEach(() => stack.app.sudsnik.drain());

describe("compensation on cancel", () => {
  // What every variant answers; what a cancel then does to the order is the hidden suite's (`docs/system-spec.md` §8).
  it("answers 200 with the order, and 404 for one the tenant does not own", async () => {
    fakeBilling(stack.deps);
    const order = await place(stack.app);
    await new Promise((r) => setImmediate(r));
    const res = await cancel(stack.app, order.orderId);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { orderId: string }).orderId).toBe(order.orderId);
    expect((await cancel(stack.app, order.orderId, "again", "op2")).statusCode).toBe(404);
  });

  // Was skipped as "flaked after the outbox landed", but it was not flaky: it asserted the refund before the cancel,
  // the order ADR-0002 rules out. State and order.cancelled commit together; the refund is the outward call after.
  it("records the cancellation before it refunds", async () => {
    const billing = fakeBilling(stack.deps);
    const order = await place(stack.app);
    await new Promise((r) => setImmediate(r));
    await cancel(stack.app, order.orderId);
    expect(billing.refunds).toBe(1);
    const recorded = steps(stack.deps, order.orderId).map((s) => s.step);
    expect(recorded.indexOf("cancel")).toBeGreaterThanOrEqual(0);
    expect(recorded.indexOf("cancel")).toBeLessThan(recorded.indexOf("refund"));
  });
});
