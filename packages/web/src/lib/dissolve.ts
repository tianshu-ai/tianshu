/**
 * dissolveElement — Telegram-style snap/dissolve effect.
 *
 * Approach borrowed from Telegram Web A's SnapEffectContainer:
 * Clone the element into an SVG foreignObject, apply SVG filters
 * (feTurbulence noise mask + feDisplacementMap scatter), and let
 * SVG <animate> drive the whole thing. Zero dependencies, ~80 lines.
 *
 * The element is hidden (opacity:0) during the animation and left
 * that way when done — the caller is responsible for removing it
 * from the DOM / React tree.
 */

const DURATION_MS = 900;
const VISIBILITY_MARGIN = 50;

let idCounter = 0;

/**
 * Deep-clone an element and bake ALL computed styles inline on every
 * descendant. This is necessary because inside SVG foreignObject the
 * page's stylesheets don't apply — Tailwind classes are useless.
 * Telegram only copies root-level styles because their CSS variables
 * cascade; we use Tailwind so every node needs its own inline styles.
 */
function deepCloneWithStyles(src: HTMLElement): HTMLElement {
  const clone = src.cloneNode(false) as HTMLElement;
  // Copy computed styles onto this node
  const cs = window.getComputedStyle(src);
  for (let i = 0; i < cs.length; i++) {
    const key = cs[i];
    clone.style.setProperty(key, cs.getPropertyValue(key), "important");
  }
  // Recurse into children
  for (let i = 0; i < src.childNodes.length; i++) {
    const child = src.childNodes[i];
    if (child instanceof HTMLElement) {
      clone.appendChild(deepCloneWithStyles(child));
    } else {
      // Text nodes, comments, etc — shallow clone
      clone.appendChild(child.cloneNode(true));
    }
  }
  return clone;
}

/** Container div, lazily created once and reused. */
function getContainer(): HTMLElement {
  let el = document.getElementById("dissolve-fx-container");
  if (!el) {
    el = document.createElement("div");
    el.id = "dissolve-fx-container";
    Object.assign(el.style, {
      pointerEvents: "none",
      position: "fixed",
      zIndex: "99999",
      inset: "0",
      overflow: "visible",
    });
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Build the SVG filter that produces the dissolve effect.
 * - feTurbulence → fractal noise
 * - feComponentTransfer → animated alpha slope (fades the noise mask)
 * - feComposite → mask the source with the noise
 * - feDisplacementMap → scatter masked pixels outward
 */
function buildFilterSVG(
  filterId: string,
  smallestSide: number,
  seed: number,
): string {
  return `
    <filter id="${filterId}" x="-150%" y="-150%" width="400%" height="400%"
            color-interpolation-filters="sRGB">
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
      <feTurbulence type="fractalNoise" baseFrequency="0.015"
                    numOctaves="1" result="dispNoise1" seed="${seed + 1}" />
      <feTurbulence type="fractalNoise" baseFrequency="1"
                    numOctaves="2" result="dispNoise2" seed="${seed + 2}" />
      <feMerge result="combinedNoise">
        <feMergeNode in="dispNoise1" />
        <feMergeNode in="dispNoise2" />
      </feMerge>
      <feDisplacementMap in="dustySource" in2="combinedNoise"
                         scale="0" xChannelSelector="R" yChannelSelector="G">
        <animate attributeName="scale" values="0;${smallestSide * 3}"
                 dur="${DURATION_MS}ms" fill="freeze" />
      </feDisplacementMap>
    </filter>`;
}

/**
 * Dissolve a single element. Returns a Promise that resolves
 * when the animation completes (~900 ms).
 */
export function dissolveElement(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const rect = el.getBoundingClientRect();
    const { left: x, top: y, width, height } = rect;

    // Skip off-screen elements
    if (
      x + width + VISIBILITY_MARGIN < 0 ||
      x - VISIBILITY_MARGIN > window.innerWidth ||
      y + height + VISIBILITY_MARGIN < 0 ||
      y - VISIBILITY_MARGIN > window.innerHeight
    ) {
      el.style.visibility = "hidden";
      resolve();
      return;
    }

    const seed = Math.floor(Date.now() / 1000);
    const filterId = `dissolve-fx-${++idCounter}`;

    // Build SVG with foreignObject containing a styled clone
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    Object.assign(svg.style, {
      position: "absolute",
      left: `${x}px`,
      top: `${y}px`,
      overflow: "visible",
      transformOrigin: "bottom",
      pointerEvents: "none",
    });

    // Add keyframe animation for slight scale-up
    svg.style.animation = `dissolve-scale ${DURATION_MS}ms ease-in forwards`;

    // Defs with the filter
    const defs = document.createElementNS(svgNS, "defs");
    defs.innerHTML = buildFilterSVG(
      filterId,
      Math.min(width, height),
      seed,
    );
    svg.appendChild(defs);

    // Filtered group with foreignObject
    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("filter", `url(#${filterId})`);
    const fo = document.createElementNS(svgNS, "foreignObject");
    fo.setAttribute("width", String(width));
    fo.setAttribute("height", String(height));
    fo.style.overflow = "visible";

    // Clone element with inline computed styles (recursive so that
    // child elements also render correctly inside foreignObject
    // where our stylesheet classes don't apply).
    const clone = deepCloneWithStyles(el);
    clone.style.setProperty("margin", "0", "important");

    fo.appendChild(clone);
    g.appendChild(fo);
    svg.appendChild(g);

    // Inject CSS keyframe if not already present
    if (!document.getElementById("dissolve-fx-keyframes")) {
      const style = document.createElement("style");
      style.id = "dissolve-fx-keyframes";
      style.textContent = `
        @keyframes dissolve-scale {
          0%   { transform: scale(1); }
          100% { transform: scale(1.15); }
        }
      `;
      document.head.appendChild(style);
    }

    // Hide original element immediately so the SVG filter doesn't
    // blur content underneath (the clone in foreignObject takes over).
    el.style.visibility = "hidden";

    // Mount
    const container = getContainer();
    container.appendChild(svg);

    // Clean up on animation end (guard against double-fire)
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      svg.remove();
      resolve();
    };
    svg.addEventListener("animationend", cleanup, { once: true });
    // Safety timeout in case animationend doesn't fire
    setTimeout(cleanup, DURATION_MS + 200);
  });
}

/**
 * Dissolve multiple elements simultaneously.
 */
export function dissolveElements(els: HTMLElement[]): Promise<void> {
  return Promise.all(els.map(dissolveElement)).then(() => {});
}
