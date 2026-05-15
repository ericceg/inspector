import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { message, open } from "@tauri-apps/plugin-dialog";
import { flushSync } from "react-dom";
import {
  type CSSProperties,
  startTransition,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PhotoStage } from "./components/PhotoStage";
import {
  type BackendPhoto,
  type BackendPreview,
  type DecisionCounts,
  type FilterPillValue,
  type MovePhotoDecision,
  type MoveSummary,
  type MovedPhoto,
  type Photo,
  type PhotoDecision,
  type PhotoMetadataValue,
  type StripFilter,
  DEFAULT_VIEWER_STATE,
} from "./types";
import "./App.css";

const FILTERABLE_DECISIONS: PhotoDecision[] = ["pick", "hold", "reject", "unrated"];

const FILTERS: Array<{ value: FilterPillValue; label: string }> = [
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

function createAllStripFilter(): StripFilter {
  return [...FILTERABLE_DECISIONS];
}

function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [stripFilter, setStripFilter] = useState<StripFilter>(createAllStripFilter);
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
  const [isPersistingDecision, setIsPersistingDecision] = useState(false);
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
  const shellRef = useRef<HTMLElement | null>(null);
  const topbarRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const filmstripRef = useRef<HTMLDivElement | null>(null);
  const selectedFilmstripItemRef = useRef<HTMLButtonElement | null>(null);
  const isPersistingDecisionRef = useRef(false);
  const previewRequestsRef = useRef<Set<string>>(new Set());
  const lastLeftRailWidthRef = useRef(DEFAULT_LEFT_RAIL_WIDTH);
  const lastRightRailWidthRef = useRef(DEFAULT_RIGHT_RAIL_WIDTH);
  const lastTopbarHeightRef = useRef(DEFAULT_TOPBAR_HEIGHT);

  const counts = useMemo(() => countDecisions(photos), [photos]);
  const rawPreviewCounts = useMemo(() => countRawPreviewStates(photos), [photos]);
  const filteredStripPhotos = useMemo(
    () => photos.filter((photo) => matchesFilter(photo.decision, stripFilter)),
    [photos, stripFilter],
  );
  const isAllFilterSelected = isAllStripFilter(stripFilter);
  const navigablePhotos = filteredStripPhotos;
  const selectedPhoto = photos[selectedIndex] ?? null;
  const selectedNavigableIndex = selectedPhoto
    ? navigablePhotos.findIndex((photo) => photo.id === selectedPhoto.id)
    : -1;
  const comparePhoto =
    selectedNavigableIndex >= 0
      ? navigablePhotos[selectedNavigableIndex + 1] ?? null
      : null;
  const compareDecision = comparePhoto?.decision ?? "unrated";
  const activeDecision = selectedPhoto?.decision ?? "unrated";
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
  const isComparePhotoMetadataLoading = comparePhoto
    ? metadataLoadingByPhotoId[comparePhoto.id] === true
    : false;
  const isFocusView = isLeftRailCollapsed && isRightRailCollapsed;

  const toggleStripFilter = (value: FilterPillValue) => {
    setStripFilter((current) => {
      if (current.includes(value)) {
        return current.filter((entry) => entry !== value);
      }

      return FILTERABLE_DECISIONS.filter(
        (decision) => current.includes(decision) || decision === value,
      );
    });
  };

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
        setSelectedIndex(0);
        setFolderPath(selectedPath);
        setViewerState(DEFAULT_VIEWER_STATE);
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

      const nextPhotos = sortPhotosByName(scanned.map(createPhoto));

      startTransition(() => {
        setPhotos(nextPhotos);
        setSelectedIndex(0);
        setStripFilter(createAllStripFilter());
        setShowCompare(false);
        setShowImageValues(true);
        setViewerState(DEFAULT_VIEWER_STATE);
        setFolderPath(selectedPath);
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

  const applyDecision = async (
    decision: PhotoDecision,
    options: { advanceSelection?: boolean } = {},
  ) => {
    if (!selectedPhoto || !folderPath || isPersistingDecisionRef.current) {
      return;
    }

    const { advanceSelection = true } = options;
    const fallbackPhotoId =
      advanceSelection && isAllFilterSelected
        ? photos[clamp(selectedIndex + 1, 0, Math.max(photos.length - 1, 0))]?.id ??
          selectedPhoto.id
        : undefined;

    isPersistingDecisionRef.current = true;
    setIsPersistingDecision(true);

    try {
      const summary = await invoke<MoveSummary>("move_photos_by_decision", {
        sourceRoot: folderPath,
        decisions: [{ path: selectedPhoto.path, decision }],
      });
      const nextPhotos = applyMovedPhotos(photos, summary.movedPhotos);
      const currentMovedPhoto = summary.movedPhotos.find((movedPhoto) =>
        matchesMovedPhotoPath(movedPhoto, selectedPhoto.path),
      );
      const nextCurrentPhotoId =
        currentMovedPhoto?.destinationPath ?? selectedPhoto.id;
      const nextFallbackPhotoId =
        fallbackPhotoId === selectedPhoto.id ? nextCurrentPhotoId : fallbackPhotoId;
      const nextSelectedId = advanceSelection
        ? findNextSelectionId({
            photos: nextPhotos,
            currentFilteredPhotos: filteredStripPhotos,
            currentSelectedId: selectedPhoto.id,
            stripFilter,
            isAllFilterSelected,
            fallbackPhotoId: nextFallbackPhotoId,
          })
        : nextCurrentPhotoId;

      setLoadError("");
      flushSync(() => {
        setPhotos(nextPhotos);
        if (!advanceSelection) {
          setStripFilter((current) =>
            current.includes(decision)
              ? current
              : FILTERABLE_DECISIONS.filter(
                  (entry) => current.includes(entry) || entry === decision,
                ),
          );
        }
        setMetadataByPhotoId((current) => remapPhotoState(current, summary.movedPhotos));
        setMetadataErrorsByPhotoId((current) => remapPhotoState(current, summary.movedPhotos));
        setMetadataLoadingByPhotoId((current) => remapPhotoState(current, summary.movedPhotos));
        if (nextSelectedId) {
          setSelectedIndex(findPhotoIndex(nextPhotos, nextSelectedId));
        }
      });
    } catch (error) {
      const nextError =
        error instanceof Error ? error.message : "The photo could not be moved.";
      setLoadError(nextError);
      await message(nextError, {
        title: "Move failed",
        kind: "error",
      });
    } finally {
      isPersistingDecisionRef.current = false;
      setIsPersistingDecision(false);
    }
  };

  const clearCurrentDecision = () => {
    if (!selectedPhoto) {
      return;
    }

    void applyDecision("unrated", { advanceSelection: false });
  };

  const clearAllDecisions = async () => {
    if (!folderPath || isPersistingDecisionRef.current) {
      return;
    }

    const ratedPhotos = photos.filter((photo) => photo.decision !== "unrated");

    if (!ratedPhotos.length) {
      return;
    }

    isPersistingDecisionRef.current = true;
    setIsPersistingDecision(true);

    try {
      const summary = await invoke<MoveSummary>("move_photos_by_decision", {
        sourceRoot: folderPath,
        decisions: ratedPhotos.map<MovePhotoDecision>((photo) => ({
          path: photo.path,
          decision: "unrated",
        })),
      });
      const nextPhotos = applyMovedPhotos(photos, summary.movedPhotos);
      const fallbackPhotoId =
        nextPhotos[clamp(selectedIndex, 0, Math.max(nextPhotos.length - 1, 0))]?.id;

      setLoadError("");
      flushSync(() => {
        setPhotos(nextPhotos);
        setStripFilter(createAllStripFilter());
        setMetadataByPhotoId((current) => remapPhotoState(current, summary.movedPhotos));
        setMetadataErrorsByPhotoId((current) => remapPhotoState(current, summary.movedPhotos));
        setMetadataLoadingByPhotoId((current) => remapPhotoState(current, summary.movedPhotos));
        setSelectedIndex(fallbackPhotoId ? findPhotoIndex(nextPhotos, fallbackPhotoId) : 0);
      });
    } catch (error) {
      const nextError =
        error instanceof Error ? error.message : "The ratings could not be cleared.";
      setLoadError(nextError);
      await message(nextError, {
        title: "Reset failed",
        kind: "error",
      });
    } finally {
      isPersistingDecisionRef.current = false;
      setIsPersistingDecision(false);
    }
  };

  const toggleFocusView = () => {
    const nextCollapsed = !isFocusView;
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

  const loadPhotoPreview = useEffectEvent(async (photo: Photo) => {
    if (
      !photo.isRaw ||
      photo.previewStatus !== "pending" ||
      previewRequestsRef.current.has(photo.id)
    ) {
      return;
    }

    previewRequestsRef.current.add(photo.id);
    setPhotos((current) =>
      updatePhotoPreviewState(current, photo.id, {
        previewError: "",
        previewStatus: "loading",
      }),
    );

    try {
      const preview = await invoke<BackendPreview>("render_photo_preview", {
        path: photo.path,
      });

      setPhotos((current) =>
        updatePhotoPreviewState(current, photo.id, {
          previewError: "",
          previewPath: preview.previewPath,
          previewStatus: preview.previewReady ? "ready" : "pending",
          url: preview.previewReady ? convertFileSrc(preview.previewPath) : "",
        }),
      );
    } catch (error) {
      const nextError =
        error instanceof Error
          ? error.message
          : "Could not render the RAW preview.";

      setPhotos((current) =>
        updatePhotoPreviewState(current, photo.id, {
          previewError: nextError,
          previewStatus: "error",
          url: "",
        }),
      );
    } finally {
      previewRequestsRef.current.delete(photo.id);
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

    if ((event.key === "o" || event.key === "O") && !isLoading && !isPersistingDecision) {
      event.preventDefault();
      void loadFolder();
      return;
    }

    if (!photos.length || isPersistingDecisionRef.current) {
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
        void applyDecision("pick");
        break;
      case "2":
        event.preventDefault();
        void applyDecision("hold");
        break;
      case "3":
      case "Backspace":
        event.preventDefault();
        void applyDecision("reject");
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

    if (!matchesFilter(selectedPhoto.decision, stripFilter) && filteredStripPhotos.length) {
      setSelectedIndex(findPhotoIndex(photos, filteredStripPhotos[0].id));
    }
  }, [filteredStripPhotos, photos, selectedPhoto, stripFilter]);

  useEffect(() => {
    if (selectedPhoto) {
      void loadPhotoMetadata(selectedPhoto);
    }

    if (showImageValues && comparePhoto) {
      void loadPhotoMetadata(comparePhoto);
    }
  }, [comparePhoto, loadPhotoMetadata, selectedPhoto, showImageValues]);

  useEffect(() => {
    const previewCandidates = pickPreviewCandidates({
      comparePhoto,
      navigablePhotos,
      selectedNavigableIndex,
      selectedPhoto,
      showCompare,
    });

    for (const photo of previewCandidates) {
      void loadPhotoPreview(photo);
    }
  }, [
    comparePhoto,
    loadPhotoPreview,
    navigablePhotos,
    selectedNavigableIndex,
    selectedPhoto,
    showCompare,
  ]);

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
  const rawPreviewStatusText = formatRawPreviewStatus(rawPreviewCounts);
  const renderViewerControls = () => (
    <>
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
        disabled={!showCompare && !comparePhoto}
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
    </>
  );

  return (
    <main
      ref={shellRef}
      className={[
        "inspector-shell",
        isTopbarCollapsed ? "is-topbar-collapsed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={shellStyle}
    >
      {isLoading ? (
        <div aria-live="polite" className="loading-overlay" role="status">
          <div className="loading-overlay__panel">
            <span aria-hidden="true" className="loading-overlay__spinner" />
            <div>
              <strong>Loading folder</strong>
              <p>Scanning files. RAW previews render as frames open.</p>
            </div>
          </div>
        </div>
      ) : null}

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
          {renderViewerControls()}
          <button
            className="button button--primary"
            onClick={() => void loadFolder()}
            disabled={isLoading || isPersistingDecision}
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
            onClick={() => void clearAllDecisions()}
            disabled={!photos.some((photo) => photo.decision !== "unrated") || isPersistingDecision}
            type="button"
          >
            Reset Ratings
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
            <p className="session-note">
              {isLoading
                ? "Scanning files. RAW previews render after the list opens."
                : rawPreviewStatusText ||
                  "Ratings sort into pick, hold, and reject folders as you go."}
            </p>
            {loadError ? <p className="session-error">{loadError}</p> : null}
          </div>

          <div className="rail__section">
            <p className="section-label">Filters</p>
            <div className="filter-row">
              {FILTERS.map((filter) => {
                const isActive = isFilterActive(stripFilter, filter.value);

                return (
                  <button
                    key={filter.value}
                    aria-pressed={isActive}
                    className={isActive ? "filter-pill is-active" : "filter-pill"}
                    onClick={() => toggleStripFilter(filter.value)}
                    type="button"
                  >
                    <span>{filter.label}</span>
                    <span>{countForFilter(counts, filter.value)}</span>
                  </button>
                );
              })}
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
                  const decision = photo.decision;
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
                        {photo.previewStatus === "ready" && photo.url ? (
                          <img
                            src={photo.url}
                            alt={photo.name}
                            loading="lazy"
                            draggable={false}
                          />
                        ) : (
                          <span className="filmstrip__thumb-placeholder">
                            {photo.previewStatus === "error" ? "RAW failed" : "RAW"}
                          </span>
                        )}
                      </div>

                      <div className="filmstrip__meta">
                        <strong>{photo.name}</strong>
                        {photo.formats.length > 1 ? (
                          <div
                            aria-label={`Available formats: ${photo.formats.join(", ")}`}
                            className="format-badges"
                          >
                            {photo.formats.map((format) => (
                              <span className="format-badge" key={format}>
                                {format}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        <span title={photo.directory}>{summarizePath(photo.directory)}</span>
                      </div>
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
          {photos.length ? (
            <div
              className={[
                "compare-grid",
                showCompare && comparePhoto ? "" : "compare-grid--single",
                `compare-grid--${activeDecision}`,
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <PhotoStage
                decision={activeDecision}
                emphasis="primary"
                isMetadataLoading={isSelectedPhotoMetadataLoading}
                overlayMetadata={
                  showImageValues
                    ? pickStageOverlayMetadata(selectedPhotoMetadata)
                    : undefined
                }
                photo={selectedPhoto}
                showMetadataOverlay={showImageValues}
                viewerState={viewerState}
                onViewerChange={setViewerState}
              />
              {showCompare && comparePhoto ? (
                <PhotoStage
                  decision={compareDecision}
                  isMetadataLoading={isComparePhotoMetadataLoading}
                  overlayMetadata={
                    showImageValues
                      ? pickStageOverlayMetadata(comparePhotoMetadata)
                      : undefined
                  }
                  photo={comparePhoto}
                  showMetadataOverlay={showImageValues}
                  viewerState={viewerState}
                  onViewerChange={setViewerState}
                />
              ) : null}
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
                disabled={isLoading || isPersistingDecision}
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
                disabled={!selectedPhoto || isPersistingDecision}
                onClick={() => void applyDecision("pick")}
                type="button"
              >
                <strong>1</strong>
                <span>Pick</span>
              </button>
              <button
                className="decision-button decision-button--hold"
                disabled={!selectedPhoto || isPersistingDecision}
                onClick={() => void applyDecision("hold")}
                type="button"
              >
                <strong>2</strong>
                <span>Hold</span>
              </button>
              <button
                className="decision-button decision-button--reject"
                disabled={!selectedPhoto || isPersistingDecision}
                onClick={() => void applyDecision("reject")}
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
                  {selectedPhoto.formats.length > 1 ? (
                    <div className="detail-list__row">
                      <span>Formats</span>
                      <strong>{selectedPhoto.formats.join(" + ")}</strong>
                    </div>
                  ) : null}
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

function createPhoto(photo: BackendPhoto): Photo {
  const previewStatus = photo.previewReady ? "ready" : "pending";

  return {
    ...photo,
    previewError: "",
    previewStatus,
    url: photo.previewReady ? convertFileSrc(photo.previewPath) : "",
  };
}

function countDecisions(photos: Photo[]): DecisionCounts {
  return photos.reduce<DecisionCounts>(
    (counts, photo) => {
      counts[photo.decision] += 1;
      return counts;
    },
    { pick: 0, hold: 0, reject: 0, unrated: 0 },
  );
}

function countRawPreviewStates(photos: Photo[]) {
  return photos.reduce(
    (counts, photo) => {
      if (!photo.isRaw || photo.previewStatus === "ready") {
        return counts;
      }

      counts[photo.previewStatus] += 1;
      return counts;
    },
    { pending: 0, loading: 0, error: 0 },
  );
}

function formatRawPreviewStatus(counts: ReturnType<typeof countRawPreviewStates>) {
  if (counts.loading > 0) {
    return `Rendering ${counts.loading} RAW preview${counts.loading === 1 ? "" : "s"}.`;
  }

  if (counts.pending > 0) {
    return `${counts.pending} RAW preview${counts.pending === 1 ? "" : "s"} waiting.`;
  }

  if (counts.error > 0) {
    return `${counts.error} RAW preview${counts.error === 1 ? "" : "s"} could not render.`;
  }

  return "";
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
  return filter.includes(decision);
}

function isAllStripFilter(filter: StripFilter) {
  return FILTERABLE_DECISIONS.every((decision) => filter.includes(decision));
}

function isFilterActive(filter: StripFilter, value: FilterPillValue) {
  return filter.includes(value);
}

function countForFilter(counts: DecisionCounts, filter: FilterPillValue) {
  return counts[filter];
}

function findNextSelectionId({
  photos,
  currentFilteredPhotos,
  currentSelectedId,
  stripFilter,
  isAllFilterSelected,
  fallbackPhotoId,
}: {
  photos: Photo[];
  currentFilteredPhotos: Photo[];
  currentSelectedId: string;
  stripFilter: StripFilter;
  isAllFilterSelected: boolean;
  fallbackPhotoId?: string;
}) {
  if (isAllFilterSelected) {
    return fallbackPhotoId ?? currentSelectedId;
  }

  const nextFilteredPhotos = photos.filter((photo) => matchesFilter(photo.decision, stripFilter));

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

function pickPreviewCandidates({
  comparePhoto,
  navigablePhotos,
  selectedNavigableIndex,
  selectedPhoto,
  showCompare,
}: {
  comparePhoto: Photo | null;
  navigablePhotos: Photo[];
  selectedNavigableIndex: number;
  selectedPhoto: Photo | null;
  showCompare: boolean;
}) {
  const candidates: Photo[] = [];
  const seen = new Set<string>();
  const addCandidate = (photo: Photo | null | undefined) => {
    if (
      !photo ||
      !photo.isRaw ||
      photo.previewStatus !== "pending" ||
      seen.has(photo.id)
    ) {
      return;
    }

    seen.add(photo.id);
    candidates.push(photo);
  };

  addCandidate(selectedPhoto);

  if (showCompare) {
    addCandidate(comparePhoto);
  }

  if (selectedNavigableIndex !== -1) {
    addCandidate(navigablePhotos[selectedNavigableIndex + 1]);
    addCandidate(navigablePhotos[selectedNavigableIndex + 2]);
  }

  return candidates;
}

function updatePhotoPreviewState(
  photos: Photo[],
  photoId: string,
  updates: Partial<Pick<Photo, "previewError" | "previewPath" | "previewStatus" | "url">>,
) {
  let didUpdate = false;

  const nextPhotos = photos.map((photo) => {
    if (photo.id !== photoId) {
      return photo;
    }

    didUpdate = true;
    return { ...photo, ...updates };
  });

  return didUpdate ? nextPhotos : photos;
}

function summarizePath(path: string) {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join(" / ") || path;
}

function applyMovedPhotos(photos: Photo[], movedPhotos: MovedPhoto[]) {
  const movedPhotoMap = new Map<string, MovedPathMapping>();

  for (const movedPhoto of movedPhotos) {
    for (const mapping of getMovedPathMappings(movedPhoto)) {
      movedPhotoMap.set(mapping.sourcePath, mapping);
    }
  }

  return sortPhotosByName(
    photos.map((photo) => {
      const movedPhoto = movedPhotoMap.get(photo.path);

      if (!movedPhoto) {
        return photo;
      }

      const destinationPath = movedPhoto.destinationPath;
      const previewMove = movedPhotoMap.get(photo.previewPath);
      const nextPreviewPath = isBrowserViewableExtension(photo.extension)
        ? destinationPath
        : previewMove?.destinationPath ?? photo.previewPath;
      const nextUrl = photo.previewStatus === "ready"
        ? convertFileSrc(nextPreviewPath)
        : "";

      return {
        ...photo,
        id: destinationPath,
        path: destinationPath,
        directory: parentPath(destinationPath),
        previewPath: nextPreviewPath,
        url: nextUrl,
        decision: movedPhoto.decision,
      };
    }),
  );
}

function sortPhotosByName(photos: Photo[]) {
  return [...photos].sort((left, right) => {
    const nameComparison = left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });

    if (nameComparison !== 0) {
      return nameComparison;
    }

    return left.path.localeCompare(right.path, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function remapPhotoState<T>(current: Record<string, T>, movedPhotos: MovedPhoto[]) {
  let nextState = current;

  for (const movedPhoto of movedPhotos) {
    for (const mapping of getMovedPathMappings(movedPhoto)) {
      const sourcePath =
        mapping.sourcePath !== mapping.destinationPath &&
        Object.prototype.hasOwnProperty.call(nextState, mapping.sourcePath)
          ? mapping.sourcePath
          : undefined;

      if (!sourcePath) {
        continue;
      }

      if (nextState === current) {
        nextState = { ...current };
      }

      const stateValue = nextState[sourcePath];
      delete nextState[sourcePath];
      nextState[mapping.destinationPath] = stateValue;
    }
  }

  return nextState;
}

function matchesMovedPhotoPath(movedPhoto: MovedPhoto, path: string) {
  return getMovedPhotoSourcePaths(movedPhoto).includes(path);
}

function getMovedPhotoSourcePaths(movedPhoto: MovedPhoto) {
  return [movedPhoto.sourcePath, movedPhoto.requestedSourcePath].filter(
    (sourcePath): sourcePath is string => Boolean(sourcePath),
  );
}

type MovedPathMapping = {
  sourcePath: string;
  destinationPath: string;
  decision: PhotoDecision;
};

function getMovedPathMappings(movedPhoto: MovedPhoto): MovedPathMapping[] {
  return [
    ...getMovedPhotoSourcePaths(movedPhoto).map((sourcePath) => ({
      sourcePath,
      destinationPath: movedPhoto.destinationPath,
      decision: movedPhoto.decision,
    })),
    ...(movedPhoto.companions ?? []).map((companion) => ({
      sourcePath: companion.sourcePath,
      destinationPath: companion.destinationPath,
      decision: movedPhoto.decision,
    })),
  ];
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
