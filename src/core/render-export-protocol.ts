// The window globals /render-export publishes for the driver that reads them
// through page.evaluate: the npm SDK's renderVideo. The page and every reader
// type the window with this one interface, so renaming a global fails to
// compile on both sides instead of failing a render at run time.

import type { ExportScale } from "./export-scale.ts";

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
}
