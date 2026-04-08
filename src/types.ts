export type PhotoDecision = "pick" | "hold" | "reject" | "unrated";

export type StripFilter = "all" | PhotoDecision;

export type ViewerState = {
  zoom: number;
  centerX: number;
  centerY: number;
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

export const DEFAULT_VIEWER_STATE: ViewerState = {
  zoom: 1,
  centerX: 0.5,
  centerY: 0.5,
};
