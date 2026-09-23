// ImageLightbox — click-to-zoom modal used everywhere in chat.
//
// Renders as a full-screen overlay with the image fitted inside;
// click outside the image (or press ESC) to close, click the image
// to toggle a 1:1 pixel view for detail inspection.
//
// Deliberately does NOT reuse <Modal> because Modal's chrome
// (title bar, size presets, backdrop card) is wrong for a
// full-viewport image viewer. We want maximum image area with
// minimal UI.

import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { X, ZoomIn, ZoomOut, ExternalLink } from "lucide-react";

export interface ImageLightboxProps {
  src: string;
  alt?: string;
  isOpen: boolean;
  onClose: () => void;
}

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
  /** Container styles (usually empty; the parent lays these out). */
  className?: string;
  /** Styles applied to the thumbnail <img>. */
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
          className={imgClassName ?? "max-h-64 max-w-md rounded-md border border-border-subtle shadow-sm hover:shadow-md transition-shadow"}
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
  const [zoomed, setZoomed] = useState(false);

  // Close on ESC, lock body scroll while open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

  // Reset zoom whenever the modal reopens on a different image.
  useEffect(() => {
    if (!isOpen) setZoomed(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBackdropClick = (e: ReactMouseEvent) => {
    // Only close if the click landed on the backdrop itself.
    if (e.target === e.currentTarget) onClose();
  };

  const handleImageClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    setZoomed((v) => !v);
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? "Image preview"}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      {/* Top-right controls */}
      <div className="absolute right-3 top-3 flex items-center gap-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setZoomed((v) => !v);
          }}
          className="rounded-md bg-white/10 p-1.5 text-white/90 hover:bg-white/20"
          aria-label={zoomed ? "Zoom out" : "Zoom in"}
          title={zoomed ? "Fit to screen" : "Actual size"}
        >
          {zoomed ? <ZoomOut size={16} /> : <ZoomIn size={16} />}
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

      {/* Image itself. Fit-mode uses object-contain in the viewport,
          zoomed mode shows the image at its natural size with a
          scrollable wrapper. */}
      {zoomed ? (
        <div
          className="max-h-[92vh] max-w-[92vw] overflow-auto"
          onClick={handleBackdropClick}
        >
          <img
            src={src}
            alt={alt ?? "image"}
            onClick={handleImageClick}
            className="block cursor-zoom-out"
          />
        </div>
      ) : (
        <img
          src={src}
          alt={alt ?? "image"}
          onClick={handleImageClick}
          className="max-h-[92vh] max-w-[92vw] cursor-zoom-in object-contain shadow-2xl"
        />
      )}
    </div>,
    getPortalRoot(),
  );
}
