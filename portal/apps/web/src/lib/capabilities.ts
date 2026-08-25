import { ROLE_CAPABILITIES, type Capability, type Role } from "@quincy/shared";
import { useCallback } from "react";
import { useSession } from "./auth";

type SessionUser = { role?: unknown };

function isRole(value: unknown): value is Role {
  return value === "admin" || value === "editor" || value === "photographer";
}

export function useCapabilities() {
  const session = useSession();
  const user = session.data?.user as SessionUser | undefined;
  const role = isRole(user?.role) ? user.role : undefined;
  const capabilities = role ? ROLE_CAPABILITIES[role] : [];
  const can = useCallback((capability: Capability): boolean => capabilities.includes(capability), [capabilities]);

  return { role, capabilities, can };
}
