// ===== 型定義 =====

export interface Annotation {
  id: string;
  type: 'pen' | 'eraser_pixel' | 'line' | 'rect' | 'circle' | 'arrow' | 'text' | 'handwriting_text';
  points?: { x: number; y: number }[];
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  midX?: number;
  midY?: number;
  color?: string;
  width?: number;
  fillColor?: string;
  isFillTransparent?: boolean;
  text?: string;
  fontSize?: number;
  x?: number;
  y?: number;
  rotation?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  tx?: number;
  ty?: number;
  hasGlow?: boolean;
  erasers?: Annotation[];
  _w?: number;
  _h?: number;
}

export interface ImageData {
  id: string;
  uri: string;
  width: number;
  height: number;
  annotations: Annotation[];
}

export interface MemoItem {
  id: string;
  memo: string;
  images: ImageData[];
  createdAt: Date | string;
  updatedAt?: Date | string;
  layout?: LayoutSettings;
}

export interface LayoutSettings {
  template: string;
  memoRect: { x: number; y: number; w: number; h: number };
  customImageRects: { x: number; y: number; w: number; h: number }[];
}

export interface Project {
  id: string;
  title: string;
  createdAt: Date | string;
  items: MemoItem[];
}

export type ToolType =
  | 'select'
  | 'lasso'
  | 'pen'
  | 'handwriting_text'
  | 'eraser_pixel'
  | 'eraser_obj'
  | 'line'
  | 'rect'
  | 'circle'
  | 'arrow'
  | 'text';

export interface EditorPrefs {
  shape: { lineWidth: number; textGlow: boolean };
  text: { fontSize: number; textGlow: boolean };
  freehand: { lineWidth: number; textGlow: boolean };
}
