import {
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import type { Photo, PhotoDecision, PhotoMetadataValue, ViewerState } from "../types";

const MIN_ZOOM = 1;
const MAX_ZOOM = 12;

type Size = {
  width: number;
  height: number;
};

type FrameMetrics = {
  width: number;
  height: number;
  left: number;
  top: number;
  normalized: ViewerState;
};

type PhotoStageProps = {
  detail: string;
  decision: PhotoDecision;
  emphasis?: "primary" | "secondary";
  label: string;
  overlayMetadata?: PhotoMetadataValue[];
  photo: Photo | null;
  viewerState: ViewerState;
  onViewerChange: (next: ViewerState) => void;
};

export function PhotoStage({
  detail,
  decision,
  emphasis = "secondary",
  label,
  overlayMetadata,
  photo,
  viewerState,
  onViewerChange,
}: PhotoStageProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startState: ViewerState;
  } | null>(null);
  const [viewportSize, setViewportSize] = useState<Size>({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState<Size | null>(null);

  useEffect(() => {
    return () => {
      document.body.classList.remove("is-dragging-photo-stage");
    };
  }, []);

  useEffect(() => {
    if (!viewportRef.current) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      setViewportSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setNaturalSize(null);
  }, [photo]);

  useEffect(() => {
    const image = imageRef.current;

    if (!photo || !image || !image.complete || !image.naturalWidth || !image.naturalHeight) {
      return;
    }

    setNaturalSize({
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
  }, [photo, photo?.url]);

  const frame =
    naturalSize && viewportSize.width && viewportSize.height
      ? buildFrameMetrics(viewerState, viewportSize, naturalSize)
      : null;

  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    setNaturalSize({
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
  };

  const applyZoom = (
    nextZoom: number,
    pointX: number,
    pointY: number,
    currentFrame: FrameMetrics,
  ) => {
    if (!naturalSize) {
      return;
    }

    const fit = getFitSize(viewportSize, naturalSize);
    const currentX = (pointX - currentFrame.left) / currentFrame.width;
    const currentY = (pointY - currentFrame.top) / currentFrame.height;
    const clampedZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const nextWidth = fit.width * clampedZoom;
    const nextHeight = fit.height * clampedZoom;

    const nextViewer = normalizeViewerState(
      {
        zoom: clampedZoom,
        centerX:
          currentX - (pointX - viewportSize.width / 2) / Math.max(nextWidth, 1),
        centerY:
          currentY - (pointY - viewportSize.height / 2) / Math.max(nextHeight, 1),
      },
      viewportSize,
      naturalSize,
    );

    onViewerChange(nextViewer);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!frame || !naturalSize) {
      return;
    }

    event.preventDefault();

    const rect = event.currentTarget.getBoundingClientRect();
    const pointX = event.clientX - rect.left;
    const pointY = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
    applyZoom(frame.normalized.zoom * factor, pointX, pointY, frame);
  };

  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!frame || !naturalSize) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const pointX = event.clientX - rect.left;
    const pointY = event.clientY - rect.top;

    if (frame.normalized.zoom > 1.2) {
      onViewerChange({ zoom: 1, centerX: 0.5, centerY: 0.5 });
      return;
    }

    applyZoom(2.4, pointX, pointY, frame);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!frame || frame.normalized.zoom <= 1.001) {
      return;
    }

    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startState: frame.normalized,
    };
    document.body.classList.add("is-dragging-photo-stage");
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!naturalSize || !dragRef.current || dragRef.current.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    const fit = getFitSize(viewportSize, naturalSize);
    const scaledWidth = fit.width * dragRef.current.startState.zoom;
    const scaledHeight = fit.height * dragRef.current.startState.zoom;

    const nextViewer = normalizeViewerState(
      {
        ...dragRef.current.startState,
        centerX:
          dragRef.current.startState.centerX -
          (event.clientX - dragRef.current.originX) / Math.max(scaledWidth, 1),
        centerY:
          dragRef.current.startState.centerY -
          (event.clientY - dragRef.current.originY) / Math.max(scaledHeight, 1),
      },
      viewportSize,
      naturalSize,
    );

    onViewerChange(nextViewer);
  };

  const clearDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      document.body.classList.remove("is-dragging-photo-stage");
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <article
      className={
        emphasis === "primary"
          ? "photo-stage photo-stage--primary"
          : "photo-stage"
      }
    >
      <header className="photo-stage__header">
        <div>
          <p className="photo-stage__eyebrow">{detail}</p>
          <h3>{label}</h3>
        </div>
        {photo ? <span className="photo-stage__name">{photo.name}</span> : null}
      </header>

      <div
        ref={viewportRef}
        className={
          frame && frame.normalized.zoom > 1.001
            ? "photo-stage__viewport is-draggable"
            : "photo-stage__viewport"
        }
        onDoubleClick={handleDoubleClick}
        onPointerCancel={clearDrag}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={clearDrag}
        onWheel={handleWheel}
      >
        {photo ? (
          <>
            <div className="photo-stage__status">
              <div className="photo-stage__overlay">
                <span className={`decision-chip decision-chip--${decision} decision-chip--overlay`}>
                  {decision}
                </span>
                {overlayMetadata?.length ? (
                  <div className="photo-stage__meta">
                    {overlayMetadata.map((item) => (
                      <div className="photo-stage__meta-row" key={`${item.label}:${item.value}`}>
                        <span>{item.label}</span>
                        <strong>{item.value}</strong>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <img
              alt={photo.name}
              className="photo-stage__image"
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
              onLoad={handleImageLoad}
              ref={imageRef}
              src={photo.url}
              style={
                frame
                  ? {
                      width: `${frame.width}px`,
                      height: `${frame.height}px`,
                      transform: `translate(${frame.left}px, ${frame.top}px)`,
                    }
                  : { opacity: 0 }
              }
            />
            {frame ? (
              <div className="photo-stage__hud">
                <span>{Math.round(frame.normalized.zoom * 100)}%</span>
                {naturalSize ? (
                  <span>
                    {naturalSize.width} × {naturalSize.height}
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="photo-stage__placeholder">
                <p>Loading preview…</p>
              </div>
            )}
          </>
        ) : (
          <div className="photo-stage__placeholder">
            <p>Move to the second frame to compare detail side-by-side.</p>
          </div>
        )}
      </div>
    </article>
  );
}

function buildFrameMetrics(
  viewerState: ViewerState,
  viewport: Size,
  natural: Size,
): FrameMetrics {
  const normalized = normalizeViewerState(viewerState, viewport, natural);
  const fit = getFitSize(viewport, natural);
  const width = fit.width * normalized.zoom;
  const height = fit.height * normalized.zoom;

  return {
    width,
    height,
    left: viewport.width / 2 - normalized.centerX * width,
    top: viewport.height / 2 - normalized.centerY * height,
    normalized,
  };
}

function normalizeViewerState(
  viewerState: ViewerState,
  viewport: Size,
  natural: Size,
): ViewerState {
  const fit = getFitSize(viewport, natural);
  const zoom = clamp(viewerState.zoom, MIN_ZOOM, MAX_ZOOM);
  const scaledWidth = fit.width * zoom;
  const scaledHeight = fit.height * zoom;

  let centerX = viewerState.centerX;
  let centerY = viewerState.centerY;

  if (scaledWidth <= viewport.width) {
    centerX = 0.5;
  } else {
    const edge = viewport.width / (2 * scaledWidth);
    centerX = clamp(centerX, edge, 1 - edge);
  }

  if (scaledHeight <= viewport.height) {
    centerY = 0.5;
  } else {
    const edge = viewport.height / (2 * scaledHeight);
    centerY = clamp(centerY, edge, 1 - edge);
  }

  return { zoom, centerX, centerY };
}

function getFitSize(viewport: Size, natural: Size) {
  const scale = Math.min(
    viewport.width / Math.max(natural.width, 1),
    viewport.height / Math.max(natural.height, 1),
  );

  return {
    width: natural.width * scale,
    height: natural.height * scale,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
