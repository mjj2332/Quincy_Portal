import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Unread badge text: the count, capped at "99+". */
export function formatUnreadCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}
