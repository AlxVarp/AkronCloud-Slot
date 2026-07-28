import { describe, it, expect } from 'vitest';
import { computeZoomViewport } from '../src/web/zoom-viewport.js';

describe('computeZoomViewport', () => {
  it('factor 1 fits the container', () => {
    const v = computeZoomViewport(1, { x: 100, y: 100 }, 400, 600, 1280, 800);
    expect(v.width).toBe(400);
    expect(v.height).toBe(600);
    expect(v.serverWidth).toBe(400);
    expect(v.serverHeight).toBe(600);
    // Anchor at (100,100) is left/top of the desktop, far from the
    // centre of the requested window — clamps to the top-left so the
    // window stays inside the framebuffer.
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
  });

  it('factor 2 halves the window and centres on the anchor', () => {
    const v = computeZoomViewport(2, { x: 200, y: 200 }, 400, 600, 1280, 800);
    expect(v.width).toBe(200);
    expect(v.height).toBe(300);
    expect(v.x + v.width / 2).toBeCloseTo(200, 5);
    expect(v.y + v.height / 2).toBeCloseTo(200, 5);
  });

  it('factor 4 keeps the anchor at the window centre', () => {
    const v = computeZoomViewport(4, { x: 640, y: 400 }, 400, 600, 1280, 800);
    expect(v.width).toBe(100);
    expect(v.height).toBe(150);
    expect(v.x + v.width / 2).toBeCloseTo(640, 5);
    expect(v.y + v.height / 2).toBeCloseTo(400, 5);
  });

  it('clamps the window when the framebuffer is smaller than requested', () => {
    // factor 4 with cW=400 -> winW=100, but fbW=200 so winW stays 100
    // (framebuffer bigger than window, no clamp needed).
    const v = computeZoomViewport(4, { x: 0, y: 0 }, 400, 600, 200, 200);
    expect(v.width).toBe(100);
    expect(v.height).toBe(150);
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
  });

  it('clamps when the anchor sits near the right/bottom edge', () => {
    const v = computeZoomViewport(2, { x: 1270, y: 790 }, 400, 600, 1280, 800);
    // winW=200, winH=300; anchor at bottom-right clamps the window.
    expect(v.x).toBe(1080);
    expect(v.y).toBe(500);
    expect(v.x + v.width).toBe(1280);
    expect(v.y + v.height).toBe(800);
  });

  it('preserves the anchor when the window cannot reach it', () => {
    // Factor 2 window 200x300; anchor deep in the right side; window
    // must clamp but anchor should still be inside (or on the edge).
    const v = computeZoomViewport(2, { x: 1270, y: 790 }, 400, 600, 1280, 800);
    expect(v.x).toBeLessThanOrEqual(1270);
    expect(v.x + v.width).toBeGreaterThanOrEqual(1270);
    expect(v.y).toBeLessThanOrEqual(790);
    expect(v.y + v.height).toBeGreaterThanOrEqual(790);
  });

  it('degenerate zero-area inputs collapse to a 1px window', () => {
    const v = computeZoomViewport(1, { x: 50, y: 50 }, 0, 0, 0, 0);
    expect(v.width).toBe(1);
    expect(v.height).toBe(1);
    expect(v.x).toBeGreaterThanOrEqual(0);
    expect(v.y).toBeGreaterThanOrEqual(0);
  });

  it('factor below 1 is treated as 1', () => {
    const v = computeZoomViewport(0.5, { x: 100, y: 100 }, 400, 600, 1280, 800);
    expect(v.width).toBe(400);
    expect(v.height).toBe(600);
  });

  it('anchor outside the framebuffer is clamped to its edge', () => {
    const v = computeZoomViewport(2, { x: -5, y: 9999 }, 400, 600, 1280, 800);
    // Anchor clamps to (0, 799). window=200x300 -> x=0, y=500.
    expect(v.x).toBe(0);
    expect(v.y).toBe(500);
  });
});
