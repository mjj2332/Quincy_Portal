/**
 * The J / K / L shuttle as pure arithmetic (#741 4d-ii). A shuttle state is one signed rate: 0 paused, 1 / 2 / 4 / 8 forward,
 * -1 / -2 / -4 / -8 reverse (reverse is emulated by serialized seeks, see `video-frame-clock.ts`).
 */
export const SHUTTLE_SPEEDS = [1, 2, 4, 8] as const;
export type ShuttleKey = "toggle" | "forward" | "reverse";

const MAX_SPEED = SHUTTLE_SPEEDS[SHUTTLE_SPEEDS.length - 1]!;

/**
 * The rate after a key. Space / K toggle pause. L (J) starts forward (reverse) at 1x, doubles each press up to 8x, and slows one
 * step toward paused while the shuttle runs the other way: the convention of every NLE.
 */
export function nextShuttleRate(rate: number, key: ShuttleKey): number {
  if (key === "toggle") return rate === 0 ? 1 : 0;
  const sign = key === "forward" ? 1 : -1;
  if (rate === 0) return sign;
  if (Math.sign(rate) === sign) return sign * Math.min(MAX_SPEED, Math.abs(rate) * 2);
  const slower = Math.abs(rate) / 2;
  return slower < 1 ? 0 : -sign * slower;
}
