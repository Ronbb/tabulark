/** Stable 0.1 browser entrypoint. */
export { createEngine } from "./client.js";
export { delimitedAdapter } from "./adapters.js";
export type {
  DatasetEvent,
  DatasetSession,
  EngineOptions,
  OpenSourceOptions,
  ReadRangeOptions,
  RuntimeProgress,
  SourceWarning,
  TableEvent,
  TableHandle,
  TabularkEngine,
  Unsubscribe,
} from "./client.js";
export type {
  AdapterDescriptor,
  DelimitedAdapterOptions,
  DelimitedDialect,
  HeaderMode,
  OfficialAdapterId,
  ParseMode,
} from "./adapters.js";
export { TabularkError } from "./errors.js";
export type { TabularkErrorCode } from "./errors.js";
export type {
  ArrowDataType,
  ArrowField,
  AxisExtent,
  ColumnSchema,
  DecimalValue,
  IntervalValue,
  MapEntryValue,
  MergedCellRegion,
  NativeListValue,
  NativeMapValue,
  NativeStructValue,
  NativeValue,
  PresentationAxisEntry,
  PresentationBorderSide,
  PresentationColor,
  PresentationFont,
  PresentationRange,
  PresentationStyle,
  RangeRequest,
  ReturnedRange,
  SpreadsheetPresentation,
  SpreadsheetPresentationRange,
  TableBatch,
  TableBatchColumn,
  TableCapabilities,
  TableDescriptor,
  TableExtent,
  TableMetadata,
  TablePresentation,
  TemporalValue,
  TimeUnit,
  ToRowsOptions,
  UnionValue,
  WorksheetVisibility,
} from "./model.js";

export { createCanvasTableView } from "./view/canvas-table-view-public.js";
export type {
  CanvasTableView,
  CanvasTableViewControllerOptions,
  CanvasTableViewOptions,
  CanvasTableViewTheme,
} from "./view/canvas-table-view-public.js";
