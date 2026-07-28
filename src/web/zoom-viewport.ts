/**
 * Focal zoom math for the mobile VNC wrapper.
 *
 * The display layer (Display.viewportChangeSize + Display._rescale +
 * Display.absX/absY) is the single source of truth for what the user
 * sees and where taps land. We compute the framebuffer window here and
 * hand it to the display, so we never have to touch canvas geometry,
 * CSS transforms or top/left offsets directly.
 *
 * factor = 1 -> fit (window == container).
 * factor > 1 -> zoom in (window == container / factor).
 * The anchor (a framebuffer point) stays at the centre of the window
 * across factor changes; the window is clamped to the framebuffer so
 * it cannot pan past the desktop edge.
 */
export interface ZoomViewport {
  /** Framebuffer top-left x. */
  x: number;
  /** Framebuffer top-left y. */
  y: number;
  /** Window width in framebuffer pixels (= canvas pixel width). */
  width: number;
  /** Window height in framebuffer pixels (= canvas pixel height). */
  height: number;
  /** Same as width; Display.viewportChangeSize reads serverWidth. */
  serverWidth: number;
  /** Same as height; Display.viewportChangeSize reads serverHeight. */
  serverHeight: number;
}

export interface ZoomAnchor {
  x: number;
  y: number;
}

export function computeZoomViewport(
  factor: number,
  anchor: ZoomAnchor,
  containerWidth: number,
  containerHeight: number,
  fbWidth: number,
  fbHeight: number,
): ZoomViewport {
  // ponytail: every input is treated as an opaque positive number;
  // zero-area shapes degenerate to a 1px window so callers never get
  // a div-by-zero or negative box in the middle of a resize.
  const f = Math.max(1, factor);
  const cW = Math.max(1, Math.floor(containerWidth));
  const cH = Math.max(1, Math.floor(containerHeight));
  const fbW = Math.max(1, Math.floor(fbWidth));
  const fbH = Math.max(1, Math.floor(fbHeight));

  const winW = Math.min(fbW, Math.floor(cW / f));
  const winH = Math.min(fbH, Math.floor(cH / f));

  // Anchor is clamped into the framebuffer so a tap just past the edge
  // still yields a valid window.
  const ax = Math.max(0, Math.min(anchor.x, fbW - 1));
  const ay = Math.max(0, Math.min(anchor.y, fbH - 1));

  let x = Math.round(ax - winW / 2);
  let y = Math.round(ay - winH / 2);

  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + winW > fbW) x = fbW - winW;
  if (y + winH > fbH) y = fbH - winH;
  // If the framebuffer is smaller than the requested window (rare; the
  // wrapper still asks for factor>1 with a tiny fb), the previous two
  // clamps could push x or y negative. Pin to zero.
  if (x < 0) x = 0;
  if (y < 0) y = 0;

  return {
    x,
    y,
    width: winW,
    height: winH,
    serverWidth: winW,
    serverHeight: winH,
  };
}
