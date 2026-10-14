import { fileURLToPath } from "node:url";
import { bootService } from "@sudsnik/infra-boot";
import { readEnv } from "./env.js";
import { createApp } from "./variants/hollow/index.js";

export const service = "billing" as const;
/** Every variant consumes the same three topics, so all of them share this handlers directory. */
export const handlersDir = fileURLToPath(new URL("./handlers/", import.meta.url));

export { readEnv };
export * from "./variants/hollow/index.js";
export type { BillingService } from "./port.js";

export function start(): Promise<{ port: number; close(): Promise<void> }> {
  return bootService({ service, readEnv, createApp, handlersDir });
}
