import { boardSchemaVariant, type BoardSchemaVariant } from "@quincy/db";
import type { Env } from "../env";

export const BOARD_SCHEMA_MAINTENANCE_CODE = "board_schema_maintenance" as const;

/** A service-binding-safe error: callers can classify this without relying on instanceof. */
export class BoardSchemaMaintenanceError extends Error {
  readonly code = BOARD_SCHEMA_MAINTENANCE_CODE;

  constructor() {
    super("Board schema migration is still being applied.");
    this.name = "BoardSchemaMaintenanceError";
  }
}

export async function requireBoardSchemaReady(env: Env): Promise<BoardSchemaVariant> {
  const variant = await boardSchemaVariant(env.DB);
  if (variant === "pre_0037") throw new BoardSchemaMaintenanceError();
  return variant;
}

export function isBoardSchemaMaintenanceError(error: unknown): boolean {
  return error instanceof BoardSchemaMaintenanceError
    || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === BOARD_SCHEMA_MAINTENANCE_CODE)
    || (error instanceof Error && /board schema migration is still being applied/i.test(error.message));
}
