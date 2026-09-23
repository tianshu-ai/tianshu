// ImageLightbox — click-to-zoom modal used everywhere in chat.
//
// Renders as a full-screen overlay with the image fitted inside;
// click outside the image (or press ESC) to close. Zoom cycles
// through discrete levels: fit → 100% → 200% → back to fit.
//
// Fit mode uses object-contain against the viewport so a small
// image fills as much vertical space as it can without going past
// its natural bounds. 100% / 200% render at explicit CSS pixel
// dimensions with a scrollable wrapper so users can pan around
// large images.

import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { X, ZoomIn, ZoomOut, ExternalLink, Maximize2 } from "lucide-react";

export interface ImageLightboxProps {
  src: string;
  alt?: string;
  isOpen: boolean;
  onClose: () => void;
}

type ZoomLevel = "fit" | "100" | "200";

const ZOOM_CYCLE: Record<ZoomLevel, ZoomLevel> = {
  fit: "100",
  "100": "200",
  "200": "fit",
};

const ZOOM_LABEL: Record<ZoomLevel, string> = {
  fit: "Fit",
  "100": "100%",
  "200": "200%",
};

let _portalRoot: HTMLElement | null = null;
function getPortalRoot(): HTMLElement {
  if (!_portalRoot) {
    _portalRoot = document.getElementById("modal-root");
    if (!_portalRoot) {
      _portalRoot = document.createElement("div");
      _portalRoot.id = "modal-root";
      document.body.appendChild(_portalRoot);
    }
  }
  return _portalRoot;
}

/**
 * Convenience wrapper: an <img> that opens a Lightbox modal on click.
 * Drop-in replacement for existing `<a target="_blank"><img/></a>`
 * patterns in the chat UI.
 */
export function ClickableImage({
  src,
  alt,
  className,
  imgClassName,
}: {
  src: string;
  alt?: string;
  className?: string;
  imgClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`cursor-zoom-in ${className ?? ""}`}
      >
        <img
          src={src}
          alt={alt ?? "image"}
          className={
            imgClassName ??
            "max-h-64 max-w-md rounded-md border border-border-subtle shadow-sm hover:shadow-md transition-shadow"
          }
        />
      </button>
      <ImageLightbox
        src={src}
        alt={alt}
        isOpen={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export function ImageLightbox({
  src,
  alt,
  isOpen,
  onClose,
}: ImageLightboxProps) {
  const [zoom, setZoom] = useState<ZoomLevel>("fit");
  // Track image natural dimensions so 100% / 200% can size the img
  // element explicitly. Otherwise CSS max-h/max-w constraints
  // silently keep the image at fit size even when the wrapper is
  // scrollable, which is what made the old zoom feel broken.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  // Close on ESC, cycle zoom on Space/=, lock body scroll.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === " " || e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom((z) => ZOOM_CYCLE[z]);
      } else if (e.key === "-" || e.key === "0") {
        e.preventDefault();
        setZoom("fit");
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

  // Reset zoom + natural dims each time the modal reopens.
  useEffect(() => {
    if (!isOpen) {
      setZoom("fit");
      setNatural(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBackdropClick = (e: ReactMouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const cycleZoom = () => setZoom((z) => ZOOM_CYCLE[z]);

  const handleImageClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    cycleZoom();
  };

  // Build the <img> style for the current zoom level.
  const zoomMultiplier =
    zoom === "100" ? 1 : zoom === "200" ? 2 : null; // null = fit
  const imgStyle =
    zoomMultiplier !== null && natural
      ? {
          width: `${natural.w * zoomMultiplier}px`,
          height: `${natural.h * zoomMultiplier}px`,
          maxWidth: "none",
          maxHeight: "none",
        }
      : undefined;

  const isFit = zoom === "fit";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? "Image preview"}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      {/* Top-right controls */}
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1">
        {/* Zoom level pill (also cycles on click) */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            cycleZoom();
          }}
          className="rounded-md bg-white/10 px-2.5 py-1.5 text-[11px] font-medium text-white/90 hover:bg-white/20"
          aria-label="Cycle zoom"
          title="Cycle zoom (Space / = / -)"
        >
          {ZOOM_LABEL[zoom]}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setZoom("fit");
          }}
          disabled={isFit}
          className="rounded-md bg-white/10 p-1.5 text-white/90 hover:bg-white/20 disabled:cursor-default disabled:opacity-40"
          aria-label="Fit to screen"
          title="Fit to screen"
        >
          <Maximize2 size={16} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setZoom((z) => (z === "200" ? "100" : z === "100" ? "fit" : "fit"));
          }}
          disabled={isFit}
          className="rounded-md bg-white/10 p-1.5 text-white/90 hover:bg-white/20 disabled:cursor-default disabled:opacity-40"
          aria-label="Zoom out"
          title="Zoom out"
        >
          <ZoomOut size={16} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setZoom((z) => (z === "fit" ? "100" : z === "100" ? "200" : "200"));
          }}
          className="rounded-md bg-white/10 p-1.5 text-white/90 hover:bg-white/20 disabled:cursor-default disabled:opacity-40"
          disabled={zoom === "200"}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <ZoomIn size={16} />
        </button>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="rounded-md bg-white/10 p-1.5 text-white/90 hover:bg-white/20"
          aria-label="Open image in new tab"
          title="Open in new tab"
        >
          <ExternalLink size={16} />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-white/10 p-1.5 text-white/90 hover:bg-white/20"
          aria-label="Close"
          title="Close (Esc)"
        >
          <X size={16} />
        </button>
      </div>

      {/* Image content. Fit mode uses object-contain in the viewport,
          zoomed modes place the natural-sized image inside a
          scrollable wrapper so users can pan around large images. */}
      {isFit ? (
        <img
          src={src}
          alt={alt ?? "image"}
          onClick={handleImageClick}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNatural({ w: img.naturalWidth, h: img.naturalHeight });
          }}
          className="max-h-[92vh] max-w-[92vw] cursor-zoom-in object-contain shadow-2xl"
        />
      ) : (
        <div
          className="max-h-[92vh] max-w-[92vw] overflow-auto"
          onClick={handleBackdropClick}
        >
          <img
            src={src}
            alt={alt ?? "image"}
            onClick={handleImageClick}
            onLoad={(e) => {
              const img = e.currentTarget;
              if (!natural) {
                setNatural({ w: img.naturalWidth, h: img.naturalHeight });
              }
            }}
            style={imgStyle}
            className="block cursor-zoom-in"
          />
        </div>
      )}
    </div>,
    getPortalRoot(),
  );
}
