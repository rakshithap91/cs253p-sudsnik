import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  at: integer("at").notNull(),
});

export const consumed = sqliteTable("consumed", {
  envelopeId: text("envelope_id").primaryKey(),
  topic: text("topic").notNull(),
  at: integer("at").notNull(),
});

export const operators = sqliteTable("operators", {
  tenantId: text("tenant_id").primaryKey(),
  pricingTier: text("pricing_tier").notNull(),
  region: text("region").notNull(),
  currency: text("currency").notNull(),
});

export const orders = sqliteTable("orders", {
  orderId: text("order_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  cycleUnits: integer("cycle_units"),
  returned: integer("returned").notNull(),
});

export const charges = sqliteTable("charges", {
  chargeId: text("charge_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  orderId: text("order_id").notNull(),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  state: text("state").notNull(),
  paymentRef: text("payment_ref"),
  updatedAt: integer("updated_at").notNull(),
});

export const ledger = sqliteTable(
  "ledger",
  {
    entryId: text("entry_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    orderId: text("order_id").notNull(),
    kind: text("kind").notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    at: integer("at").notNull(),
    ref: text("ref"),
  },
  (t) => [uniqueIndex("ledger_kind_with_ref").on(t.tenantId, t.orderId, t.kind)],
);

export type ChargeRow = typeof charges.$inferSelect;
export type LedgerRow = typeof ledger.$inferSelect;
