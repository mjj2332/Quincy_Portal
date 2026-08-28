import type { Env } from "../env";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import {
  issueTransformSource as issue,
  signTransformSource as sign,
  verifyTransformSource as verify,
} from "@quincy/shared";

export const signTransformSource = (env: Env, key: string, expiresAt: number, principalId: string, authorizationEpoch: number, cacheVersion?: string) => sign(env.TRANSFORM_SOURCE_SECRET, key, expiresAt, principalId, authorizationEpoch, cacheVersion);
export const issueTransformSource = (env: Env, key: string, principalId: string, authorizationEpoch: number, nowSeconds?: number) => issue(env.TRANSFORM_SOURCE_SECRET, key, principalId, authorizationEpoch, nowSeconds);

/** The HMAC is shared-only; this app-side wrapper owns the one primary-key epoch read. */
export async function verifyTransformSource(env: Env, key: string, signature: string | undefined, expiresAt: string | undefined, principalId: string | undefined, authorizationEpoch: string | undefined, cacheVersion: string | undefined, nowSeconds?: number): Promise<boolean> {
  if (!await verify(env.TRANSFORM_SOURCE_SECRET, key, signature, expiresAt, principalId, authorizationEpoch, cacheVersion, nowSeconds)) return false;
  const current = await createDb(env.DB).select({ active: schema.user.active, role: schema.user.role, authorizationEpoch: schema.user.authorizationEpoch })
    .from(schema.user).where(eq(schema.user.id, principalId!)).get();
  return current?.active === true && current.role !== "external_editor" && String(current.authorizationEpoch) === authorizationEpoch;
}
