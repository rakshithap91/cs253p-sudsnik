import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { declaredTopics, IDEMPOTENCY_HEADER, TENANT_HEADER } from "@sudsnik/contracts";
import { routes } from "@sudsnik/contracts/services/billing";
import { fakeDeps, type FakeDeps } from "@sudsnik/contracts/testing";
import { createApp, handlersDir } from "../../src/index.js";

/**
 * The contract gate for billing, written out rather than run through `contractSuite`: that suite treats any 5xx as a
 * defect, and hollow answers 501 by design (ADR-0008). The 501 shape is pinned in test/public/hollow.test.ts.
 */
const paths: Record<string, string> = {
  quote: "/quotes/order1",
  authorize: "/charges/authorize",
  capture: "/charges/order1/capture",
  refund: "/charges/order1/refund",
  ledger: "/ledger",
  paymentsWebhook: "/callbacks/payments",
};
const validBodies: Record<string, object> = {
  authorize: { orderId: "order1", amount: 5260 },
  paymentsWebhook: { id: "wh1", paymentRef: "pay1", orderId: "order1", event: "captured", amount: 5260, currency: "USD", atMs: 1000 },
};

describe("billing contract", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let deps: FakeDeps;
  beforeAll(async () => {
    deps = fakeDeps("00000000c0ffee00", "billing", { handlersDir });
    app = await createApp(deps);
  });
  afterAll(() => app.sudsnik.drain());

  const specs = Object.entries(routes as Record<string, { method: "GET" | "POST"; path: string; body?: unknown }>);
  const isCallback = (path: string) => path.startsWith("/callbacks/");

  it("serves /health, /ready, /cost, /version", async () => {
    expect((await app.inject("/health")).statusCode).toBe(200);
    expect((await app.inject("/ready")).statusCode).toBe(200);
    expect(((await app.inject("/cost")).json() as { service: string }).service).toBe("billing");
    expect(((await app.inject("/version")).json() as { service: string }).service).toBe("billing");
  });

  it("rejects requests without a tenant, except callbacks", async () => {
    for (const [name, r] of specs) {
      if (isCallback(r.path)) continue;
      const res = await app.inject({ method: r.method, url: paths[name]!, payload: validBodies[name] });
      expect(res.statusCode, name).toBe(401);
    }
  });

  it("rejects writes without an idempotency key, except callbacks", async () => {
    for (const [name, r] of specs) {
      if (isCallback(r.path) || r.method === "GET") continue;
      const res = await app.inject({ method: r.method, url: paths[name]!, headers: { [TENANT_HEADER]: "op1" }, payload: validBodies[name] });
      expect(res.statusCode, name).toBe(400);
    }
  });

  it("rejects a malformed body on every route with a body schema, callbacks included", async () => {
    for (const [name, r] of specs) {
      if (!r.body) continue;
      const res = await app.inject({
        method: r.method,
        url: paths[name]!,
        headers: { [TENANT_HEADER]: "op1", [IDEMPOTENCY_HEADER]: `bad-${name}` },
        payload: { definitely: "not valid", __n: 1 },
      });
      expect(res.statusCode, name).toBe(400);
    }
  });

  it("has a handler for every topic billing consumes, and for no other", async () => {
    const handled = new Set<string>();
    for (const f of readdirSync(handlersDir).filter((f) => /\.(ts|js)$/.test(f))) {
      const mod = (await import(pathToFileURL(join(handlersDir, f)).href)) as { default?: { topic?: string } };
      if (mod.default?.topic) handled.add(mod.default.topic);
    }
    const consumed = new Set<string>(declaredTopics.billing.consumes);
    expect([...handled].sort()).toEqual([...consumed].sort());
  });

  it("publishes only the topics billing declares", () => {
    const allowed = new Set<string>(declaredTopics.billing.publishes);
    for (const e of deps.bus.published) expect(allowed.has(e.topic), e.topic).toBe(true);
  });
});
