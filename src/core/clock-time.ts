// Clock-time formatting + parsing shared by EVERY surface that shows a
// timeline position or duration — editor UI (trim fields, transport pill,
// timeline ruler, export progress, duration pills) and the pure tool layer
// (freeze-frame labels) alike. Morpha surfaces time, never frame counts.
// This module is the single source: local per-file formatters are banned by
// test/time-format-single-source.test.ts.
//
// The family, by format and rounding:
//   formatClock          frames  → M:SS.ff   frame-accurate, editable fields
//   formatClockLabel     frames  → M:SS      floored (elapsed-time convention:
//                                            the transport pill shows 0:01
//                                            until the second actually ticks)
//   formatSecondsLabel   seconds → M:SS      floored; for the one input that
//                                            is genuinely seconds
//                                            (duration_seconds)
//   formatClockLabelRounded frames → M:SS    nearest second (ruler labels,
//                                            duration readouts)
//   formatClockTenths    frames  → M:SS.t    tenths, for playback progress
//   parseFrameInput      string  → frames    "m:ss(.fff)" / bare frames / "end"

const FPS = 30;

// Clock-time readout — M:SS.ff, frame-accurate but NEVER shows a raw frame
// count; null renders as "end". Negative frames clamp to 0:00.00 (drag labels
// can momentarily sample past the origin).
export const formatClock = (frame: number | null): string => {
  if (frame === null) return "end";
  const sec = Math.max(0, frame) / FPS;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
};

// Compact label form — M:SS, whole seconds FLOORED. For elapsed-time surfaces
// (the transport pill, the mobile timecode) where a second reads as reached
// only once it has fully elapsed.
export const formatClockLabel = (frame: number): string =>
  formatSecondsLabel(frame / FPS);

// The same floored M:SS label from a SECONDS value — for the one stored unit
// that is genuinely seconds (a page's duration_seconds). Non-finite or
// negative input renders as 0:00 rather than propagating garbage into a label.
export const formatSecondsLabel = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

// M:SS at the NEAREST second — for ruler labels, keyframe tooltips, and
// duration readouts, where 44.9s reading as 0:45 is the less surprising
// answer. Deliberately distinct from formatClockLabel's floor.
export const formatClockLabelRounded = (frame: number): string => {
  const totalSec = Math.round(Math.max(0, frame) / FPS);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

// M:SS.t — tenths of a second, for playback-progress readouts.
export const formatClockTenths = (frame: number): string => {
  // Round to DECISECONDS first, then derive minutes + seconds from that single
  // rounded total. Deriving `s` independently with `s.toFixed(1)` let the
  // rounding carry a value like 59.9667s up to "60.0" while `m` was still 0,
  // showing "0:60.0" on the last frame before a minute boundary. Because both
  // `m` and `s` come from the same `ds` here, a carry rolls the minute over
  // (ds=600 → m=1, s=0.0 → "1:00.0"), never "0:60.0".
  const ds = Math.round((Math.max(0, frame) / FPS) * 10);
  const m = Math.floor(ds / 600);
  const s = (ds % 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

export const parseFrameInput = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "end") return null;
  // Accept either a bare frame integer or "m:ss(.fff)" timecode.
  const tc = trimmed.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (tc) {
    const m = parseInt(tc[1], 10);
    const s = parseFloat(tc[2]);
    return Math.round((m * 60 + s) * FPS);
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
};
