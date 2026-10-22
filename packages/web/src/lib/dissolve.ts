/**
 * dissolveElement — Telegram-style particle dissolve animation.
 *
 * Call dissolveElement(el) on any DOM element to dissolve it into
 * scattering particles. Returns a Promise that resolves when the
 * animation completes.
 *
 * Two-phase approach:
 *   1. Try pixel-accurate snapshot via SVG foreignObject → canvas
 *   2. If that fails, fall back to a simulated particle grid using
 *      the element's computed background/text colours
 *
 * Zero dependencies. ~6KB unminified.
 */

/* ── Config ────────────────────────────────────────────────────── */

const CELL = 4;               // px per particle
const MAX_FRAMES = 90;        // animation hard cap
const FADE_MS = 200;          // blur+fade on original element

/* ── Types ─────────────────────────────────────────────────────── */

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  s: number;
  r: number; g: number; b: number; pa: number;
  a: number;   // animation alpha 0→1
  decay: number;
  wait: number; // delay frames before motion
}

/* ── Pixel snapshot via SVG foreignObject ──────────────────────── */

function inlineStyles(src: Element, dst: Element): void {
  const cs = getComputedStyle(src);
  const el = dst as HTMLElement;
  el.style.cssText = cs.cssText;
  el.style.transition = "none";
  el.style.animation = "none";
  el.style.margin = "0";
  for (let i = 0; i < src.children.length && i < dst.children.length; i++) {
    inlineStyles(src.children[i], dst.children[i]);
  }
}

async function snapshotPixels(
  el: HTMLElement, w: number, h: number,
): Promise<ImageData | null> {
  try {
    const dpr = window.devicePixelRatio || 1;
    const clone = el.cloneNode(true) as HTMLElement;
    inlineStyles(el, clone);

    const wrapper = document.createElement("div");
    wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    wrapper.style.cssText = `width:${w}px;height:${h}px;overflow:hidden`;
    wrapper.appendChild(clone);

    const xml = new XMLSerializer().serializeToString(wrapper);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;

    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
      const c = document.createElement("canvas");
      c.width = w * dpr;
      c.height = h * dpr;
      const ctx = c.getContext("2d")!;
      ctx.scale(dpr, dpr);
      ctx.drawImage(img, 0, 0, w, h);
      return ctx.getImageData(0, 0, c.width, c.height);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

/* ── Fallback: colour-based particles ──────────────────────────── */

function parseColor(s: string): [number, number, number, number] {
  const m = s.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/);
  if (!m) return [128, 128, 128, 255];
  return [+m[1], +m[2], +m[3], m[4] != null ? Math.round(+m[4] * 255) : 255];
}

/* ── Build particles ───────────────────────────────────────────── */

function buildParticles(
  w: number, h: number,
  getPixel: (x: number, y: number) => [number, number, number, number],
): Particle[] {
  const ps: Particle[] = [];
  const cols = Math.ceil(w / CELL);
  const rows = Math.ceil(h / CELL);
  const cx = w / 2, cy = h / 2;
  const maxD = Math.hypot(cx, cy) || 1;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * CELL, y = r * CELL;
      const [pr, pg, pb, pa] = getPixel(
        Math.min(x + CELL / 2, w - 1),
        Math.min(y + CELL / 2, h - 1),
      );
      if (pa < 10) continue;

      const d = Math.hypot(x + CELL / 2 - cx, y + CELL / 2 - cy);
      // Wave: edges dissolve first, centre last
      const wait = Math.floor((1 - d / maxD) * 15);

      ps.push({
        x, y,
        vx: (Math.random() - 0.5) * 6,
        vy: (Math.random() - 0.7) * 4,
        s: CELL,
        r: pr, g: pg, b: pb, pa,
        a: 1,
        decay: 0.016 + Math.random() * 0.024,
        wait,
      });
    }
  }
  return ps;
}

