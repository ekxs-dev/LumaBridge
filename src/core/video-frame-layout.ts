import { ToneBridgeError } from './errors';

export interface PlaneLayoutLike {
  offset: number;
  stride: number;
}

export interface VisibleRectLike {
  width: number;
  height: number;
}

export interface I420P10Layout {
  y: PlaneLayoutLike;
  u: PlaneLayoutLike;
  v: PlaneLayoutLike;
  bytesPerSample: 2;
  ySamples: number;
  chromaSamples: number;
}

export function validateI420P10CopyLayout(
  layout: PlaneLayoutLike[],
  visibleRect: VisibleRectLike,
  allocationSize: number,
): I420P10Layout {
  if (layout.length !== 3) {
    throw new ToneBridgeError('INVALID_COPY_LAYOUT', `I420P10 requires 3 planes, got ${layout.length}.`);
  }

  const [y, u, v] = layout;
  const chromaWidth = Math.ceil(visibleRect.width / 2);
  const chromaHeight = Math.ceil(visibleRect.height / 2);
  const yBytes = y.stride * visibleRect.height;
  const uBytes = u.stride * chromaHeight;
  const vBytes = v.stride * chromaHeight;

  if (y.stride < visibleRect.width * 2) {
    throw new ToneBridgeError('INVALID_COPY_LAYOUT', 'Y plane stride is too small for 10-bit samples.');
  }
  if (u.stride < chromaWidth * 2 || v.stride < chromaWidth * 2) {
    throw new ToneBridgeError('INVALID_COPY_LAYOUT', 'Chroma plane stride is too small for 10-bit samples.');
  }
  if (y.offset + yBytes > allocationSize || u.offset + uBytes > allocationSize || v.offset + vBytes > allocationSize) {
    throw new ToneBridgeError('INVALID_COPY_LAYOUT', 'Plane layout exceeds destination allocation.');
  }

  return {
    y,
    u,
    v,
    bytesPerSample: 2,
    ySamples: visibleRect.width * visibleRect.height,
    chromaSamples: chromaWidth * chromaHeight,
  };
}
