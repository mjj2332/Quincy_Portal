import type { VideoVersionDto } from "@quincy/shared";

/** 25 -> "25", 30000/1001 -> "29.97", 24000/1001 -> "23.976": three decimals, trailing zeros dropped. */
export function formatFps(fps: VideoVersionDto["fps"]): string {
  return String(Number((fps.num / fps.den).toFixed(3)));
}

/** m:ss, or h:mm:ss from an hour. */
export function formatDuration(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function formatVideoDate(iso: string): string {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}
