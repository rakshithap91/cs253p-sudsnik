import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDEMPOTENCY_HEADER, TENANT_HEADER } from "@sudsnik/contracts";
import { routes } from "@sudsnik/contracts/services/billing";
import { fakeDeps, type FakeDeps } from "@sudsnik/contracts/testing";
import { createApp, handlersDir } from "../../src/index.js";

const paths: Record<string, string> = {
  quote: "/quotes/order1",
  authorize: "/charges/authorize",
  capture: "/charges/order1/capture",
  refund: "/charges/order1/refund",
  ledger: "/ledger",
  paymentsWebhook: "/callbacks/payments",
};
const payloads: Record<string, unknown> = {
  authorize: { orderId: "order1", amount: 5260 },
  paymentsWebhook: { id: "wh1", paymentRef: "pay1", orderId: "order1", event: "captured", amount: 5260, currency: "USD", atMs: 1000 },
};

describe("hollow billing", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let deps: FakeDeps;
  beforeAll(async () => {
    deps = fakeDeps("00000000c0ffee00", "billing", { handlersDir });
    app = await createApp(deps);
  });
  afterAll(() => app.sudsnik.drain());

  it("serves the infra routes and reports its variant", async () => {
    for (const url of ["/health", "/ready", "/cost", "/version"]) expect((await app.inject(url)).statusCode).toBe(200);
    expect(((await app.inject("/version")).json() as { variant: string }).variant).toBe("hollow");
  });

  it("answers 501 UNAVAILABLE, retryable, on every port route, and publishes nothing", async () => {
    for (const [name, r] of Object.entries(routes)) {
      const res = await app.inject({
        method: r.method,
        url: paths[name]!,
        headers: { [TENANT_HEADER]: "op1", [IDEMPOTENCY_HEADER]: `k-${name}` },
        payload: payloads[name] as object | undefined,
      });
      expect(res.statusCode).toBe(501);
      expect(res.json()).toEqual({ code: "UNAVAILABLE", message: "billing is hollow", retryable: true });
    }
    expect(deps.bus.published.length).toBe(0);
  });

  it("rejects a malformed authorize body with 400, before the hollow answer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/charges/authorize",
      headers: { [TENANT_HEADER]: "op1", [IDEMPOTENCY_HEADER]: "bad-authorize" },
      payload: { definitely: "not valid" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("serves every port route under /v2 too: 501 when valid, 400 when malformed", async () => {
    const specs = routes as Record<string, { method: "GET" | "POST"; path: string; body?: unknown }>;
    for (const [name, r] of Object.entries(specs)) {
      const url = "/v2" + paths[name]!;
      const ok = await app.inject({
        method: r.method,
        url,
        headers: { [TENANT_HEADER]: "op1", [IDEMPOTENCY_HEADER]: `v2-${name}` },
        payload: payloads[name] as object | undefined,
      });
      expect(ok.statusCode, url).toBe(501);
      if (r.body) {
        const bad = await app.inject({
          method: "POST",
          url,
          headers: { [TENANT_HEADER]: "op1", [IDEMPOTENCY_HEADER]: `v2-bad-${name}` },
          payload: { definitely: "not valid" },
        });
        expect(bad.statusCode, url).toBe(400);
      }
    }
  });
});
