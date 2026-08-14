// Clock-time formatting + parsing shared by every surface that shows a
// timeline position — editor UI (the Inspector's trim fields, the export
// modal's Timing pick) and the pure tool layer (freeze-frame labels) alike.
// Morpha surfaces time, never frame counts: a frame value renders as M:SS.ff
// (or the compact M:SS label form), and input parses back from an
// "m:ss(.fff)" timecode, a bare frame integer, or the word "end" (the
// nullable "natural end" the trim fields established).

const FPS = 30;

// Clock-time readout — M:SS.ff, frame-accurate but NEVER shows a raw frame
// count; null renders as "end".
export const formatClock = (frame: number | null): string => {
  if (frame === null) return "end";
  const sec = frame / FPS;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
};

// Compact label form — M:SS, whole seconds. For display labels (layer names,
// duration pills) where the .ff frame precision is noise.
export const formatClockLabel = (frame: number): string => {
  const sec = Math.floor(frame / FPS);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
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