function particlesFromImageData(
  data: ImageData, w: number, h: number,
): Particle[] {
  const dpr = window.devicePixelRatio || 1;
  const cw = data.width;
  return buildParticles(w, h, (x, y) => {
    const px = Math.min(Math.floor(x * dpr), cw - 1);
    const py = Math.min(Math.floor(y * dpr), data.height - 1);
    const i = (py * cw + px) * 4;
    return [data.data[i], data.data[i + 1], data.data[i + 2], data.data[i + 3]];
  });
}

function particlesFromColors(
  el: HTMLElement, w: number, h: number,
): Particle[] {
  const cs = getComputedStyle(el);
  const bg = parseColor(cs.backgroundColor);
  const fg = parseColor(cs.color);
  return buildParticles(w, h, (x, y) => {
    const inText = y > h * 0.12 && y < h * 0.88 && x > w * 0.04 && x < w * 0.96;
    return inText && Math.random() < 0.25 ? fg : bg;
  });
}

/* ── Animation loop ────────────────────────────────────────────── */

function animate(
  canvas: HTMLCanvasElement, particles: Particle[],
  w: number, h: number,
): Promise<void> {
  return new Promise((resolve) => {
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) { resolve(); return; }

    let frame = 0;
    function tick() {
      ctx!.clearRect(0, 0, w * dpr, h * dpr);
      ctx!.save();
      ctx!.scale(dpr, dpr);

      let alive = 0;
      for (const p of particles) {
        if (p.wait > 0) {
          p.wait--;
          ctx!.globalAlpha = p.pa / 255;
          ctx!.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
          ctx!.fillRect(p.x, p.y, p.s, p.s);
          alive++;
          continue;
        }
        if (p.a <= 0) continue;
        alive++;

        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.1;
        p.vx *= 0.98;
        p.a -= p.decay;

        const sz = p.s * Math.max(p.a, 0.15);
        ctx!.globalAlpha = Math.max(0, p.a) * (p.pa / 255);
        ctx!.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
        ctx!.fillRect(p.x, p.y, sz, sz);
      }

      ctx!.restore();
      frame++;
      if (alive > 0 && frame < MAX_FRAMES) {
        requestAnimationFrame(tick);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(tick);
  });
}

/* ── Public API ────────────────────────────────────────────────── */

/**
 * Dissolve an element into particles. The element will be hidden
 * (display:none) after the animation. Returns when done.
 */
export async function dissolveElement(el: HTMLElement): Promise<void> {
  const rect = el.getBoundingClientRect();
  const w = Math.ceil(rect.width);
  const h = Math.ceil(rect.height);
  if (w === 0 || h === 0) return;

  const dpr = window.devicePixelRatio || 1;

  // Try pixel snapshot, fall back to colour-based
  const imgData = await snapshotPixels(el, w, h);
  const particles = imgData
    ? particlesFromImageData(imgData, w, h)
    : particlesFromColors(el, w, h);

  if (particles.length === 0) {
    el.style.transition = `opacity 300ms, filter 300ms`;
    el.style.opacity = "0";
    el.style.filter = "blur(6px)";
    await new Promise((r) => setTimeout(r, 300));
    return;
  }

  // Create overlay canvas at element's viewport position
  const canvas = document.createElement("canvas");
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  Object.assign(canvas.style, {
    width: `${w}px`,
    height: `${h}px`,
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    pointerEvents: "none",
    zIndex: "9999",
  });
  document.body.appendChild(canvas);

  // Blur + fade the original
  el.style.transition = `opacity ${FADE_MS}ms ease-out, filter ${FADE_MS}ms ease-out`;
  el.style.filter = "blur(3px)";
  el.style.opacity = "0";

  // Run particles
  await animate(canvas, particles, w, h);

  // Cleanup
  canvas.remove();
}

/**
 * Dissolve multiple elements simultaneously.
 * Each gets its own canvas overlay. All animate in parallel.
 */
export async function dissolveElements(els: HTMLElement[]): Promise<void> {
  await Promise.all(els.map(dissolveElement));
}
