import { createDb, schema } from "@quincy/db";
import type { Env } from "../env";
import { newId } from "./ids";

export async function audit(
  env: Env,
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
  meta: unknown = undefined,
) {
  await createDb(env.DB).insert(schema.auditLog).values({
    id: newId(), actorId, action, targetType, targetId,
    metaJson: meta === undefined ? null : JSON.stringify(meta), createdAt: new Date(),
  });
}
