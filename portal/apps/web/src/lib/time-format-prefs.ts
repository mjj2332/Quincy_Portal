import { useCallback } from "react";
import { TIME_FORMATS, frameLabel, type FrameLabelVersion, type TimeFormat } from "@quincy/shared";
import { uiPrefKey, useUiPref } from "./ui-prefs";

/**
 * The review player's time format (#860): Timecode (today's SMPTE reading), Standard (`m:ss`) or Frames. One key for the whole browser, shared by the
 * staff viewer and the Review-link guest page, defaulting to Timecode. Guest-safe on purpose: React, `./ui-prefs` and the shared formatter only.
 */
export const TIME_FORMAT_KEY = uiPrefKey("video-time-format");
export const DEFAULT_TIME_FORMAT: TimeFormat = "timecode";
export const TIME_FORMAT_LABELS: Record<TimeFormat, string> = { timecode: "Timecode", standard: "Standard", frames: "Frames" };

export function normalizeTimeFormat(raw: unknown): TimeFormat {
  return TIME_FORMATS.find((format) => format === raw) ?? DEFAULT_TIME_FORMAT;
}

export function useTimeFormat(): [TimeFormat, (format: TimeFormat) => void] {
  return useUiPref(TIME_FORMAT_KEY, normalizeTimeFormat);
}

/** A frame labeller for one Version, following the chosen format. Stable until the format or the Version's timing changes. */
export function useFrameLabel(version: FrameLabelVersion): (frame: number) => string {
  const [format] = useTimeFormat();
  const { fps, tcNominalFps, tcDropFrame, startTimecodeFrames } = version;
  const { num, den } = fps;
  return useCallback((frame: number) => frameLabel(frame, format, { fps: { num, den }, tcNominalFps, tcDropFrame, startTimecodeFrames }), [format, num, den, tcNominalFps, tcDropFrame, startTimecodeFrames]);
}

/** A labeller that takes the Version per call (Compare and the paste dialogs label more than one Version). */
export function useFrameLabeller(): (version: FrameLabelVersion, frame: number) => string {
  const [format] = useTimeFormat();
  return useCallback((version, frame) => frameLabel(frame, format, version), [format]);
}
