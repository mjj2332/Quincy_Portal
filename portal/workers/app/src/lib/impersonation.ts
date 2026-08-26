import type { MiddlewareHandler } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, eq } from "drizzle-orm";
import { roleHasCapability } from "@quincy/shared";
import type { AppEnv, Env } from "../env";

export const USER_IMPERSONATION_FLAG = "user_impersonation" as const;

const DISABLED_MESSAGE = "User impersonation is disabled.";
const DISABLED_CODE = "impersonation_disabled";

class ImpersonationNotAllowedError extends Error {
  constructor() {
    super(DISABLED_MESSAGE);
    this.name = "ImpersonationNotAllowedError";
  }
}

export async function isUserImpersonationEnabled(env: Env): Promise<boolean> {
  try {
    const row = await createDb(env.DB).select({ enabled: schema.featureFlags.enabled })
      .from(schema.featureFlags).where(eq(schema.featureFlags.key, USER_IMPERSONATION_FLAG)).get();
    return row?.enabled === true;
  } catch {
    return false;
  }
}

export async function assertImpersonationSessionAllowed(
  env: Env,
  targetUserId: string,
  impersonatedBy: string,
): Promise<void> {
  try {
    const db = createDb(env.DB);
    const flag = await db.select({ enabled: schema.featureFlags.enabled })
      .from(schema.featureFlags).where(eq(schema.featureFlags.key, USER_IMPERSONATION_FLAG)).get();
    if (flag?.enabled !== true) throw new ImpersonationNotAllowedError();

    const target = await db.select({ active: schema.user.active, role: schema.user.role })
      .from(schema.user).where(eq(schema.user.id, targetUserId)).get();
    if (!target?.active || (target.role !== "photographer" && target.role !== "editor")) throw new ImpersonationNotAllowedError();

    const original = await db.select({ active: schema.user.active, role: schema.user.role })
      .from(schema.user).where(eq(schema.user.id, impersonatedBy)).get();
    if (!original?.active || !roleHasCapability(original.role, "manageUsers")) throw new ImpersonationNotAllowedError();
  } catch (error) {
    if (error instanceof ImpersonationNotAllowedError) throw error;
    throw new ImpersonationNotAllowedError();
  }
}

export const requireImpersonationEnabled: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!await isUserImpersonationEnabled(c.env)) return c.json({ error: DISABLED_MESSAGE, code: DISABLED_CODE }, 403);
  await next();
};

export function impersonationDisabledResponse(c: { json: (data: unknown, status?: number) => Response }) {
  return c.json({ error: DISABLED_MESSAGE, code: DISABLED_CODE }, 403);
}
