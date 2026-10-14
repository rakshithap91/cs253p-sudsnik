import type { ErrorBody, ServiceDeps } from "@sudsnik/contracts";
import { IdempotencyHeaders, IdSchema } from "@sudsnik/contracts";
import { routes } from "@sudsnik/contracts/services/billing";
import { registerHandlers } from "@sudsnik/infra-queue";
import type { HTTPMethods } from "fastify";
import { z } from "zod";
import { baseApp } from "../../app.js";

export const variant = "hollow";

interface Spec {
  method: HTTPMethods;
  path: string;
  body?: z.ZodType;
  query?: z.ZodType;
  idempotent?: boolean;
}

/** Path parameters of a route pattern, each an id: `/charges/:orderId/capture` names one. */
function paramsOf(path: string): z.ZodType | undefined {
  const names = [...path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
  return names.length === 0 ? undefined : z.object(Object.fromEntries(names.map((n) => [n, IdSchema])));
}

/**
 * Every port route is registered from the contract's schemas, so a malformed request is a 400 before it is a 501.
 * Every route then answers 501 UNAVAILABLE, retryable, and publishes nothing (`docs/system-spec.md` §8 rule 2).
 */
export async function createApp(deps: ServiceDeps) {
  const app = await baseApp(deps, variant);
  const body: ErrorBody = { code: "UNAVAILABLE", message: "billing is hollow", retryable: true };
  const specs: Record<string, Spec> = routes;
  // Each route answers at its v1 path and at the same path under /v2, with the same schema. Callbacks are exempt from
  // tenant and idempotency checks under either prefix, as the base app exempts `/callbacks/` paths.
  for (const r of Object.values(specs)) {
    for (const prefix of ["", "/v2"]) {
      app.route({
        method: r.method,
        url: prefix + r.path,
        config: { infra: r.path.startsWith("/callbacks/") },
        schema: {
          headers: r.idempotent ? IdempotencyHeaders : undefined,
          params: paramsOf(r.path),
          querystring: r.query,
          body: r.body,
        },
        handler: async (_req, reply) => reply.code(501).send(body),
      });
    }
  }
  for (const h of await registerHandlers(deps)) app.sudsnik.registerStop(h.stop);
  app.sudsnik.setReady(true);
  return app;
}
