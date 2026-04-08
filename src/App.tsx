import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { message, open } from "@tauri-apps/plugin-dialog";
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useState,
} from "react";
import { PhotoStage } from "./components/PhotoStage";
import {
  type BackendPhoto,
  type DecisionCounts,
  type Photo,
  type PhotoDecision,
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

const DECISION_ACCENT: Record<Exclude<PhotoDecision, "unrated">, string> = {
  pick: "pick",
  hold: "hold",
  reject: "reject",
};

function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [decisions, setDecisions] = useState<Record<string, PhotoDecision>>({});
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [stripFilter, setStripFilter] = useState<StripFilter>("all");
  const [showCompare, setShowCompare] = useState(false);
  const [viewerState, setViewerState] = useState(DEFAULT_VIEWER_STATE);
  const [folderPath, setFolderPath] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

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
  const activeDecision = selectedPhoto
    ? resolveDecision(decisions, selectedPhoto.id)
    : "unrated";

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
        setViewerState(DEFAULT_VIEWER_STATE);
        setFolderPath(selectedPath);
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

  return (
    <main className="inspector-shell">
      <header className="topbar">
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
        </div>
      </header>

      <section className="workspace">
        <aside className="rail rail--left">
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
              <div className="filmstrip">
                {filteredStripPhotos.map((photo) => {
                  const decision = resolveDecision(decisions, photo.id);
                  const isSelected = photo.id === selectedPhoto?.id;

                  return (
                    <button
                      key={photo.id}
                      className={
                        isSelected
                          ? "filmstrip__item is-selected"
                          : "filmstrip__item"
                      }
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
                        className={`decision-dot decision-dot--${decision}`}
                        aria-label={decision}
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
                  label="Previous frame"
                  photo={comparePhoto}
                  viewerState={viewerState}
                  onViewerChange={setViewerState}
                />
              ) : null}
              <PhotoStage
                detail={showCompare && comparePhoto ? "Active" : "Selected"}
                emphasis="primary"
                label="Current frame"
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

        <aside className="rail rail--right">
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
            <p className="section-label">Current</p>
            {selectedPhoto ? (
              <div className="detail-list">
                <div className="detail-list__row">
                  <span>Name</span>
                  <strong>{selectedPhoto.name}</strong>
                </div>
                <div className="detail-list__row">
                  <span>Status</span>
                  <strong
                    className={
                      activeDecision === "unrated"
                        ? "decision-tag"
                        : `decision-tag decision-tag--${DECISION_ACCENT[activeDecision]}`
                    }
                  >
                    {activeDecision}
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

export default App;
