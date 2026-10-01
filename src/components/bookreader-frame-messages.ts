import type {
  AnnotationSelection,
  DocumentAnnotation,
} from "../shared/document-annotations";

export type ReaderCommand =
  | {
      source: "drevo-bookreader";
      type: "init";
      url: string;
      mimeType: string;
      initialPage: number;
      title: string;
      downloadName: string;
      metadata: { label: string; value: string }[];
      canEdit: boolean;
    }
  | {
      source: "drevo-bookreader";
      type: "state";
      annotations: DocumentAnnotation[];
      activeAnnotation: string;
      annotating: boolean;
      magnifier: boolean;
      commentsOpen: boolean;
      selection: AnnotationSelection | null;
    }
  | { source: "drevo-bookreader"; type: "jump"; page: number };

export type ReaderEvent =
  | { source: "drevo-bookreader"; type: "ready" }
  | { source: "drevo-bookreader"; type: "loaded"; pageCount: number }
  | { source: "drevo-bookreader"; type: "page"; page: number }
  | { source: "drevo-bookreader"; type: "magnifier-off" }
  | { source: "drevo-bookreader"; type: "toggle-magnifier" }
  | { source: "drevo-bookreader"; type: "toggle-comments" }
  | { source: "drevo-bookreader"; type: "edit" }
  | { source: "drevo-bookreader"; type: "close" }
  | {
      source: "drevo-bookreader";
      type: "outline";
      items: { title: string; page: number; depth: number }[];
    }
  | {
      source: "drevo-bookreader";
      type: "selection";
      selection: AnnotationSelection;
    }
  | { source: "drevo-bookreader"; type: "error"; message: string };
