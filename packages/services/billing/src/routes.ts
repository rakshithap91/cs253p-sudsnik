import { z } from "zod";
import { IdSchema, IdempotencyHeaders } from "@sudsnik/contracts";
import { Charge, LedgerEntry, LedgerFilter, Quote, routes as spec } from "@sudsnik/contracts/services/billing";
import { sendResult, type App } from "@sudsnik/infra-http";
import type { BillingAppService } from "./service.js";

const OrderParams = z.object({ orderId: IdSchema });

export function registerRoutes(app: App, service: BillingAppService): void {
  const prefixes = ["", "/v2"] as const;
  for (const prefix of prefixes) {
    app.get(prefix + spec.quote.path, { schema: { params: OrderParams, response: { 200: Quote } } }, async (req, reply) =>
      sendResult(reply, await service.quote(req.params.orderId, req.ctx)),
    );
    app.post(
      prefix + spec.authorize.path,
      { schema: { headers: IdempotencyHeaders, body: spec.authorize.body, response: { 201: Charge } } },
      async (req, reply) => sendResult(reply, await service.authorize(req.body.orderId, req.body.amount, req.ctx), 201),
    );
    app.post(prefix + spec.capture.path, { schema: { headers: IdempotencyHeaders, params: OrderParams, response: { 200: Charge } } }, async (req, reply) =>
      sendResult(reply, await service.capture(req.params.orderId, req.ctx)),
    );
    app.post(prefix + spec.refund.path, { schema: { headers: IdempotencyHeaders, params: OrderParams, response: { 200: Charge } } }, async (req, reply) =>
      sendResult(reply, await service.refund(req.params.orderId, req.ctx)),
    );
    app.get(prefix + spec.ledger.path, { schema: { querystring: LedgerFilter, response: { 200: z.array(LedgerEntry) } } }, async (req, reply) =>
      sendResult(reply, await service.ledger(req.query, req.ctx)),
    );
    app.post(
      prefix + spec.paymentsWebhook.path,
      { schema: { body: spec.paymentsWebhook.body, response: { 200: spec.paymentsWebhook.response } }, config: { infra: true } },
      async (req, reply) => sendResult(reply, await service.paymentsWebhook(req.body, req.ctx)),
    );
  }
}
