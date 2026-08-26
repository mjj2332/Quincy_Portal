import { createDb, schema } from "@quincy/db";
import type { Env, SessionUser } from "../env";
import { newId } from "./ids";

export type AuditPrincipal = Pick<SessionUser, "id" | "impersonatedBy"> | null;

export function auditMeta(principal: AuditPrincipal, meta?: Record<string, unknown>): string | null {
  if (meta === undefined && !principal?.impersonatedBy) return null;
  const value = { ...(meta ?? {}) };
  if (principal?.impersonatedBy) value.impersonatedBy = principal.impersonatedBy;
  return JSON.stringify(value);
}

export async function audit(
  env: Env,
  principal: AuditPrincipal,
  action: string,
  targetType: string,
  targetId: string | null,
  meta?: Record<string, unknown>,
) {
  await createDb(env.DB).insert(schema.auditLog).values({
    id: newId(), actorId: principal?.id ?? null, action, targetType, targetId,
    metaJson: auditMeta(principal, meta), createdAt: new Date(),
  });
}
