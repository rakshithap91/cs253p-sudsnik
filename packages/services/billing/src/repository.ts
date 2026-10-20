import { and, desc, eq } from "drizzle-orm";
import type { Charge, LedgerEntry, LedgerFilter } from "@sudsnik/contracts/services/billing";
import type { Db } from "@sudsnik/infra-db";
import { charges, consumed, ledger, operators, orders, webhooks, type ChargeRow, type LedgerRow } from "./schema.js";
import type { PricingTier } from "./pricing.js";

export interface OperatorView {
  tenantId: string;
  pricingTier: PricingTier;
  region: string;
  currency: string;
}

export interface OrderView {
  orderId: string;
  tenantId: string;
  cycleUnits: number | null;
  returned: boolean;
}

export class BillingRepository {
  constructor(private readonly db: Db) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  claimWebhook(id: string, at: number): boolean {
    return this.db.orm.insert(webhooks).values({ id, at }).onConflictDoNothing().run().changes === 1;
  }

  claimEnvelope(envelopeId: string, topic: string, at: number): boolean {
    return this.db.orm.insert(consumed).values({ envelopeId, topic, at }).onConflictDoNothing().run().changes === 1;
  }

  upsertOperator(row: OperatorView): void {
    this.db.orm
      .insert(operators)
      .values(row)
      .onConflictDoUpdate({
        target: operators.tenantId,
        set: { pricingTier: row.pricingTier, region: row.region, currency: row.currency },
      })
      .run();
  }

  operator(tenantId: string): OperatorView | undefined {
    const row = this.db.orm.select().from(operators).where(eq(operators.tenantId, tenantId)).get();
    if (!row) return undefined;
    return { tenantId: row.tenantId, pricingTier: row.pricingTier as PricingTier, region: row.region, currency: row.currency };
  }

  touchOrder(orderId: string, tenantId: string): void {
    this.db.orm.insert(orders).values({ orderId, tenantId, cycleUnits: null, returned: 0 }).onConflictDoNothing().run();
  }

  setCycleUnits(orderId: string, tenantId: string, cycleUnits: number): void {
    this.touchOrder(orderId, tenantId);
    this.db.orm.update(orders).set({ cycleUnits }).where(eq(orders.orderId, orderId)).run();
  }

  markReturned(orderId: string, tenantId: string): void {
    this.touchOrder(orderId, tenantId);
    this.db.orm.update(orders).set({ returned: 1 }).where(eq(orders.orderId, orderId)).run();
  }

  order(orderId: string): OrderView | undefined {
    const row = this.db.orm.select().from(orders).where(eq(orders.orderId, orderId)).get();
    if (!row) return undefined;
    return { orderId: row.orderId, tenantId: row.tenantId, cycleUnits: row.cycleUnits, returned: row.returned === 1 };
  }

  insertCharge(charge: Charge): void {
    this.db.orm.insert(charges).values(toChargeRow(charge)).run();
  }

  saveCharge(charge: Charge): void {
    const { chargeId, ...rest } = toChargeRow(charge);
    this.db.orm.update(charges).set(rest).where(eq(charges.chargeId, chargeId)).run();
  }

  chargeForOrder(tenantId: string, orderId: string): Charge | undefined {
    const row = this.db.orm
      .select()
      .from(charges)
      .where(and(eq(charges.tenantId, tenantId), eq(charges.orderId, orderId)))
      .get();
    return row ? toCharge(row) : undefined;
  }

  chargeByPaymentRef(paymentRef: string): Charge | undefined {
    const row = this.db.orm.select().from(charges).where(eq(charges.paymentRef, paymentRef)).get();
    return row ? toCharge(row) : undefined;
  }

  insertLedger(entry: LedgerEntry): boolean {
    return (
      this.db.orm
        .insert(ledger)
        .values({
          entryId: entry.entryId,
          tenantId: entry.tenantId,
          orderId: entry.orderId,
          kind: entry.kind,
          amount: entry.amount,
          currency: entry.currency,
          at: entry.at,
          ref: entry.ref ?? null,
        })
        .onConflictDoNothing()
        .run().changes === 1
    );
  }

  listLedger(tenantId: string, filter: LedgerFilter): LedgerEntry[] {
    const rows = filter.orderId
      ? this.db.orm
          .select()
          .from(ledger)
          .where(and(eq(ledger.tenantId, tenantId), eq(ledger.orderId, filter.orderId)))
          .orderBy(desc(ledger.at), desc(ledger.entryId))
          .limit(filter.limit)
          .all()
      : this.db.orm.select().from(ledger).where(eq(ledger.tenantId, tenantId)).orderBy(desc(ledger.at), desc(ledger.entryId)).limit(filter.limit).all();
    return rows.map(toLedger);
  }
}

function toChargeRow(c: Charge): ChargeRow {
  return {
    chargeId: c.chargeId,
    tenantId: c.tenantId,
    orderId: c.orderId,
    amount: c.amount,
    currency: c.currency,
    state: c.state,
    paymentRef: c.paymentRef ?? null,
    updatedAt: c.updatedAt,
  };
}

function toCharge(row: ChargeRow): Charge {
  return {
    chargeId: row.chargeId,
    tenantId: row.tenantId,
    orderId: row.orderId,
    amount: row.amount,
    currency: row.currency,
    state: row.state as Charge["state"],
    updatedAt: row.updatedAt,
    ...(row.paymentRef ? { paymentRef: row.paymentRef } : {}),
  };
}

function toLedger(row: LedgerRow): LedgerEntry {
  return {
    entryId: row.entryId,
    tenantId: row.tenantId,
    orderId: row.orderId,
    kind: row.kind as LedgerEntry["kind"],
    amount: row.amount,
    currency: row.currency,
    at: row.at,
    ...(row.ref ? { ref: row.ref } : {}),
  };
}
