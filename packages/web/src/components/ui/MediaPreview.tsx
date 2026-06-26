// MediaPreview — <video> and <audio> wrappers.
//
// Trivial enough that they could have lived in DocumentViewer.tsx
// directly, but pulling them out keeps the dispatch table in
// DocumentViewer flat and lets the caller import either component
// in isolation when it wants finer control (e.g. autoplay).
//
// Both surfaces stream bytes through the rawUrl the caller passes
// (typically files plugin's GET /api/p/files/raw). Browser-native
// <video controls> / <audio controls> already handle scrubbing,
// volume, fullscreen, picture-in-picture — we don't reinvent any
// of that.

export interface VideoPreviewProps {
  src: string;
  className?: string;
}

export function VideoPreview({ src, className = "" }: VideoPreviewProps) {
  return (
    <div className={`flex min-h-0 flex-1 items-center justify-center bg-black ${className}`}>
      <video
        src={src}
        controls
        // Cap on both axes so a 4K video doesn't overflow the
        // modal. The container keeps the controls reachable.
        className="max-h-full max-w-full"
      >
        {/* Empty <track kind="captions"> placates a11y linters
            that complain about a captionless <video>; real
            caption support is a separate plugin's problem. */}
        <track kind="captions" />
      </video>
    </div>
  );
}

export interface AudioPreviewProps {
  src: string;
  className?: string;
}

export function AudioPreview({ src, className = "" }: AudioPreviewProps) {
  return (
    <div className={`flex min-h-0 flex-1 items-center justify-center bg-bg-base p-6 ${className}`}>
      <audio src={src} controls className="w-full max-w-2xl">
        <track kind="captions" />
      </audio>
    </div>
  );
}
