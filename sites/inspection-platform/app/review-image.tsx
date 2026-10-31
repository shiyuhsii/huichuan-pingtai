'use client';

import { useEffect, useRef, useState } from 'react';
import type { InspectionRecord } from './lib/types';
import { clearDisplayOverlay } from './lib/display-review';

type Props = {
  record: InspectionRecord;
  review: boolean;
  alt?: string;
  onLoad?: (image: HTMLImageElement) => void;
};

/** The original screenshot is retained separately; this canvas is only a review preview. */
export default function ReviewImage({ record, review, alt, onLoad }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const callback = useRef(onLoad);
  callback.current = onLoad;
  const source = record.imageUrl;
  const preview = review && record.imageRole === 'paired-display' && record.boxes.some(box => box.origin === 'fpga');
  const geometry = JSON.stringify(record.boxes.filter(box => box.origin === 'fpga').map(({ x, y, w, h, origin }) => ({ x, y, w, h, origin })));

  useEffect(() => {
    setReady(false);
    if (!preview) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled || !canvas.current) return;
      try {
        const target = canvas.current;
        const context = target.getContext('2d');
        if (!context) return;
        target.width = image.naturalWidth;
        target.height = image.naturalHeight;
        context.drawImage(image, 0, 0);
        const frame = context.getImageData(0, 0, target.width, target.height);
        frame.data.set(clearDisplayOverlay(frame.data, target.width, target.height, JSON.parse(geometry)));
        context.putImageData(frame, 0, 0);
        setReady(true);
      } catch {
        // Loading or canvas restrictions leave the actual screenshot visible.
        setReady(false);
      }
    };
    image.src = source;
    return () => { cancelled = true; image.onload = null; image.onerror = null; };
  }, [source, preview, geometry]);

  const description = alt || `${record.partId}${preview ? '复核预览' : '检测图像'}`;
  return <>
    <img
      className="inspection-image"
      src={source}
      alt={description}
      draggable={false}
      style={{ display: preview && ready ? 'none' : 'block', width: '100%', height: 'auto' }}
      onLoad={event => callback.current?.(event.currentTarget)}
    />
    {preview && <canvas
      ref={canvas}
      className="inspection-image"
      role="img"
      aria-label={description}
      style={{ display: ready ? 'block' : 'none', width: '100%', height: 'auto' }}
    />}
  </>;
}
