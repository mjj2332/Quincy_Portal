import { DurableObject } from "cloudflare:workers";
import { and, asc, eq } from "drizzle-orm";
import { webhookEvents } from "@quincy/db/schema";

import type { Env } from "../env";
import { errorMessage, dbFor } from "../lib/db";
import { isDeterministicTonomoError, processTonomoEvent, TonomoApplyError } from "../tonomo/process";

const RETRY_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 5;
const attemptKey = (eventId: string) => eventId;

/** A fixed-ID DO serialises Tonomo event reconciliation across concurrent service-binding RPCs. */
export class TonomoProcessorDO extends DurableObject<Env> {
  private draining = false;
  // A drain() arriving mid-drain must not be dropped: its row may land after the active
  // loop's final empty SELECT, which also deletes the alarm — rerun instead of returning.
  private pendingDrain = false;

  async drain(): Promise<void> {
    if (this.draining) { this.pendingDrain = true; return; }
    this.draining = true;
    try {
      do {
        this.pendingDrain = false;
        await this.drainOnce();
      } while (this.pendingDrain);
    } finally {
      this.draining = false;
    }
  }

  private async drainOnce(): Promise<void> {
    const db = dbFor(this.env);
    while (true) {
      const event = await db.select().from(webhookEvents)
        .where(and(eq(webhookEvents.source, "tonomo"), eq(webhookEvents.status, "received")))
        .orderBy(asc(webhookEvents.receivedAt)).get();
      if (!event) {
        await this.ctx.storage.deleteAlarm();
        return;
      }

      try {
        await processTonomoEvent(this.env, event);
        await this.ctx.storage.delete(attemptKey(event.id));
      } catch (error) {
        const message = errorMessage(error);
        if (error instanceof TonomoApplyError && error.code === "board_schema_maintenance") {
          // Leave the event received for a later explicit drain after migration. In particular,
          // do not schedule a one-minute retry loop while a deployment is applying 0037.
          console.warn("Tonomo event held for board schema/contract rollout", { eventId: event.id, code: error.code });
          return;
        }
        if (isDeterministicTonomoError(error)) {
          await db.update(webhookEvents).set({ status: "poison", error: message, processedAt: new Date() })
            .where(eq(webhookEvents.id, event.id));
          await this.ctx.storage.delete(attemptKey(event.id));
          continue;
        }

        const attempts = (await this.ctx.storage.get<number>(attemptKey(event.id)) ?? 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await db.update(webhookEvents).set({ status: "poison", error: message, processedAt: new Date() })
            .where(eq(webhookEvents.id, event.id));
          await this.ctx.storage.delete(attemptKey(event.id));
          continue;
        }
        await this.ctx.storage.put(attemptKey(event.id), attempts);
        await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
        return;
      }
    }
  }

  async alarm(): Promise<void> {
    await this.drain();
  }

  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }
}
