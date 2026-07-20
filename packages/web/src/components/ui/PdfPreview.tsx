// PdfPreview — browser-native PDF viewer.
//
// Modern Chromium / Safari / Firefox all ship a PDF viewer that
// handles an <iframe src=".../foo.pdf"> automatically (with
// toolbar, search, zoom, page nav). We rely on that rather than
// vendoring pdf.js so the bundle stays small and PDFs feel the
// same as the rest of the user's browser.
//
// We don't sandbox the iframe — PDFs themselves have no JS
// attack surface in the modern PDF viewers (Acrobat-style
// scripting is disabled across the board), and the viewer needs
// same-origin access for things like printing and text selection
// to work cleanly. The bytes are coming from tianshu's own
// origin anyway.

import { useT } from "../../hooks/useT";

export interface PdfPreviewProps {
  /** URL the browser can fetch the PDF bytes from. Typically the
   *  files plugin's GET /api/p/files/raw route. */
  src: string;
  /** Optional accessible name for the iframe; defaults to "PDF
   *  preview". */
  title?: string;
  /** Optional className merged onto the wrapper. */
  className?: string;
}

export function PdfPreview({
  src,
  title,
  className = "",
}: PdfPreviewProps) {
  const t = useT();
  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className}`}>
      <iframe
        src={src}
        title={title ?? t("preview.pdf.iframeTitle")}
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
}
