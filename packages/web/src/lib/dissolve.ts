/**
 * dissolveElement — Telegram-style snap/dissolve effect.
 *
 * Instead of cloning into SVG foreignObject (which breaks Tailwind
 * styles and complex nested components), we apply the SVG filter
 * directly to the original DOM element via CSS `filter: url(#id)`.
 *
 * Each call creates a unique hidden SVG filter definition with
 * animated properties, applies it to the element, and cleans up
 * when the animation completes.
 */

const DURATION_MS = 900;

let idCounter = 0;

/** Ensure a hidden SVG container exists for filter definitions. */
function getFilterHost(): SVGSVGElement {
  let svg = document.getElementById("dissolve-fx-filters") as unknown as SVGSVGElement | null;
  if (!svg) {
    const svgNS = "http://www.w3.org/2000/svg";
    svg = document.createElementNS(svgNS, "svg") as SVGSVGElement;
    svg.id = "dissolve-fx-filters";
    // Hidden but present in DOM so filters can be referenced
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.position = "absolute";
    svg.style.pointerEvents = "none";
    document.body.appendChild(svg);
  }
  return svg;
}

/** Inject the dissolve keyframes once. */
function ensureKeyframes(): void {
  if (document.getElementById("dissolve-fx-keyframes")) return;
  const style = document.createElement("style");
  style.id = "dissolve-fx-keyframes";
  style.textContent = `
    @keyframes dissolve-out {
      0%   { transform: scale(1); opacity: 1; }
      100% { transform: scale(1.08); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Build an SVG filter element with animated dissolve properties.
 * The filter is applied via CSS url(#filterId).
 */
function createFilter(filterId: string, smallestSide: number, seed: number): SVGFilterElement {
  const svgNS = "http://www.w3.org/2000/svg";
  const filter = document.createElementNS(svgNS, "filter");
  filter.id = filterId;
  filter.setAttribute("x", "-50%");
  filter.setAttribute("y", "-50%");
  filter.setAttribute("width", "200%");
  filter.setAttribute("height", "200%");
  filter.setAttribute("color-interpolation-filters", "sRGB");

  // Limit displacement to avoid bleeding into neighboring elements
  const maxDisplace = Math.min(smallestSide * 1.5, 300);

  filter.innerHTML = `
    <feTurbulence type="fractalNoise" baseFrequency="0.5"
                  numOctaves="1" result="dustNoise" seed="${seed}" />
    <feComponentTransfer in="dustNoise" result="dustNoiseMask">
      <feFuncA type="linear" slope="5" intercept="0">
        <animate attributeName="slope" values="5;2;1;0"
                 dur="${DURATION_MS}ms" fill="freeze" />
      </feFuncA>
    </feComponentTransfer>
    <feComposite in="SourceGraphic" in2="dustNoiseMask"
                 operator="in" result="dustySource" />
    <feTurbulence type="fractalNoise" baseFrequency="0.02"
                  numOctaves="1" result="dispNoise1" seed="${seed + 1}" />
    <feTurbulence type="fractalNoise" baseFrequency="0.8"
                  numOctaves="2" result="dispNoise2" seed="${seed + 2}" />
    <feMerge result="combinedNoise">
      <feMergeNode in="dispNoise1" />
      <feMergeNode in="dispNoise2" />
    </feMerge>
    <feDisplacementMap in="dustySource" in2="combinedNoise"
                       scale="0" xChannelSelector="R" yChannelSelector="G">
      <animate attributeName="scale" values="0;${maxDisplace}"
               dur="${DURATION_MS}ms" fill="freeze" />
    </feDisplacementMap>
  `;
  return filter;
}

/**
 * Dissolve a single element in-place. Returns a Promise that resolves
 * when the animation completes (~900 ms).
 *
 * No cloning — applies SVG filter + CSS animation directly to the
 * original DOM element, so all styles, children, and tool UI render
 * correctly throughout the animation.
 */
export function dissolveElement(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    ensureKeyframes();

    const rect = el.getBoundingClientRect();
    const { width, height } = rect;
    const seed = Math.floor(Date.now() / 1000) + idCounter;
    const filterId = `dissolve-fx-${++idCounter}`;

    // Create and mount the SVG filter definition
    const filterHost = getFilterHost();
    const filterEl = createFilter(filterId, Math.min(width, height), seed);
    filterHost.appendChild(filterEl);

    // Save original styles to restore on cleanup (in case of interruption)
    const origFilter = el.style.filter;
    const origAnimation = el.style.animation;
    const origTransformOrigin = el.style.transformOrigin;
    const origOverflow = el.style.overflow;

    // Apply filter + animation to the original element
    el.style.filter = `url(#${filterId})`;
    el.style.animation = `dissolve-out ${DURATION_MS}ms ease-in forwards`;
    el.style.transformOrigin = "center center";
    el.style.overflow = "visible";

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      // Remove the SVG filter definition
      filterEl.remove();
      // Restore original styles (element will be removed from DOM
      // by _finishDissolve shortly after, but restore just in case)
      el.style.filter = origFilter;
      el.style.animation = origAnimation;
      el.style.transformOrigin = origTransformOrigin;
      el.style.overflow = origOverflow;
      el.style.opacity = "0"; // Keep hidden until removed from store
      resolve();
    };

    el.addEventListener("animationend", cleanup, { once: true });
    // Safety timeout
    setTimeout(cleanup, DURATION_MS + 200);
  });
}

/**
 * Dissolve multiple elements simultaneously.
 */
export function dissolveElements(els: HTMLElement[]): Promise<void> {
  return Promise.all(els.map(dissolveElement)).then(() => {});
}
