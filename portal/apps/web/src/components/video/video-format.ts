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

/** Megabytes (1 MB = 1,000,000 bytes), one decimal under 100 MB; gigabytes from 1,000 MB. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  const mb = bytes / 1_000_000;
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}
