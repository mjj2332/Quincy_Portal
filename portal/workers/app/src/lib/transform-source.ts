import type { Env } from "../env";
import {
  issueTransformSource as issue,
  signTransformSource as sign,
  verifyTransformSource as verify,
} from "@quincy/shared";

export const signTransformSource = (env: Env, key: string, expiresAt: number, cacheVersion?: string) => sign(env.TRANSFORM_SOURCE_SECRET, key, expiresAt, cacheVersion);
export const issueTransformSource = (env: Env, key: string, nowSeconds?: number) => issue(env.TRANSFORM_SOURCE_SECRET, key, nowSeconds);
export const verifyTransformSource = (env: Env, key: string, signature: string | undefined, expiresAt: string | undefined, cacheVersion: string | undefined, nowSeconds?: number) => verify(env.TRANSFORM_SOURCE_SECRET, key, signature, expiresAt, cacheVersion, nowSeconds);
