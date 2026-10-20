import type { ServiceDeps } from "@sudsnik/contracts";
import { createOutbox, registerHandlers } from "@sudsnik/infra-queue";
import { baseApp } from "../../app.js";
import { openBillingDb } from "../../db.js";
import { registerRoutes } from "../../routes.js";
import { bindRuntime } from "../../runtime.js";
import { BillingRepository } from "../../repository.js";
import { createBillingService } from "../../service.js";

export const variant = "real";

export async function createApp(deps: ServiceDeps) {
  const app = await baseApp(deps, variant);
  const db = openBillingDb(deps);
  const outbox = createOutbox(db, deps.bus);
  const repo = new BillingRepository(db);
  const service = createBillingService(deps, repo, outbox);
  bindRuntime(deps, service);
  registerRoutes(app, service);
  app.sudsnik.registerStop(() => db.close());
  app.sudsnik.registerStop(() => outbox.stop());
  for (const h of await registerHandlers(deps)) app.sudsnik.registerStop(h.stop);
  outbox.start();
  app.sudsnik.setReady(true);
  return app;
}
