// The export quality multiplier, shared by the editor and the npm SDK so the
// two can't disagree about the default. 1 renders at the canvas's own size;
// 2 renders at double it (2160×3840 for a portrait canvas: retina, and
// roughly 4K). 2 is the default on every surface that produces a file.

export type ExportScale = 1 | 2;

export const EXPORT_SCALES: readonly ExportScale[] = [1, 2];

export const DEFAULT_EXPORT_SCALE: ExportScale = 2;

/** Read a `?scale=` value. Absent is null, so the caller decides what a
 * request without one means; anything but "1" or "2" throws. */
export const parseExportScale = (raw: string | null): ExportScale | null => {
  if (raw === null) return null;
  if (raw === "1") return 1;
  if (raw === "2") return 2;
  throw new Error(`scale must be 1 or 2, got ${JSON.stringify(raw)}`);
};
