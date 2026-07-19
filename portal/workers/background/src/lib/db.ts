import { createDb } from "@quincy/db";

import type { Env } from "../env";

export function dbFor(env: Env) {
  return createDb(env.DB);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
