export type PhotoDecision = "pick" | "hold" | "reject" | "unrated";

export type StripFilter = "all" | PhotoDecision;

export type ViewerState = {
  zoom: number;
  centerX: number;
  centerY: number;
};

export type PhotoMetadataValue = {
  label: string;
  value: string;
};

export type BackendPhoto = {
  id: string;
  path: string;
  name: string;
  extension: string;
  directory: string;
  previewPath: string;
};

export type Photo = BackendPhoto & {
  url: string;
};

export type DecisionCounts = Record<PhotoDecision, number>;

export type ExportPhotoDecision = {
  path: string;
  decision: PhotoDecision;
};

export type MovedPhoto = {
  sourcePath: string;
  destinationPath: string;
};

export type ExportSummary = {
  destinationRoot: string;
  exportedCount: number;
  movedPhotos: MovedPhoto[];
};

export type ExportProgress = {
  processedCount: number;
  totalCount: number;
  currentName: string;
  currentDecision: PhotoDecision;
};

export const DEFAULT_VIEWER_STATE: ViewerState = {
  zoom: 1,
  centerX: 0.5,
  centerY: 0.5,
};
