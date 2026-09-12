// The window globals /render-export publishes for the driver that reads them
// through page.evaluate: the npm SDK's renderVideo. The page and every reader
// type the window with this one interface, so renaming a global fails to
// compile on both sides instead of failing a render at run time.

import type { ExportScale } from "./export-scale.ts";

/** What `?audio=wav` left for the driver: the composition's mix as a WAV, or
 *  nothing to mix. The server render asks for this because the Chrome it runs
 *  on, on Linux, has no AAC encoder: the page exports video-only and ffmpeg in
 *  the container encodes the sound. */
export type ExportAudioState = "wav" | "none";

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
  /** `?audio=wav` only: whether there is a mix to collect. */
  __morphaExportAudioState?: ExportAudioState;
  /** The WAV's length in bytes, when there is one. */
  __morphaExportAudioSize?: number;
  /** The WAV in base64 chunks, read the same way as the video. */
  __morphaExportAudioChunk?: (offset: number, length: number) => Promise<string>;
}
