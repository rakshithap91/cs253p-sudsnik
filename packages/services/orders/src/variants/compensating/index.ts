import type { ServiceDeps } from "@sudsnik/contracts";
import { composeApp } from "../../core/composeApp.js";
import { CompensatingOrdersService } from "./CompensatingOrdersService.js";

export const variant = "compensating";

export function createApp(deps: ServiceDeps) {
  return composeApp(deps, { variant, service: (parts) => new CompensatingOrdersService(parts.repo, parts.outbox, parts.deps) });
}
