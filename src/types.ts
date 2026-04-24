export type PhotoDecision = "pick" | "hold" | "reject" | "unrated";

export type FilterPillValue = PhotoDecision;

export type StripFilter = PhotoDecision[];

export type ViewerState = {
  zoom: number;
  centerX: number;
  centerY: number;
};

export type PhotoMetadataValue = {
  label: string;
  value: string;
};

export type PreviewStatus = "ready" | "pending" | "loading" | "error";

export type BackendPhoto = {
  id: string;
  path: string;
  name: string;
  extension: string;
  directory: string;
  previewPath: string;
  previewReady: boolean;
  isRaw: boolean;
  decision: PhotoDecision;
};

export type BackendPreview = {
  path: string;
  previewPath: string;
  previewReady: boolean;
};

export type Photo = BackendPhoto & {
  previewStatus: PreviewStatus;
  previewError: string;
  url: string;
};

export type DecisionCounts = Record<PhotoDecision, number>;

export type MovePhotoDecision = {
  path: string;
  decision: PhotoDecision;
};

export type MovedPhoto = {
  sourcePath: string;
  requestedSourcePath?: string;
  destinationPath: string;
  decision: PhotoDecision;
};

export type MoveSummary = {
  destinationRoot: string;
  movedCount: number;
  movedPhotos: MovedPhoto[];
};

export const DEFAULT_VIEWER_STATE: ViewerState = {
  zoom: 1,
  centerX: 0.5,
  centerY: 0.5,
};
