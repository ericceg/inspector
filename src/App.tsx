import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message, open } from "@tauri-apps/plugin-dialog";
import {
  type CSSProperties,
  startTransition,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { PhotoStage } from "./components/PhotoStage";
import {
  type BackendPhoto,
  type DecisionCounts,
  type ExportPhotoDecision,
  type ExportProgress,
  type ExportSummary,
  type MovedPhoto,
  type Photo,
  type PhotoDecision,
  type PhotoMetadataValue,
  type StripFilter,
  DEFAULT_VIEWER_STATE,
} from "./types";
import "./App.css";

const FILTERS: Array<{ value: StripFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pick", label: "Picks" },
  { value: "hold", label: "Hold" },
  { value: "reject", label: "Rejects" },
  { value: "unrated", label: "Unrated" },
];

const DECISION_LABELS: Record<PhotoDecision, string> = {
  pick: "Pick",
  hold: "Hold",
  reject: "Reject",
  unrated: "Unrated",
};

const DEFAULT_LEFT_RAIL_WIDTH = 288;
const DEFAULT_RIGHT_RAIL_WIDTH = 256;
const DEFAULT_TOPBAR_HEIGHT = 148;
const MIN_LEFT_RAIL_WIDTH = 220;
const MIN_RIGHT_RAIL_WIDTH = 220;
const MIN_TOPBAR_HEIGHT = 108;
const MIN_VIEWER_WIDTH = 360;
const MIN_VIEWER_HEIGHT = 300;
const PANEL_COLLAPSE_THRESHOLD = 84;
const SPLITTER_SIZE = 12;

function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [decisions, setDecisions] = useState<Record<string, PhotoDecision>>({});
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [stripFilter, setStripFilter] = useState<StripFilter>("all");
  const [showCompare, setShowCompare] = useState(false);
  const [showImageValues, setShowImageValues] = useState(true);
  const [isTopbarCollapsed, setIsTopbarCollapsed] = useState(false);
  const [isLeftRailCollapsed, setIsLeftRailCollapsed] = useState(false);
  const [isRightRailCollapsed, setIsRightRailCollapsed] = useState(false);
  const [leftRailWidth, setLeftRailWidth] = useState(DEFAULT_LEFT_RAIL_WIDTH);
  const [rightRailWidth, setRightRailWidth] = useState(DEFAULT_RIGHT_RAIL_WIDTH);
  const [topbarHeight, setTopbarHeight] = useState<number | null>(null);
  const [viewerState, setViewerState] = useState(DEFAULT_VIEWER_STATE);
  const [folderPath, setFolderPath] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [metadataByPhotoId, setMetadataByPhotoId] = useState<
    Record<string, PhotoMetadataValue[]>
  >({});
  const [metadataErrorsByPhotoId, setMetadataErrorsByPhotoId] = useState<Record<string, string>>(
    {},
  );
  const [metadataLoadingByPhotoId, setMetadataLoadingByPhotoId] = useState<
    Record<string, boolean>
  >({});
  const [loadError, setLoadError] = useState("");
  const [lastExportPath, setLastExportPath] = useState("");
  const shellRef = useRef<HTMLElement | null>(null);
  const topbarRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const filmstripRef = useRef<HTMLDivElement | null>(null);
  const selectedFilmstripItemRef = useRef<HTMLButtonElement | null>(null);
  const lastLeftRailWidthRef = useRef(DEFAULT_LEFT_RAIL_WIDTH);
  const lastRightRailWidthRef = useRef(DEFAULT_RIGHT_RAIL_WIDTH);
  const lastTopbarHeightRef = useRef(DEFAULT_TOPBAR_HEIGHT);

  const counts = countDecisions(photos, decisions);
  const filteredStripPhotos = photos.filter((photo) =>
    matchesFilter(resolveDecision(decisions, photo.id), stripFilter),
  );
  const navigablePhotos =
    stripFilter === "all" ? photos : filteredStripPhotos;
  const selectedPhoto = photos[selectedIndex] ?? null;
  const selectedNavigableIndex = selectedPhoto
    ? navigablePhotos.findIndex((photo) => photo.id === selectedPhoto.id)
    : -1;
  const comparePhoto =
    selectedNavigableIndex > 0
      ? navigablePhotos[selectedNavigableIndex - 1]
      : null;
  const compareDecision = comparePhoto
    ? resolveDecision(decisions, comparePhoto.id)
    : "unrated";
  const activeDecision = selectedPhoto
    ? resolveDecision(decisions, selectedPhoto.id)
    : "unrated";
  const selectedPhotoMetadata = selectedPhoto
    ? metadataByPhotoId[selectedPhoto.id]
    : undefined;
  const comparePhotoMetadata = comparePhoto
    ? metadataByPhotoId[comparePhoto.id]
    : undefined;
  const selectedPhotoMetadataError = selectedPhoto
    ? metadataErrorsByPhotoId[selectedPhoto.id] ?? ""
    : "";
  const isSelectedPhotoMetadataLoading = selectedPhoto
    ? metadataLoadingByPhotoId[selectedPhoto.id] === true
    : false;
  const isFocusView =
    isTopbarCollapsed && isLeftRailCollapsed && isRightRailCollapsed;

  const loadFolder = async () => {
    const selectedPath = await open({
      title: "Choose a photo folder",
      directory: true,
      multiple: false,
      recursive: true,
      fileAccessMode: "scoped",
    });

    if (typeof selectedPath !== "string") {
      return;
    }

    setIsLoading(true);
    setLoadError("");

    try {
      const scanned = await invoke<BackendPhoto[]>("scan_photo_directory", {
        path: selectedPath,
      });

      if (!scanned.length) {
        setPhotos([]);
        setDecisions({});
        setSelectedIndex(0);
        setFolderPath(selectedPath);
        setViewerState(DEFAULT_VIEWER_STATE);
        setLastExportPath("");
        setLoadError("No viewable photos were found in that folder.");
        await message(
          "No supported photos or RAW files were found in the selected folder.",
          {
            title: "Nothing to review",
            kind: "warning",
          },
        );
        return;
      }

      const nextPhotos = scanned.map((photo) => ({
        ...photo,
        url: convertFileSrc(photo.previewPath),
      }));

      startTransition(() => {
        setPhotos(nextPhotos);
        setDecisions({});
        setSelectedIndex(0);
        setStripFilter("all");
        setShowCompare(false);
        setShowImageValues(true);
        setViewerState(DEFAULT_VIEWER_STATE);
        setFolderPath(selectedPath);
        setLastExportPath("");
        setMetadataByPhotoId({});
        setMetadataErrorsByPhotoId({});
        setMetadataLoadingByPhotoId({});
      });
    } catch (error) {
      const nextError =
        error instanceof Error
          ? error.message
          : "The folder could not be loaded.";
      setLoadError(nextError);
    } finally {
      setIsLoading(false);
    }
  };

  const moveSelection = (direction: -1 | 1) => {
    if (!navigablePhotos.length) {
      return;
    }

    const currentIndex = Math.max(selectedNavigableIndex, 0);
    const nextPhoto =
      navigablePhotos[
        clamp(
          currentIndex + direction,
          0,
          Math.max(navigablePhotos.length - 1, 0),
        )
      ];

    if (!nextPhoto) {
      return;
    }

    setSelectedIndex(findPhotoIndex(photos, nextPhoto.id));
  };

  const applyDecision = (decision: Exclude<PhotoDecision, "unrated">) => {
    if (!selectedPhoto) {
      return;
    }

    const nextDecisions = { ...decisions, [selectedPhoto.id]: decision };
    const nextSelectedId = findNextSelectionId({
      photos,
      currentFilteredPhotos: filteredStripPhotos,
      currentSelectedId: selectedPhoto.id,
      nextDecisions,
      stripFilter,
      fallbackPhotoId:
        stripFilter === "all"
          ? photos[clamp(selectedIndex + 1, 0, Math.max(photos.length - 1, 0))]
              ?.id ?? selectedPhoto.id
          : undefined,
    });

    setDecisions(nextDecisions);

    if (nextSelectedId) {
      setSelectedIndex(findPhotoIndex(photos, nextSelectedId));
    }
  };

  const clearCurrentDecision = () => {
    if (!selectedPhoto) {
      return;
    }

    const nextDecisions = { ...decisions };
    delete nextDecisions[selectedPhoto.id];

    const nextSelectedId = findNextSelectionId({
      photos,
      currentFilteredPhotos: filteredStripPhotos,
      currentSelectedId: selectedPhoto.id,
      nextDecisions,
      stripFilter,
    });

    setDecisions(nextDecisions);

    if (nextSelectedId) {
      setSelectedIndex(findPhotoIndex(photos, nextSelectedId));
    }
  };

  const clearAllDecisions = () => {
    setDecisions({});
    setStripFilter("all");
  };

  const exportByDecision = async () => {
    if (!photos.length || !folderPath) {
      return;
    }

    setIsExporting(true);
    setExportProgress({
      processedCount: 0,
      totalCount: photos.length,
      currentName: "",
      currentDecision: "unrated",
    });

    try {
      const exportPayload: ExportPhotoDecision[] = photos.map((photo) => ({
        path: photo.path,
        decision: resolveDecision(decisions, photo.id),
      }));
      const summary = await invoke<ExportSummary>("export_photos_by_decision", {
        sourceRoot: folderPath,
        decisions: exportPayload,
      });
      const nextPhotos = buildMovedPhotos(photos, summary.movedPhotos);

      setLastExportPath(summary.destinationRoot);
      startTransition(() => {
        setPhotos(nextPhotos);
        setDecisions({});
        setSelectedIndex(0);
        setStripFilter("all");
        setShowCompare(false);
        setShowImageValues(true);
        setViewerState(DEFAULT_VIEWER_STATE);
        setFolderPath(summary.destinationRoot);
        setLoadError("");
        setMetadataByPhotoId({});
        setMetadataErrorsByPhotoId({});
        setMetadataLoadingByPhotoId({});
      });
      await message(
        `Moved ${summary.exportedCount} photos into pick, hold, reject, and unrated folders inside the loaded folder.\n\n${formatDecisionSummary(counts)}\n\nRoot:\n${summary.destinationRoot}`,
        {
          title: "Organization complete",
          kind: "info",
        },
      );
    } catch (error) {
      const nextError =
        error instanceof Error ? error.message : "The organization could not be completed.";
      await message(nextError, {
        title: "Organization failed",
        kind: "error",
      });
    } finally {
      setIsExporting(false);
      setExportProgress(null);
    }
  };

  const toggleFocusView = () => {
    const nextCollapsed = !isFocusView;
    setIsTopbarCollapsed(nextCollapsed);
    setIsLeftRailCollapsed(nextCollapsed);
    setIsRightRailCollapsed(nextCollapsed);
  };

  const toggleTopbarCollapsed = () => {
    if (isTopbarCollapsed) {
      setIsTopbarCollapsed(false);
      setTopbarHeight(lastTopbarHeightRef.current);
      return;
    }

    if (topbarHeight) {
      lastTopbarHeightRef.current = topbarHeight;
    }

    setIsTopbarCollapsed(true);
  };

  const toggleLeftRailCollapsed = () => {
    if (isLeftRailCollapsed) {
      setIsLeftRailCollapsed(false);
      setLeftRailWidth(lastLeftRailWidthRef.current);
      return;
    }

    lastLeftRailWidthRef.current = leftRailWidth;
    setIsLeftRailCollapsed(true);
  };

  const toggleRightRailCollapsed = () => {
    if (isRightRailCollapsed) {
      setIsRightRailCollapsed(false);
      setRightRailWidth(lastRightRailWidthRef.current);
      return;
    }

    lastRightRailWidthRef.current = rightRailWidth;
    setIsRightRailCollapsed(true);
  };

  const loadPhotoMetadata = useEffectEvent(async (photo: Photo) => {
    if (
      Object.prototype.hasOwnProperty.call(metadataByPhotoId, photo.id) ||
      Object.prototype.hasOwnProperty.call(metadataErrorsByPhotoId, photo.id) ||
      metadataLoadingByPhotoId[photo.id]
    ) {
      return;
    }

    setMetadataLoadingByPhotoId((current) => ({
      ...current,
      [photo.id]: true,
    }));

    try {
      const metadata = await invoke<PhotoMetadataValue[]>("read_photo_metadata", {
        path: photo.path,
      });

      setMetadataByPhotoId((current) => ({
        ...current,
        [photo.id]: metadata,
      }));
      setMetadataErrorsByPhotoId((current) => {
        if (!Object.prototype.hasOwnProperty.call(current, photo.id)) {
          return current;
        }

        const nextErrors = { ...current };
        delete nextErrors[photo.id];
        return nextErrors;
      });
    } catch (error) {
      const nextError =
        error instanceof Error
          ? error.message
          : "Could not read embedded image values.";

      setMetadataErrorsByPhotoId((current) => ({
        ...current,
        [photo.id]: nextError,
      }));
    } finally {
      setMetadataLoadingByPhotoId((current) => {
        if (!Object.prototype.hasOwnProperty.call(current, photo.id)) {
          return current;
        }

        const nextLoading = { ...current };
        delete nextLoading[photo.id];
        return nextLoading;
      });
    }
  });

  const adjustZoom = (factor: number) => {
    setViewerState((current) => ({
      ...current,
      zoom: clamp(current.zoom * factor, 1, 12),
    }));
  };

  const handleGlobalKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;

    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      target?.closest("input, textarea, select, [contenteditable='true']")
    ) {
      return;
    }

    if ((event.key === "o" || event.key === "O") && !isLoading) {
      event.preventDefault();
      void loadFolder();
      return;
    }

    if (!photos.length) {
      return;
    }

    switch (event.key) {
      case "ArrowRight":
      case "l":
      case "L":
      case "j":
      case "J":
        event.preventDefault();
        moveSelection(1);
        break;
      case "ArrowLeft":
      case "h":
      case "H":
      case "k":
      case "K":
        event.preventDefault();
        moveSelection(-1);
        break;
      case "1":
        event.preventDefault();
        applyDecision("pick");
        break;
      case "2":
        event.preventDefault();
        applyDecision("hold");
        break;
      case "3":
      case "Backspace":
        event.preventDefault();
        applyDecision("reject");
        break;
      case "0":
        event.preventDefault();
        setViewerState(DEFAULT_VIEWER_STATE);
        break;
      case "=":
      case "+":
        event.preventDefault();
        adjustZoom(1.18);
        break;
      case "-":
      case "_":
        event.preventDefault();
        adjustZoom(1 / 1.18);
        break;
      case "u":
      case "U":
        event.preventDefault();
        clearCurrentDecision();
        break;
      default:
        break;
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleGlobalKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [handleGlobalKeyDown]);

  useEffect(() => {
    let isMounted = true;
    let dispose: (() => void) | undefined;

    void listen<ExportProgress>("export-progress", (event) => {
      if (isMounted) {
        setExportProgress(event.payload);
      }
    }).then((unlisten) => {
      if (isMounted) {
        dispose = unlisten;
        return;
      }

      unlisten();
    });

    return () => {
      isMounted = false;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    if (!topbarRef.current || topbarHeight !== null) {
      return;
    }

    const measuredHeight = Math.ceil(topbarRef.current.getBoundingClientRect().height);
    const nextHeight = Math.max(measuredHeight, DEFAULT_TOPBAR_HEIGHT);
    setTopbarHeight(nextHeight);
    lastTopbarHeightRef.current = nextHeight;
  }, [topbarHeight]);

  useEffect(() => {
    if (!photos.length) {
      return;
    }

    setSelectedIndex((index) => clamp(index, 0, photos.length - 1));
  }, [photos]);

  useEffect(() => {
    if (!selectedPhoto) {
      return;
    }

    if (stripFilter === "all") {
      return;
    }

    if (
      !matchesFilter(resolveDecision(decisions, selectedPhoto.id), stripFilter) &&
      filteredStripPhotos.length
    ) {
      setSelectedIndex(findPhotoIndex(photos, filteredStripPhotos[0].id));
    }
  }, [decisions, filteredStripPhotos, photos, selectedPhoto, stripFilter]);

  useEffect(() => {
    if (selectedPhoto) {
      void loadPhotoMetadata(selectedPhoto);
    }

    if (showImageValues && comparePhoto) {
      void loadPhotoMetadata(comparePhoto);
    }
  }, [comparePhoto, loadPhotoMetadata, selectedPhoto, showImageValues]);

  useLayoutEffect(() => {
    if (isLeftRailCollapsed) {
      return;
    }

    const filmstrip = filmstripRef.current;
    const selectedItem = selectedFilmstripItemRef.current;

    if (!filmstrip || !selectedItem) {
      return;
    }

    const filmstripRect = filmstrip.getBoundingClientRect();
    const selectedRect = selectedItem.getBoundingClientRect();
    const selectedTop =
      selectedRect.top - filmstripRect.top + filmstrip.scrollTop;
    const centeredTop =
      selectedTop - (filmstrip.clientHeight - selectedItem.offsetHeight) / 2;
    const maxScrollTop = Math.max(0, filmstrip.scrollHeight - filmstrip.clientHeight);

    const nextTop =
      clamp(centeredTop, 0, maxScrollTop);

    filmstrip.scrollTo({
      top: nextTop,
      behavior: "auto",
    });
  }, [filteredStripPhotos.length, isLeftRailCollapsed, selectedPhoto?.id, stripFilter]);

  const beginLeftRailResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 960) {
      return;
    }

    const workspaceRect = workspaceRef.current?.getBoundingClientRect();

    if (!workspaceRect) {
      return;
    }

    event.preventDefault();

    const onPointerMove = (moveEvent: PointerEvent) => {
      const currentRightWidth = isRightRailCollapsed ? 0 : rightRailWidth;
      const maxWidth = Math.max(
        MIN_LEFT_RAIL_WIDTH,
        workspaceRect.width -
          currentRightWidth -
          MIN_VIEWER_WIDTH -
          SPLITTER_SIZE * 2,
      );
      const rawWidth = moveEvent.clientX - workspaceRect.left;

      if (rawWidth <= PANEL_COLLAPSE_THRESHOLD) {
        setIsLeftRailCollapsed(true);
        return;
      }

      const nextWidth = clamp(rawWidth, MIN_LEFT_RAIL_WIDTH, maxWidth);
      lastLeftRailWidthRef.current = nextWidth;
      setIsLeftRailCollapsed(false);
      setLeftRailWidth(nextWidth);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };

  const beginRightRailResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 1240) {
      return;
    }

    const workspaceRect = workspaceRef.current?.getBoundingClientRect();

    if (!workspaceRect) {
      return;
    }

    event.preventDefault();

    const onPointerMove = (moveEvent: PointerEvent) => {
      const currentLeftWidth = isLeftRailCollapsed ? 0 : leftRailWidth;
      const maxWidth = Math.max(
        MIN_RIGHT_RAIL_WIDTH,
        workspaceRect.width -
          currentLeftWidth -
          MIN_VIEWER_WIDTH -
          SPLITTER_SIZE * 2,
      );
      const rawWidth = workspaceRect.right - moveEvent.clientX;

      if (rawWidth <= PANEL_COLLAPSE_THRESHOLD) {
        setIsRightRailCollapsed(true);
        return;
      }

      const nextWidth = clamp(rawWidth, MIN_RIGHT_RAIL_WIDTH, maxWidth);
      lastRightRailWidthRef.current = nextWidth;
      setIsRightRailCollapsed(false);
      setRightRailWidth(nextWidth);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };

  const beginTopbarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const shellRect = shellRef.current?.getBoundingClientRect();

    if (!shellRect) {
      return;
    }

    event.preventDefault();

    const onPointerMove = (moveEvent: PointerEvent) => {
      const maxHeight = Math.max(
        MIN_TOPBAR_HEIGHT,
        shellRect.height - MIN_VIEWER_HEIGHT,
      );
      const rawHeight = moveEvent.clientY - shellRect.top;

      if (rawHeight <= PANEL_COLLAPSE_THRESHOLD) {
        setIsTopbarCollapsed(true);
        return;
      }

      const nextHeight = clamp(rawHeight, MIN_TOPBAR_HEIGHT, maxHeight);
      lastTopbarHeightRef.current = nextHeight;
      setIsTopbarCollapsed(false);
      setTopbarHeight(nextHeight);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };

  const workspaceStyle = {
    "--left-rail-width": `${isLeftRailCollapsed ? 0 : leftRailWidth}px`,
    "--right-rail-width": `${isRightRailCollapsed ? 0 : rightRailWidth}px`,
  } as CSSProperties;

  const shellStyle = {
    "--topbar-height": `${isTopbarCollapsed ? 0 : topbarHeight ?? DEFAULT_TOPBAR_HEIGHT}px`,
  } as CSSProperties;
  const exportProgressValue = exportProgress
    ? Math.round((exportProgress.processedCount / Math.max(exportProgress.totalCount, 1)) * 100)
    : 0;

  return (
    <main
      ref={shellRef}
      className={[
        "inspector-shell",
        isTopbarCollapsed ? "is-topbar-collapsed" : "",
        isFocusView ? "is-focus-view" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={shellStyle}
    >
      <header ref={topbarRef} className="topbar">
        <div className="topbar__brand">
          <p className="topbar__eyebrow">Photo Review</p>
          <h1>Inspector</h1>
          <p className="topbar__summary">
            Open a folder, compare frames, and keep the zoom locked while you
            move through the set.
          </p>
        </div>

        <div className="topbar__actions">
          <button
            className="button button--primary"
            onClick={() => void loadFolder()}
            disabled={isLoading}
            type="button"
          >
            {isLoading ? "Scanning…" : "Open Folder"}
          </button>
          <button
            className="button"
            onClick={() => setViewerState(DEFAULT_VIEWER_STATE)}
            disabled={!photos.length}
            type="button"
          >
            Reset View
          </button>
          <button
            className="button"
            onClick={clearAllDecisions}
            disabled={!Object.keys(decisions).length}
            type="button"
          >
            Reset Ratings
          </button>
          <button
            className="button"
            onClick={() => void exportByDecision()}
            disabled={!photos.length || isExporting}
            type="button"
          >
            {isExporting ? "Organizing…" : "Organize By Rating"}
          </button>
        </div>
      </header>

      <div
        aria-label="Resize top panel"
        className={
          isTopbarCollapsed
            ? "panel-splitter panel-splitter--top is-collapsed"
            : "panel-splitter panel-splitter--top"
        }
        onDoubleClick={toggleTopbarCollapsed}
        onPointerDown={beginTopbarResize}
        role="separator"
      />

      <section
        ref={workspaceRef}
        className={[
          "workspace",
          isLeftRailCollapsed ? "is-left-collapsed" : "",
          isRightRailCollapsed ? "is-right-collapsed" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={workspaceStyle}
      >
        <aside
          className={
            isLeftRailCollapsed ? "rail rail--left is-collapsed" : "rail rail--left"
          }
        >
          <div className="rail__section">
            <p className="section-label">Session</p>
            <div className="session-meta">
              <span className="session-meta__value">
                {photos.length ? `${selectedIndex + 1} / ${photos.length}` : "0 / 0"}
              </span>
              <span>{folderPath ? summarizePath(folderPath) : "No folder loaded"}</span>
            </div>
            {folderPath ? (
              <p className="session-path" title={folderPath}>
                {folderPath}
              </p>
            ) : null}
            {lastExportPath ? (
              <p className="session-note" title={lastExportPath}>
                Organized in: {lastExportPath}
              </p>
            ) : null}
            {isExporting && exportProgress ? (
              <div className="export-progress" aria-live="polite">
                <div className="export-progress__meta">
                  <span>Organizing photos</span>
                  <strong>
                    {exportProgress.processedCount} / {exportProgress.totalCount}
                  </strong>
                </div>
                <div
                  aria-label={`Move progress ${exportProgressValue}%`}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={exportProgressValue}
                  className="export-progress__track"
                  role="progressbar"
                >
                  <span
                    className="export-progress__fill"
                    style={{ width: `${exportProgressValue}%` }}
                  />
                </div>
                <p className="export-progress__label">
                  {exportProgress.currentName
                    ? `${exportProgress.currentDecision} · ${exportProgress.currentName}`
                    : "Preparing move…"}
                </p>
              </div>
            ) : null}
            {loadError ? <p className="session-error">{loadError}</p> : null}
          </div>

          <div className="rail__section">
            <p className="section-label">Filters</p>
            <div className="filter-row">
              {FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  className={
                    filter.value === stripFilter
                      ? "filter-pill is-active"
                      : "filter-pill"
                  }
                  onClick={() => setStripFilter(filter.value)}
                  type="button"
                >
                  <span>{filter.label}</span>
                  <span>{countForFilter(counts, filter.value)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rail__section rail__section--stretch">
            <div className="section-heading">
              <p className="section-label">Filmstrip</p>
              <span>{filteredStripPhotos.length} visible</span>
            </div>

            {filteredStripPhotos.length ? (
              <div ref={filmstripRef} className="filmstrip">
                {filteredStripPhotos.map((photo) => {
                  const decision = resolveDecision(decisions, photo.id);
                  const isSelected = photo.id === selectedPhoto?.id;

                  return (
                    <button
                      ref={isSelected ? selectedFilmstripItemRef : null}
                      key={photo.id}
                      className={[
                        "filmstrip__item",
                        `filmstrip__item--${decision}`,
                        isSelected ? "is-selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() =>
                        setSelectedIndex(
                          photos.findIndex((entry) => entry.id === photo.id),
                        )
                      }
                      type="button"
                    >
                      <div className="filmstrip__thumb">
                        <img
                          src={photo.url}
                          alt={photo.name}
                          loading="lazy"
                          draggable={false}
                        />
                      </div>

                      <div className="filmstrip__meta">
                        <strong>{photo.name}</strong>
                        <span title={photo.directory}>{summarizePath(photo.directory)}</span>
                      </div>

                      <span
                        className={`decision-swatch decision-swatch--${decision}`}
                        aria-label={`Status: ${DECISION_LABELS[decision]}`}
                        title={DECISION_LABELS[decision]}
                      />
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="empty-rail">
                <p>No frames match that filter yet.</p>
              </div>
            )}
          </div>
        </aside>

        <div
          aria-label="Resize left panel"
          className={
            isLeftRailCollapsed
              ? "panel-splitter panel-splitter--vertical panel-splitter--left is-collapsed"
              : "panel-splitter panel-splitter--vertical panel-splitter--left"
          }
          onDoubleClick={toggleLeftRailCollapsed}
          onPointerDown={beginLeftRailResize}
          role="separator"
        />

        <section className="viewer">
          <div className="viewer__toolbar">
            <div>
              <p className="section-label">Compare</p>
              <h2>
                {selectedPhoto
                  ? showCompare && comparePhoto
                    ? "Previous and current frame"
                    : "Current frame"
                  : "Open a folder"}
              </h2>
            </div>

            <div className="viewer__toolbar-actions">
              <button
                className={isFocusView ? "button is-active" : "button"}
                onClick={toggleFocusView}
                type="button"
              >
                {isFocusView ? "Restore Layout" : "Maximize View"}
              </button>
              <button
                className="button"
                onClick={() => setShowCompare((current) => !current)}
                disabled={!comparePhoto}
                type="button"
              >
                {showCompare ? "Single View" : "Compare"}
              </button>
              <button
                className="button"
                onClick={() => adjustZoom(1 / 1.18)}
                disabled={!selectedPhoto}
                type="button"
              >
                Zoom Out
              </button>
              <button
                className="button"
                onClick={() => adjustZoom(1.18)}
                disabled={!selectedPhoto}
                type="button"
              >
                Zoom In
              </button>
            </div>
          </div>

          {photos.length ? (
            <div
              className={
                showCompare && comparePhoto
                  ? "compare-grid"
                  : "compare-grid compare-grid--single"
              }
            >
              {showCompare && comparePhoto ? (
                <PhotoStage
                  detail="Reference"
                  decision={compareDecision}
                  label="Previous frame"
                  overlayMetadata={
                    showImageValues
                      ? pickStageOverlayMetadata(comparePhotoMetadata)
                      : undefined
                  }
                  photo={comparePhoto}
                  viewerState={viewerState}
                  onViewerChange={setViewerState}
                />
              ) : null}
              <PhotoStage
                detail={showCompare && comparePhoto ? "Active" : "Selected"}
                decision={activeDecision}
                emphasis="primary"
                label="Current frame"
                overlayMetadata={
                  showImageValues
                    ? pickStageOverlayMetadata(selectedPhotoMetadata)
                    : undefined
                }
                photo={selectedPhoto}
                viewerState={viewerState}
                onViewerChange={setViewerState}
              />
            </div>
          ) : (
            <div className="empty-workspace">
              <p className="section-label">Start Here</p>
              <h2>Review a shoot with a fixed crop.</h2>
              <p>
                Load a folder, zoom into the detail you care about, then move
                through the set without resetting the view.
              </p>
              <button
                className="button button--primary"
                onClick={() => void loadFolder()}
                disabled={isLoading}
                type="button"
              >
                {isLoading ? "Scanning…" : "Choose Folder"}
              </button>
            </div>
          )}
        </section>

        <div
          aria-label="Resize right panel"
          className={
            isRightRailCollapsed
              ? "panel-splitter panel-splitter--vertical panel-splitter--right is-collapsed"
              : "panel-splitter panel-splitter--vertical panel-splitter--right"
          }
          onDoubleClick={toggleRightRailCollapsed}
          onPointerDown={beginRightRailResize}
          role="separator"
        />

        <aside
          className={
            isRightRailCollapsed
              ? "rail rail--right is-collapsed"
              : "rail rail--right"
          }
        >
          <div className="rail__section">
            <p className="section-label">Decisions</p>
            <div className="decision-grid">
              <button
                className="decision-button decision-button--pick"
                disabled={!selectedPhoto}
                onClick={() => applyDecision("pick")}
                type="button"
              >
                <strong>1</strong>
                <span>Pick</span>
              </button>
              <button
                className="decision-button decision-button--hold"
                disabled={!selectedPhoto}
                onClick={() => applyDecision("hold")}
                type="button"
              >
                <strong>2</strong>
                <span>Hold</span>
              </button>
              <button
                className="decision-button decision-button--reject"
                disabled={!selectedPhoto}
                onClick={() => applyDecision("reject")}
                type="button"
              >
                <strong>3</strong>
                <span>Reject</span>
              </button>
            </div>
          </div>

          <div className="rail__section">
            <div className="section-heading">
              <p className="section-label">Current</p>
              <button
                className={showImageValues ? "button button--compact is-active" : "button button--compact"}
                disabled={!selectedPhoto}
                onClick={() => setShowImageValues((current) => !current)}
                type="button"
              >
                {showImageValues ? "Hide In-Image Data" : "Show In-Image Data"}
              </button>
            </div>
            {selectedPhoto ? (
              <>
                <div className="detail-list">
                  <div className="detail-list__row">
                    <span>Name</span>
                    <strong>{selectedPhoto.name}</strong>
                  </div>
                  <div className="detail-list__row">
                    <span>Status</span>
                    <strong className={`decision-tag decision-tag--${activeDecision}`}>
                      {DECISION_LABELS[activeDecision]}
                    </strong>
                  </div>
                  <div className="detail-list__row">
                    <span>Zoom</span>
                    <strong>{Math.round(viewerState.zoom * 100)}%</strong>
                  </div>
                  <div className="detail-list__row">
                    <span>Folder</span>
                    <strong title={selectedPhoto.directory}>
                      {summarizePath(selectedPhoto.directory)}
                    </strong>
                  </div>
                </div>

                <div className="detail-list detail-list--metadata">
                  {isSelectedPhotoMetadataLoading ? (
                    <p className="muted-copy">Reading embedded image values…</p>
                  ) : selectedPhotoMetadataError ? (
                    <p className="muted-copy">{selectedPhotoMetadataError}</p>
                  ) : selectedPhotoMetadata?.length ? (
                    selectedPhotoMetadata.map((item) => (
                      <div className="detail-list__row" key={`${item.label}:${item.value}`}>
                        <span>{item.label}</span>
                        <strong>{item.value}</strong>
                      </div>
                    ))
                  ) : (
                    <p className="muted-copy">No embedded image values found for this file.</p>
                  )}
                </div>
              </>
            ) : (
              <p className="muted-copy">No frame selected yet.</p>
            )}
          </div>

          <div className="rail__section">
            <p className="section-label">Keyboard</p>
            <div className="shortcut-list">
              <div className="shortcut-list__row">
                <span>Next / Previous</span>
                <strong>← → or H J K L</strong>
              </div>
              <div className="shortcut-list__row">
                <span>Pick / Hold / Reject</span>
                <strong>1 / 2 / 3</strong>
              </div>
              <div className="shortcut-list__row">
                <span>Zoom</span>
                <strong>+ / -</strong>
              </div>
              <div className="shortcut-list__row">
                <span>Reset crop</span>
                <strong>0</strong>
              </div>
              <div className="shortcut-list__row">
                <span>Clear current status</span>
                <strong>U</strong>
              </div>
              <div className="shortcut-list__row">
                <span>Open folder</span>
                <strong>O</strong>
              </div>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function findPhotoIndex(photos: Photo[], photoId: string) {
  const index = photos.findIndex((photo) => photo.id === photoId);
  return index === -1 ? 0 : index;
}

function resolveDecision(
  decisions: Record<string, PhotoDecision>,
  photoId: string,
): PhotoDecision {
  return decisions[photoId] ?? "unrated";
}

function countDecisions(
  photos: Photo[],
  decisions: Record<string, PhotoDecision>,
): DecisionCounts {
  return photos.reduce<DecisionCounts>(
    (counts, photo) => {
      const decision = resolveDecision(decisions, photo.id);
      counts[decision] += 1;
      return counts;
    },
    { pick: 0, hold: 0, reject: 0, unrated: 0 },
  );
}

function pickStageOverlayMetadata(metadata: PhotoMetadataValue[] | undefined) {
  if (!metadata?.length) {
    return undefined;
  }

  const labels = new Set(["ISO", "Aperture", "Shutter"]);
  const overlayValues = metadata.filter((item) => labels.has(item.label));

  return overlayValues.length ? overlayValues : undefined;
}

function matchesFilter(decision: PhotoDecision, filter: StripFilter) {
  return filter === "all" || decision === filter;
}

function countForFilter(counts: DecisionCounts, filter: StripFilter) {
  if (filter === "all") {
    return counts.pick + counts.hold + counts.reject + counts.unrated;
  }

  return counts[filter];
}

function findNextSelectionId({
  photos,
  currentFilteredPhotos,
  currentSelectedId,
  nextDecisions,
  stripFilter,
  fallbackPhotoId,
}: {
  photos: Photo[];
  currentFilteredPhotos: Photo[];
  currentSelectedId: string;
  nextDecisions: Record<string, PhotoDecision>;
  stripFilter: StripFilter;
  fallbackPhotoId?: string;
}) {
  if (stripFilter === "all") {
    return fallbackPhotoId ?? currentSelectedId;
  }

  const nextFilteredPhotos = photos.filter((photo) =>
    matchesFilter(resolveDecision(nextDecisions, photo.id), stripFilter),
  );

  if (!nextFilteredPhotos.length) {
    return currentSelectedId;
  }

  const currentFilteredIndex = currentFilteredPhotos.findIndex(
    (photo) => photo.id === currentSelectedId,
  );

  if (currentFilteredIndex === -1) {
    return nextFilteredPhotos[0]?.id ?? currentSelectedId;
  }

  return (
    nextFilteredPhotos[currentFilteredIndex]?.id ??
    nextFilteredPhotos[currentFilteredIndex - 1]?.id ??
    nextFilteredPhotos[0]?.id ??
    currentSelectedId
  );
}

function summarizePath(path: string) {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join(" / ") || path;
}

function formatDecisionSummary(counts: DecisionCounts) {
  const labels: Array<[PhotoDecision, string]> = [
    ["pick", "pick"],
    ["hold", "hold"],
    ["reject", "reject"],
    ["unrated", "unrated"],
  ];

  return labels
    .map(([decision, label]) => `${counts[decision]} ${label}`)
    .join(" • ");
}

function buildMovedPhotos(photos: Photo[], movedPhotos: MovedPhoto[]) {
  const movedPhotoMap = new Map(
    movedPhotos.map((entry) => [entry.sourcePath, entry.destinationPath]),
  );

  return photos.map((photo) => {
    const destinationPath = movedPhotoMap.get(photo.path);

    if (!destinationPath) {
      return photo;
    }

    const nextPreviewPath = isBrowserViewableExtension(photo.extension)
      ? destinationPath
      : photo.previewPath;

    return {
      ...photo,
      id: destinationPath,
      path: destinationPath,
      directory: parentPath(destinationPath),
      previewPath: nextPreviewPath,
      url: convertFileSrc(nextPreviewPath),
    };
  });
}

function isBrowserViewableExtension(extension: string) {
  return [
    "jpg",
    "jpeg",
    "png",
    "tif",
    "tiff",
    "webp",
    "gif",
    "avif",
    "heic",
    "heif",
    "bmp",
  ].includes(extension.toLowerCase());
}

function parentPath(path: string) {
  const separator = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[/\\]/);
  parts.pop();
  return parts.join(separator) || path;
}

export default App;
