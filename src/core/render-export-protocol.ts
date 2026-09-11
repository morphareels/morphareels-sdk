// The window globals /render-export publishes for the driver that reads them
// through page.evaluate: the npm SDK's renderVideo. The page and every reader
// type the window with this one interface, so renaming a global fails to
// compile on both sides instead of failing a render at run time.

import type { ExportScale } from "./export-scale.ts";

/** What became of the composition's sound in a finished export.
 *  - "encoded": the file carries an AAC track with the mix.
 *  - "none": there was nothing to encode (no clip and no overlay, or audio
 *    was not asked for), so the file has no audio track.
 *  - "encoder-missing": the composition has sound but this browser has no AAC
 *    encoder (Chrome on Linux ships without one), so the file has no audio
 *    track. Every surface says so, rather than handing over a silent file as
 *    if it were complete. */
export type ExportAudioOutcome = "encoded" | "none" | "encoder-missing";

export interface ExportPageGlobals {
  __morphaExportReady?: boolean;
  __morphaExportStatus?: "ok" | "error";
  __morphaExportError?: string;
  /** The whole file as one base64 string, for SDKs before 0.8 only
   *  (see editor/src/export-handoff.ts). */
  __morphaExportBase64?: string;
  __morphaExportScale?: ExportScale;
  __morphaExportSize?: number;
  __morphaExportChunk?: (offset: number, length: number) => Promise<string>;
  __morphaExportAudio?: ExportAudioOutcome;
}
