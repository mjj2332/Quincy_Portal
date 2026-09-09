export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => [...part][0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
