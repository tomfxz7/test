import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  FolderOpen, Plus, Camera, Image as ImageIcon, 
  PenTool, Square, Circle, ArrowUpRight, Type, 
  Undo, Trash2, Save, ChevronLeft, Printer, 
  Droplet, FileText, Maximize, Minimize, MousePointer2, Eraser,
  Scaling, Sparkles, Minus, Lasso, ScanText, Loader2, Hand, PenLine, Settings,
  Download, Upload, Presentation, Copy, ClipboardPaste, X, RefreshCw, Link, Unlink, LayoutTemplate, ChevronDown, ChevronUp, GripVertical, Edit, Redo2
} from 'lucide-react';

// --- Constants & Types ---
const ToolType = {
  SELECT: 'select', LASSO: 'lasso', PEN: 'pen', HANDWRITING_TEXT: 'handwriting_text',
  ERASER_PIXEL: 'eraser_pixel', ERASER_OBJ: 'eraser_obj', LINE: 'line', RECT: 'rect',
  CIRCLE: 'circle', ARROW: 'arrow', TEXT: 'text'
};

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#000000', '#ffffff'];
const APP_VERSION = 'v1.2.5';
// NOTE: merge-conflict resolution — keep IndexedDB constants used by project persistence.
const APP_DB_NAME = 'eval_report_db';
const APP_DB_VERSION = 1;
const APP_DB_STORE = 'app_data';
const PROJECTS_KEY = 'eval_report_projects';

// オフスクリーンキャンバス
let offCanvas = null;
let offCtx = null;
if (typeof document !== 'undefined') {
  offCanvas = document.createElement('canvas');
  offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
}

// Math Helpers
const dist2 = (v, w) => Math.pow(v.x - w.x, 2) + Math.pow(v.y - w.y, 2);
const distToSegment = (p, v, w) => {
  const l2 = dist2(v, w);
  if (l2 === 0) return Math.sqrt(dist2(p, v));
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.sqrt(dist2(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) }));
};

const simplifyLine = (points, tolerance) => {
  if (points.length <= 2) return points;
  let maxDistance = 0; let index = 0; const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = distToSegment(points[i], points[0], points[end]);
    if (d > maxDistance) { maxDistance = d; index = i; }
  }
  if (maxDistance > tolerance) {
    const rec1 = simplifyLine(points.slice(0, index + 1), tolerance);
    const rec2 = simplifyLine(points.slice(index, end + 1), tolerance);
    return rec1.slice(0, rec1.length - 1).concat(rec2);
  } else return [points[0], points[end]];
};

const getBBox = (a) => {
  let bbox = null;
  if ((a.type === 'pen' || a.type === 'handwriting_text' || a.type === 'eraser_pixel') && a.points?.length > 0) {
    let minX = a.points[0].x, maxX = a.points[0].x, minY = a.points[0].y, maxY = a.points[0].y;
    for (let p of a.points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    bbox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  } else if (['rect', 'circle', 'triangle', 'star', 'arrow', 'line', 'curve', 'curve_arrow', 'polyline', 'double_arrow', 'double_curve_arrow', 'polygon'].includes(a.type)) {
    if (['polyline', 'polygon'].includes(a.type) && a.points?.length > 0) {
      let minX = a.points[0].x, maxX = a.points[0].x, minY = a.points[0].y, maxY = a.points[0].y;
      for (let p of a.points) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      bbox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    } else {
      let minX = Math.min(a.startX, a.endX), maxX = Math.max(a.startX, a.endX);
      let minY = Math.min(a.startY, a.endY), maxY = Math.max(a.startY, a.endY);
      if (a.midX !== undefined && a.midY !== undefined) {
        minX = Math.min(minX, a.midX); maxX = Math.max(maxX, a.midX);
        minY = Math.min(minY, a.midY); maxY = Math.max(maxY, a.midY);
      }
      bbox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
  } else if (a.type === 'text') {
    const w = a._w || 100; const h = a._h || (a.fontSize || 48);
    bbox = { x: a.x - w / 2, y: a.y - h / 2, w: w, h: h };
  }
  if (bbox) {
    if (bbox.w < 10) { bbox.x -= 5; bbox.w = 10; }
    if (bbox.h < 10) { bbox.y -= 5; bbox.h = 10; }
    return bbox;
  }
  return null;
};

const transformPoint = (x, y, ann) => {
  if (['arrow', 'line', 'curve', 'curve_arrow', 'polyline', 'double_arrow', 'double_curve_arrow', 'polygon'].includes(ann.type)) return { x, y };
  const bbox = getBBox(ann);
  if (!bbox) return { x, y };
  const cx = bbox.x + bbox.w/2; const cy = bbox.y + bbox.h/2;
  let dx = (x - cx) * (ann.scaleX || ann.scale || 1); let dy = (y - cy) * (ann.scaleY || ann.scale || 1);
  const r = ann.rotation || 0; const cos = Math.cos(r), sin = Math.sin(r);
  return { x: (dx * cos - dy * sin) + cx + (ann.tx || 0), y: (dx * sin + dy * cos) + cy + (ann.ty || 0) };
};

const inverseTransformPoint = (gx, gy, ann) => {
  if (['arrow', 'line', 'curve', 'curve_arrow', 'polyline', 'double_arrow', 'double_curve_arrow', 'polygon'].includes(ann.type)) return { x: gx, y: gy };
  const bbox = getBBox(ann);
  if (!bbox) return { x: gx, y: gy };
  const cx = bbox.x + bbox.w/2; const cy = bbox.y + bbox.h/2;
  let dx = gx - (cx + (ann.tx || 0)); let dy = gy - (cy + (ann.ty || 0));
  const r = -(ann.rotation || 0); const cos = Math.cos(r), sin = Math.sin(r);
  let rdx = dx * cos - dy * sin; let rdy = dx * sin + dy * cos;
  rdx /= (ann.scaleX || ann.scale || 1); rdy /= (ann.scaleY || ann.scale || 1);
  return { x: rdx + cx, y: rdy + cy };
};

const getMultiBBox = (anns, ids) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasValid = false;
  for (const id of ids) {
    const ann = anns.find(a => a.id === id);
    if (!ann) continue;
    const bbox = getBBox(ann);
    if (!bbox) continue;
    const pts = [
      transformPoint(bbox.x, bbox.y, ann), transformPoint(bbox.x + bbox.w, bbox.y, ann),
      transformPoint(bbox.x + bbox.w, bbox.y + bbox.h, ann), transformPoint(bbox.x, bbox.y + bbox.h, ann)
    ];
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    hasValid = true;
  }
  if (!hasValid) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

const pointInPolygon = (point, vs) => {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    let xi = vs[i].x, yi = vs[i].y; let xj = vs[j].x, yj = vs[j].y;
    let intersect = ((yi > point.y) !== (yj > point.y)) && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
};

const splitAnnotationByEraser = (ann, eraserPoints, eraserWidth) => {
  if (ann.type === 'text') {
     return [{ ...ann, erasers: [...(ann.erasers || []), { type: 'eraser_pixel', width: eraserWidth, points: eraserPoints.map(p => inverseTransformPoint(p.x, p.y, ann)) }] }];
  }

  let paths = []; 
  if (['pen', 'handwriting_text', 'eraser_pixel', 'polyline', 'polygon'].includes(ann.type)) {
     paths = [ann.points.map(p => transformPoint(p.x, p.y, ann))];
     if (ann.type === 'polygon' && paths[0].length > 0) {
       paths[0].push({...paths[0][0]}); 
     }
  } else if (ann.type === 'line') {
     paths = [[transformPoint(ann.startX, ann.startY, ann), transformPoint(ann.endX, ann.endY, ann)]];
  } else if (ann.type === 'rect') {
     const r1 = transformPoint(ann.startX, ann.startY, ann);
     const r2 = transformPoint(ann.endX, ann.startY, ann);
     const r3 = transformPoint(ann.endX, ann.endY, ann);
     const r4 = transformPoint(ann.startX, ann.endY, ann);
     paths = [[r1, r2, r3, r4, r1]];
  } else if (ann.type === 'triangle') {
     const t1 = transformPoint((ann.startX + ann.endX)/2, ann.startY, ann);
     const t2 = transformPoint(ann.endX, ann.endY, ann);
     const t3 = transformPoint(ann.startX, ann.endY, ann);
     paths = [[t1, t2, t3, t1]];
  } else if (ann.type === 'circle') {
     const cx = (ann.startX + ann.endX) / 2; const cy = (ann.startY + ann.endY) / 2;
     const rx = Math.abs(ann.endX - ann.startX) / 2; const ry = Math.abs(ann.endY - ann.startY) / 2;
     const pts = [];
     for(let a=0; a<=Math.PI*2; a+=Math.PI/18) {
       pts.push(transformPoint(cx + Math.cos(a)*rx, cy + Math.sin(a)*ry, ann));
     }
     paths = [pts];
  } else if (ann.type === 'star') {
      const c_x = (ann.startX + ann.endX)/2, c_y = (ann.startY + ann.endY)/2, rx = Math.abs(ann.endX-ann.startX)/2, ry = Math.abs(ann.endY-ann.startY)/2;
      const outR = Math.min(rx, ry), inR = outR * 0.4; let r_ang = -Math.PI/2, step = Math.PI/5, pts = [];
      for(let i=0; i<=5; i++){ 
          pts.push(transformPoint(c_x + Math.cos(r_ang)*outR, c_y + Math.sin(r_ang)*outR, ann)); 
          r_ang+=step; 
          if(i<5) pts.push(transformPoint(c_x + Math.cos(r_ang)*inR, c_y + Math.sin(r_ang)*inR, ann)); 
          r_ang+=step; 
      }
      paths = [pts];
  } else if (ann.type === 'arrow' || ann.type === 'double_arrow') {
     const p1 = transformPoint(ann.startX, ann.startY, ann); const p2 = transformPoint(ann.endX, ann.endY, ann);
     paths.push([p1, p2]);
     const hl = Math.max(15, (ann.width || 4) * 3); 
     const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
     paths.push([p2, {x: p2.x - hl*Math.cos(ang-Math.PI/6), y: p2.y - hl*Math.sin(ang-Math.PI/6)}]);
     paths.push([p2, {x: p2.x - hl*Math.cos(ang+Math.PI/6), y: p2.y - hl*Math.sin(ang+Math.PI/6)}]);
     if (ann.type === 'double_arrow') {
       paths.push([p1, {x: p1.x + hl*Math.cos(ang-Math.PI/6), y: p1.y + hl*Math.sin(ang-Math.PI/6)}]);
       paths.push([p1, {x: p1.x + hl*Math.cos(ang+Math.PI/6), y: p1.y + hl*Math.sin(ang+Math.PI/6)}]);
     }
  } else if (['curve', 'curve_arrow', 'double_curve_arrow'].includes(ann.type)) {
     const pts = [];
     const start = transformPoint(ann.startX, ann.startY, ann), end = transformPoint(ann.endX, ann.endY, ann);
     if (ann.midX !== undefined) {
       const mid = transformPoint(ann.midX, ann.midY, ann);
       for(let t=0; t<=1; t+=0.05) {
         pts.push({
           x: Math.pow(1-t, 2)*start.x + 2*(1-t)*t*mid.x + Math.pow(t, 2)*end.x,
           y: Math.pow(1-t, 2)*start.y + 2*(1-t)*t*mid.y + Math.pow(t, 2)*end.y
         });
       }
     } else {
       pts.push(start, end);
     }
     paths.push(pts);
  } else {
     return [{ ...ann, erasers: [...(ann.erasers || []), { type: 'eraser_pixel', width: eraserWidth, points: eraserPoints.map(p => inverseTransformPoint(p.x, p.y, ann)) }] }];
  }

  const isErased = (p) => {
    const threshold = (ann.width || 4) / 2 + eraserWidth / 2;
    for (let i = 0; i < eraserPoints.length - 1; i++) {
      if (distToSegment(p, eraserPoints[i], eraserPoints[i+1]) < threshold) return true;
    }
    if (ann.erasers) {
      for (const er of ann.erasers) {
        const erThresh = (ann.width || 4) / 2 + (er.width || 4) / 2;
        const pts = er.points.map(ep => transformPoint(ep.x, ep.y, ann));
        for (let i = 0; i < pts.length - 1; i++) {
          if (distToSegment(p, pts[i], pts[i+1]) < erThresh) return true;
        }
      }
    }
    return false;
  };

  const newSegments = [];
  paths.forEach(path => {
    const interpolated = [];
    for (let i = 0; i < path.length - 1; i++) {
      const p1 = path[i]; const p2 = path[i+1];
      const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const steps = Math.max(1, Math.ceil(d / 2)); 
      for (let j = 0; j < steps; j++) {
        interpolated.push({ x: p1.x + (p2.x - p1.x) * (j / steps), y: p1.y + (p2.y - p1.y) * (j / steps) });
      }
    }
    if (path.length > 0) interpolated.push(path[path.length - 1]);

    let currentSegment = [];
    for (const p of interpolated) {
      if (isErased(p)) {
        if (currentSegment.length > 0) { newSegments.push(currentSegment); currentSegment = []; }
      } else {
        currentSegment.push(p);
      }
    }
    if (currentSegment.length > 0) newSegments.push(currentSegment);
  });

  const validSegments = newSegments.filter(seg => {
    if (seg.length < 2) return false;
    let len = 0;
    for(let i=0; i<seg.length-1; i++) len += Math.hypot(seg[i+1].x - seg[i].x, seg[i+1].y - seg[i].y);
    return len > (ann.width || 4) / 2; 
  });

  return validSegments.map((seg, idx) => {
    return {
      type: 'pen',
      id: Date.now().toString() + Math.random().toString(36).substring(2, 9) + `_${idx}`,
      points: seg,
      color: ann.color,
      width: ann.width,
      scaleX: 1, scaleY: 1, rotation: 0, tx: 0, ty: 0,
      hasGlow: ann.hasGlow,
      fillColor: 'transparent',
      groupId: ann.groupId
    };
  });
};

// PPTX Layout Helper
const calculateTemplateLayout = (template, images) => {
  let memoX, memoY, memoW, memoH;
  let imgX, imgY, imgW, imgH;

  if (template === 'top_bottom') {
    memoX = 0.5; memoY = 1.0; memoW = 9.0; memoH = 1.0; imgX = 0.5; imgY = 2.2; imgW = 9.0; imgH = 3.0;
  } else if (template === 'images_only') {
    memoX = null; imgX = 0.5; imgY = 1.0; imgW = 9.0; imgH = 4.2;
  } else {
    memoX = 0.5; memoY = 1.2; memoW = 3.5; memoH = 4.0; imgX = 4.2; imgY = 1.2; imgW = 5.3; imgH = 4.0;
  }

  let layout = [];
  const n = images.length;
  if (n > 0) {
    if (n === 1) layout.push({x: imgX, y: imgY, w: imgW, h: imgH});
    else if (n === 2) { layout.push({x: imgX, y: imgY, w: imgW, h: imgH / 2 - 0.05}); layout.push({x: imgX, y: imgY + imgH / 2 + 0.05, w: imgW, h: imgH / 2 - 0.05}); }
    else if (n === 3 || n === 4) {
        layout.push({x: imgX, y: imgY, w: imgW / 2 - 0.05, h: imgH / 2 - 0.05}); layout.push({x: imgX + imgW / 2 + 0.05, y: imgY, w: imgW / 2 - 0.05, h: imgH / 2 - 0.05});
        if (n >= 3) layout.push({x: imgX, y: imgY + imgH / 2 + 0.05, w: imgW / 2 - 0.05, h: imgH / 2 - 0.05});
        if (n === 4) layout.push({x: imgX + imgW / 2 + 0.05, y: imgY + imgH / 2 + 0.05, w: imgW / 2 - 0.05, h: imgH / 2 - 0.05});
    } else {
       const cols = 2; const rows = Math.ceil(n / 2);
       const cw = imgW / cols - 0.1; const ch = imgH / rows - 0.1;
       for (let i=0; i<n; i++) layout.push({x: imgX + (i%cols)*(cw+0.1), y: imgY + Math.floor(i/cols)*(ch+0.1), w: cw, h: ch});
    }
  }

  const customImageRects = images.map((imgData, i) => {
    if (!layout[i]) return {x: imgX, y: imgY, w: 1, h: 1};
    const {x, y, w, h} = layout[i];
    const baseW = imgData.baseWidth || imgData.baseImage?.width || 1200;
    const baseH = imgData.baseHeight || imgData.baseImage?.height || 800;
    const ratio = Math.min(w / baseW, h / baseH);
    const drawW = baseW * ratio; const drawH = baseH * ratio;
    const drawX = x + (w - drawW) / 2; const drawY = y + (h - drawH) / 2;
    return { x: Math.round(drawX * 100) / 100, y: Math.round(drawY * 100) / 100, w: Math.round(drawW * 100) / 100, h: Math.round(drawH * 100) / 100 };
  });
  return { memoRect: memoX !== null ? { x: memoX, y: memoY, w: memoW, h: memoH } : null, customImageRects };
};

// API Call
const callGeminiAPI = async (payload, customKey) => {
  const apiKey = "";
  const finalApiKey = (customKey || apiKey || '').trim();
  if (!finalApiKey) throw new Error('Gemini APIキーが未設定です。設定画面からAPIキーを保存してください。');
  const modelName = 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${finalApiKey}`;
  const retries = 5;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (response.ok) return data;
      if (i === retries - 1) {
        const apiMessage = data?.error?.message || text || 'Unknown Gemini API error';
        throw new Error(`API Error ${response.status}: ${apiMessage}`);
      }
    } catch (e) { if (i === retries - 1) throw e; }
    await new Promise(res => setTimeout(res, Math.pow(2, i) * 1000));
  }
};

const loadPptxGenJS = async () => {
  if (window.PptxGenJS) return window.PptxGenJS;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';
    script.onload = () => resolve(window.PptxGenJS);
    script.onerror = reject;
    document.head.appendChild(script);
  });
};

const openAppDB = () => {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this environment.'));
      return;
    }
    const request = indexedDB.open(APP_DB_NAME, APP_DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(APP_DB_STORE)) db.createObjectStore(APP_DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB.'));
  });
};

const idbGet = async (key) => {
  const db = await openAppDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(APP_DB_STORE, 'readonly');
    const store = tx.objectStore(APP_DB_STORE);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB read failed.'));
    tx.oncomplete = () => db.close();
    tx.onabort = tx.onerror = () => db.close();
  });
};

const idbSet = async (key, value) => {
  const db = await openAppDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(APP_DB_STORE, 'readwrite');
    const store = tx.objectStore(APP_DB_STORE);
    store.put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error('IndexedDB write failed.')); };
  });
};

const drawAnnotationsOnSlide = (slide, pptx, annotations, drawX, drawY, drawW, baseW) => {
  const pRatio = drawW / baseW;
  annotations.forEach(ann => {
    if (ann.type === 'text') {
      const box = getBBox(ann); if (!box) return;
      const rx = box.x + (ann.tx || 0); const ry = box.y + (ann.ty || 0);
      const rot = (ann.rotation || 0) * (180 / Math.PI);
      const pColor = (ann.color || '#000000').replace('#', '');
      slide.addText(ann.text, {
        x: drawX + rx * pRatio, y: drawY + ry * pRatio, w: Math.max(1, box.w * pRatio), h: Math.max(0.5, box.h * pRatio),
        fontSize: (ann.fontSize || 48) * pRatio * 72, color: pColor, bold: true, rotate: rot, valign: 'middle', align: 'center',
        fontFace: 'Meiryo'
      });
    } else {
      const stroke = ann.color || '#000000'; const pColor = stroke.replace('#', '');
      const sw = ann.width || 4; const pptSw = sw * 0.75;
      const fill = (ann.fillColor && ann.fillColor !== 'transparent') ? ann.fillColor.replace('#', '') : undefined;
      const rawBox = getBBox(ann); if (!rawBox) return;

      const margin = sw + 4; const vbX = rawBox.x - margin; const vbY = rawBox.y - margin; const vbW = rawBox.w + margin * 2; const vbH = rawBox.h + margin * 2;
      const cx = vbX + vbW / 2; const cy = vbY + vbH / 2;
      const transformedCx = cx + (ann.tx || 0); const transformedCy = cy + (ann.ty || 0);
      const sx = ann.scaleX || ann.scale || 1; const sy = ann.scaleY || ann.scale || 1;
      const pptW = vbW * Math.abs(sx) * pRatio; const pptH = vbH * Math.abs(sy) * pRatio;
      const pptCx = drawX + transformedCx * pRatio; const pptCy = drawY + transformedCy * pRatio;
      const pptX = pptCx - pptW / 2; const pptY = pptCy - pptH / 2;
      const rot = (ann.rotation || 0) * (180 / Math.PI);

      if (['rect', 'circle', 'triangle'].includes(ann.type)) {
         let shapeType = ann.type === 'rect' ? pptx.ShapeType.rect : (ann.type === 'circle' ? pptx.ShapeType.ellipse : pptx.ShapeType.triangle);
         const nW = rawBox.w * Math.abs(sx) * pRatio; const nH = rawBox.h * Math.abs(sy) * pRatio;
         const shapeOpts = { x: pptCx - nW / 2, y: pptCy - nH / 2, w: Math.max(0.1, nW), h: Math.max(0.1, nH), line: { color: pColor, width: pptSw }, rotate: rot };
         if (fill) shapeOpts.fill = { color: fill };
         slide.addShape(shapeType, shapeOpts);
      } else if (['line', 'arrow', 'double_arrow'].includes(ann.type)) {
         const startX = ann.startX + (ann.tx || 0);
         const startY = ann.startY + (ann.ty || 0);
         const endX = ann.endX + (ann.tx || 0);
         const endY = ann.endY + (ann.ty || 0);
         
         const pptSx = drawX + startX * pRatio;
         const pptSy = drawY + startY * pRatio;
         const pptEx = drawX + endX * pRatio;
         const pptEy = drawY + endY * pRatio;
         
         let minX = Math.min(pptSx, pptEx);
         let minY = Math.min(pptSy, pptEy);
         let w = Math.abs(pptEx - pptSx);
         let h = Math.abs(pptEy - pptSy);
         w = Math.max(w, 0.01);
         h = Math.max(h, 0.01);
         
         let lineConfig = {
           x: minX, y: minY, w: w, h: h,
           line: { color: pColor, width: pptSw }
         };
         
         if (pptSx > pptEx) lineConfig.flipH = true;
         if (pptSy > pptEy) lineConfig.flipV = true;
         
         if (ann.type === 'arrow') {
             lineConfig.line.endArrowType = 'triangle';
         } else if (ann.type === 'double_arrow') {
             lineConfig.line.beginArrowType = 'triangle';
             lineConfig.line.endArrowType = 'triangle';
         }
         
         slide.addShape(pptx.ShapeType.line, lineConfig);
      } else {
         let svgContent = ''; const svgFill = (ann.fillColor && ann.fillColor !== 'transparent') ? ann.fillColor : 'none';
         if (['pen', 'polyline', 'polygon', 'handwriting_text', 'eraser_pixel'].includes(ann.type) && ann.points?.length > 0) {
             let d = `M ${ann.points[0].x} ${ann.points[0].y}`;
             for (let i = 1; i < ann.points.length; i++) d += ` L ${ann.points[i].x} ${ann.points[i].y}`;
             if (ann.type === 'polygon') d += ' Z';
             svgContent = `<path d="${d}" fill="${svgFill}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" />`;
         } else if (ann.type === 'star') {
            const c_x = (ann.startX + ann.endX)/2, c_y = (ann.startY + ann.endY)/2, rx = Math.abs(ann.endX-ann.startX)/2, ry = Math.abs(ann.endY-ann.startY)/2;
            const outR = Math.min(rx, ry), inR = outR * 0.4; let r_ang = -Math.PI/2, step = Math.PI/5, pts = [];
            for(let i=0; i<5; i++){ pts.push(`${c_x + Math.cos(r_ang)*outR},${c_y + Math.sin(r_ang)*outR}`); r_ang+=step; pts.push(`${c_x + Math.cos(r_ang)*inR},${c_y + Math.sin(r_ang)*inR}`); r_ang+=step; }
            svgContent = `<polygon points="${pts.join(' ')}" fill="${svgFill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" />`;
         } else if (['arrow', 'double_arrow'].includes(ann.type)) {
            const hl = Math.max(15, sw * 3), ang = Math.atan2(ann.endY - ann.startY, ann.endX - ann.startX);
            let d = `M ${ann.startX} ${ann.startY} L ${ann.endX} ${ann.endY} M ${ann.endX} ${ann.endY} L ${ann.endX - hl*Math.cos(ang-Math.PI/6)} ${ann.endY - hl*Math.sin(ang-Math.PI/6)} M ${ann.endX} ${ann.endY} L ${ann.endX - hl*Math.cos(ang+Math.PI/6)} ${ann.endY - hl*Math.sin(ang+Math.PI/6)}`;
            if (ann.type === 'double_arrow') d += ` M ${ann.startX} ${ann.startY} L ${ann.startX + hl*Math.cos(ang-Math.PI/6)} ${ann.startY + hl*Math.sin(ang-Math.PI/6)} M ${ann.startX} ${ann.startY} L ${ann.startX + hl*Math.cos(ang+Math.PI/6)} ${ann.startY + hl*Math.sin(ang+Math.PI/6)}`;
            svgContent = `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" />`;
         } else if (['curve', 'curve_arrow', 'double_curve_arrow'].includes(ann.type)) {
            let d = `M ${ann.startX} ${ann.startY}`; if(ann.midX !== undefined) d += ` Q ${ann.midX} ${ann.midY} ${ann.endX} ${ann.endY}`; else d += ` L ${ann.endX} ${ann.endY}`;
            const hl = Math.max(15, sw * 3), angE = ann.midX !== undefined ? Math.atan2(ann.endY - ann.midY, ann.endX - ann.midX) : Math.atan2(ann.endY - ann.startY, ann.endX - ann.startX);
            if (['curve_arrow', 'double_curve_arrow'].includes(ann.type)) d += ` M ${ann.endX} ${ann.endY} L ${ann.endX - hl*Math.cos(angE-Math.PI/6)} ${ann.endY - hl*Math.sin(ann.endY - ann.midY)} M ${ann.endX} ${ann.endY} L ${ann.endX - hl*Math.cos(angE+Math.PI/6)} ${ann.endY - hl*Math.sin(angE+Math.PI/6)}`;
            if (ann.type === 'double_curve_arrow') {
              const angS = ann.midX !== undefined ? Math.atan2(ann.startY - ann.midY, ann.startX - ann.midX) : Math.atan2(ann.startY - ann.endY, ann.startX - ann.endX);
              d += ` M ${ann.startX} ${ann.startY} L ${ann.startX - hl*Math.cos(angS-Math.PI/6)} ${ann.startY - hl*Math.sin(angS-Math.PI/6)} M ${ann.startX} ${ann.startY} L ${ann.startX - hl*Math.cos(angS+Math.PI/6)} ${ann.startY - hl*Math.sin(angS+Math.PI/6)}`;
            }
            svgContent = `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" />`;
         }
         if (svgContent) {
           const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${vbW}" height="${vbH}">${svgContent}</svg>`;
           slide.addImage({ data: `data:image/svg+xml;base64,${btoa(Array.from(new TextEncoder().encode(svgStr)).map(b => String.fromCharCode(b)).join(''))}`, x: pptX, y: pptY, w: Math.max(0.1, pptW), h: Math.max(0.1, pptH), rotate: rot });
         }
      }
    }
  });
};

const LayoutRect = ({ rect, onChange, onDragStart, label, bgImg, isMemo, containerRef }) => {
  const handlePointerDown = (e, mode) => {
    e.stopPropagation(); e.preventDefault(); onDragStart();
    const startX = e.clientX, startY = e.clientY, startRect = { ...rect };
    const container = containerRef.current; if (!container) return;
    const cWidth = container.clientWidth, cHeight = container.clientHeight;

    const handlePointerMove = (eMove) => {
      let dx = ((eMove.clientX - startX) / cWidth) * 10, dy = ((eMove.clientY - startY) / cHeight) * 5.625;
      let newRect = { ...startRect };
      if (mode === 'move') { newRect.x += dx; newRect.y += dy; }
      else if (mode === 'resize-br') { newRect.w = Math.max(0.5, startRect.w + dx); newRect.h = Math.max(0.5, startRect.h + dy); }
      else if (mode === 'resize-r') { newRect.w = Math.max(0.5, startRect.w + dx); }
      else if (mode === 'resize-b') { newRect.h = Math.max(0.5, startRect.h + dy); }
      newRect.x = Math.round(newRect.x*100)/100; newRect.y = Math.round(newRect.y*100)/100; newRect.w = Math.round(newRect.w*100)/100; newRect.h = Math.round(newRect.h*100)/100;
      onChange(newRect);
    };
    const handlePointerUp = () => { document.removeEventListener('pointermove', handlePointerMove); document.removeEventListener('pointerup', handlePointerUp); };
    document.addEventListener('pointermove', handlePointerMove); document.addEventListener('pointerup', handlePointerUp);
  };
  if (!rect) return null;
  return (
    <div className={`absolute border-2 ${isMemo ? 'border-gray-500 bg-gray-100/80' : 'border-blue-500 bg-blue-100/80'} flex flex-col items-center justify-center cursor-move select-none shadow-sm group backdrop-blur-sm hover:z-10`}
      style={{ left: `${(rect.x / 10) * 100}%`, top: `${(rect.y / 5.625) * 100}%`, width: `${(rect.w / 10) * 100}%`, height: `${(rect.h / 5.625) * 100}%`, backgroundImage: bgImg ? `url(${bgImg})` : 'none', backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat', backgroundBlendMode: 'overlay' }}
      onPointerDown={(e) => handlePointerDown(e, 'move')}>
      <div className={`px-2 py-0.5 text-[10px] font-bold rounded shadow-sm opacity-90 whitespace-nowrap ${isMemo ? 'bg-gray-800 text-white' : 'bg-blue-600 text-white'}`}>{label}</div>
      <div className="absolute right-[-6px] bottom-[-6px] w-4 h-4 bg-white border-2 border-blue-600 rounded-full cursor-nwse-resize z-10 opacity-0 group-hover:opacity-100 transition-opacity" onPointerDown={(e) => handlePointerDown(e, 'resize-br')} />
      <div className="absolute right-[-6px] top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-blue-600 rounded-full cursor-ew-resize z-10 opacity-0 group-hover:opacity-100 transition-opacity" onPointerDown={(e) => handlePointerDown(e, 'resize-r')} />
      <div className="absolute left-1/2 bottom-[-6px] -translate-x-1/2 w-4 h-4 bg-white border-2 border-blue-600 rounded-full cursor-ns-resize z-10 opacity-0 group-hover:opacity-100 transition-opacity" onPointerDown={(e) => handlePointerDown(e, 'resize-b')} />
    </div>
  );
};


// --- Main App Component ---
export default function App() {
  const [projects, setProjects] = useState([]);
  const [isProjectsLoaded, setIsProjectsLoaded] = useState(false);

  const [currentView, setCurrentView] = useState('home');
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [editingItem, setEditingItem] = useState(null);
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(true);
  
  const [undoHistory, setUndoHistory] = useState([]); // Project Item undo history
  const [isExportSettingsOpen, setIsExportSettingsOpen] = useState(false);
  const [pptxSettings, setPptxSettings] = useState({ showPageNumber: true });
  const [isExportingPPTX, setIsExportingPPTX] = useState(false);
  const [listImageContextMenu, setListImageContextMenu] = useState(null);
  const listLongPressTimerRef = useRef(null);

  // --- Drag & Drop state ---
  const [draggedIndex, setDraggedIndex] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const [dragStartPos, setDragStartPos] = useState(null);
  const [dragCurrentPos, setDragCurrentPos] = useState(null);
  const [dragStartScrollY, setDragStartScrollY] = useState(0);
  const [dragCurrentScrollY, setDragCurrentScrollY] = useState(0);
  const [hasDragMovement, setHasDragMovement] = useState(false);
  const activeDragPointerIdRef = useRef(null);
  const lastDragPointerYRef = useRef(null);

  useEffect(() => {
    const normalizeProjects = (rawProjects) => {
      if (!Array.isArray(rawProjects)) return [];
      return rawProjects.map(p => ({
        ...p,
        items: (p.items || []).map(item => {
          if (item.images) return item;
          return {
            ...item,
            images: item.baseImage
              ? [{ id: 'img_legacy_' + item.id, image: item.image, baseImage: item.baseImage, baseWidth: item.baseWidth, baseHeight: item.baseHeight, annotations: item.annotations || [] }]
              : []
          };
        })
      }));
    };

    const loadProjects = async () => {
      if (typeof window === 'undefined') { setIsProjectsLoaded(true); return; }
      try {
        const savedFromIDB = await idbGet(PROJECTS_KEY);
        if (savedFromIDB) {
          setProjects(normalizeProjects(savedFromIDB));
          setIsProjectsLoaded(true);
          return;
        }

        // LocalStorage からの初回移行
        const legacy = localStorage.getItem(PROJECTS_KEY);
        if (legacy) {
          const parsedLegacy = JSON.parse(legacy);
          const normalizedLegacy = normalizeProjects(parsedLegacy);
          setProjects(normalizedLegacy);
          await idbSet(PROJECTS_KEY, normalizedLegacy);
          localStorage.removeItem(PROJECTS_KEY);
        }
      } catch (e) {
        console.error(e);
        alert('データの読み込みに失敗しました。ブラウザのストレージ設定をご確認ください。');
      } finally {
        setIsProjectsLoaded(true);
      }
    };

    loadProjects();
  }, []);

  useEffect(() => {
    if (!isProjectsLoaded) return;
    const saveProjects = async () => {
      try {
        await idbSet(PROJECTS_KEY, projects);
      } catch (e) {
        console.error(e);
        alert('保存容量の上限に達したか、保存に失敗しました。不要なプロジェクトや画像を削除してください。');
      }
    };
    saveProjects();
  }, [projects, isProjectsLoaded]);

  useEffect(() => { const key = localStorage.getItem('gemini_api_key'); if (key) setApiKeyInput(key); }, []);

  // Clear undo history on project change
  useEffect(() => { setUndoHistory([]); }, [activeProjectId]);

  const saveToUndo = () => {
    const currentProject = projects.find(p => p.id === activeProjectId);
    if (currentProject) setUndoHistory(prev => [...prev, currentProject.items]);
  };

  const handleUndoAction = () => {
    if (undoHistory.length > 0) {
      const prevItems = undoHistory[undoHistory.length - 1];
      setProjects(prev => prev.map(p => p.id === activeProjectId ? { ...p, items: prevItems } : p));
      setUndoHistory(prev => prev.slice(0, -1));
    }
  };

  const handleExportPPTX = async () => {
    const project = projects.find(p => p.id === activeProjectId);
    if (!project) return;
    setIsExportingPPTX(true);
    try {
      const PptxGenJS = await loadPptxGenJS();
      const pptx = new PptxGenJS();
      pptx.layout = 'LAYOUT_16x9';
      pptx.defineSlideMaster({ title: "REPORT_SLIDE", background: { color: "FFFFFF" } });
      project.items.forEach((item, index) => {
        const slide = pptx.addSlide({ masterName: "REPORT_SLIDE" });
        slide.addText(project.title, { x: 0.5, y: 0.2, w: 9.0, h: 0.6, fontSize: 21, fontFace: 'Meiryo', bold: true, color: '000000', valign: 'middle', align: 'left' });
        if (pptxSettings.showPageNumber) { slide.addText(`No. ${index + 1}`, { x: 8.5, y: 0.2, w: 1.0, h: 0.3, fontSize: 12, fontFace: 'Meiryo', bold: true, color: '666666', align: 'right' }); }
        const layout = item.layout || { template: 'default' };
        let memoRect, imageRects;
        if (layout.template === 'custom') { memoRect = layout.memoRect; imageRects = layout.customImageRects || []; } 
        else { const calc = calculateTemplateLayout(layout.template, item.images || []); memoRect = calc.memoRect; imageRects = calc.customImageRects; }
        if (item.memo && memoRect) { slide.addText(item.memo, { x: memoRect.x, y: memoRect.y, w: memoRect.w, h: memoRect.h, fontSize: 16, fontFace: 'Meiryo', color: '333333', align: 'left', valign: 'top' }); }
        const images = item.images || [];
        images.forEach((imgData, i) => {
            const rect = imageRects[i];
            if (!rect || !imgData.baseImage) return;
            const baseW = imgData.baseWidth || 1200;
            slide.addImage({ data: imgData.baseImage, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
            if (imgData.annotations && Array.isArray(imgData.annotations)) { drawAnnotationsOnSlide(slide, pptx, imgData.annotations, rect.x, rect.y, rect.w, baseW); }
        });
      });
      await pptx.writeFile({ fileName: `${project.title}_export.pptx` });
      setIsExportSettingsOpen(false);
    } catch (error) { console.error("PPTX Export Error:", error); alert("PPTXの書き出しに失敗しました。"); } finally { setIsExportingPPTX(false); }
  };

  // --- Sort Functions (Unified for DnD) ---
  const handleDragStart = (idx, e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.currentTarget?.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
    }
    saveToUndo();
    setDraggedIndex(idx);
    setDropIndex(idx);
    setDragStartPos({ x: e.clientX, y: e.clientY });
    setDragCurrentPos({ x: e.clientX, y: e.clientY });
    setDragStartScrollY(window.scrollY);
    setDragCurrentScrollY(window.scrollY);
    setHasDragMovement(false);
    activeDragPointerIdRef.current = e.pointerId;
    lastDragPointerYRef.current = e.clientY;
  };
  const calculateDropIndex = useCallback((clientY) => {
    if (draggedIndex === null) return null;
    const cards = Array.from(document.querySelectorAll('[data-item-index]'))
      .map(el => ({ el, idx: Number(el.getAttribute('data-item-index')) }))
      .filter(entry => !Number.isNaN(entry.idx) && entry.idx !== draggedIndex)
      .sort((a, b) => a.idx - b.idx);
    if (cards.length === 0) return 0;
    let insertion = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].el.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (clientY < mid) {
        insertion = i;
        break;
      }
    }
    return insertion;
  }, [draggedIndex]);

  const reorderAtDrop = useCallback((fromIdx, toIdxWithoutDragged) => {
    setProjects(prev => prev.map(p => {
      if (p.id !== activeProjectId) return p;
      const newItems = [...p.items];
      const [draggedItem] = newItems.splice(fromIdx, 1);
      newItems.splice(toIdxWithoutDragged, 0, draggedItem);
      return { ...p, items: newItems };
    }));
  }, [activeProjectId]);

  const handleDragEnd = useCallback(() => {
    if (draggedIndex !== null && dropIndex !== null && hasDragMovement && draggedIndex !== dropIndex) {
      saveToUndo();
      reorderAtDrop(draggedIndex, dropIndex);
    }
    setDraggedIndex(null);
    setDropIndex(null);
    setDragStartPos(null);
    setDragCurrentPos(null);
    setDragStartScrollY(0);
    setDragCurrentScrollY(0);
    setHasDragMovement(false);
    activeDragPointerIdRef.current = null;
    lastDragPointerYRef.current = null;
  }, [draggedIndex, dropIndex, hasDragMovement, reorderAtDrop, saveToUndo]);

  useEffect(() => {
    if (draggedIndex === null) return;
    document.body.style.userSelect = 'none';
    document.body.style.touchAction = 'none';
    const stopDrag = (e) => {
      if (activeDragPointerIdRef.current !== null && e?.pointerId !== undefined && e.pointerId !== activeDragPointerIdRef.current) return;
      handleDragEnd();
    };
    const trackDrag = (e) => {
      if (activeDragPointerIdRef.current !== null && e.pointerId !== activeDragPointerIdRef.current) return;
      setDragCurrentPos({ x: e.clientX, y: e.clientY });
      setDragCurrentScrollY(window.scrollY);
      lastDragPointerYRef.current = e.clientY;
      if (dragStartPos) {
        const moved = Math.hypot(e.clientX - dragStartPos.x, e.clientY - dragStartPos.y) > 6;
        if (moved && !hasDragMovement) setHasDragMovement(true);
      }
      const nextDropIndex = calculateDropIndex(e.clientY);
      if (nextDropIndex !== null) setDropIndex(nextDropIndex);
    };
    const autoScrollInterval = setInterval(() => {
      if (lastDragPointerYRef.current === null) return;
      const y = lastDragPointerYRef.current;
      const edge = 90;
      const maxSpeed = 9; // px/tick
      let scrollDelta = 0;
      if (y < edge) {
        const ratio = (edge - y) / edge;
        scrollDelta = -Math.max(1, Math.round(maxSpeed * ratio));
      } else if (y > window.innerHeight - edge) {
        const ratio = (y - (window.innerHeight - edge)) / edge;
        scrollDelta = Math.max(1, Math.round(maxSpeed * ratio));
      }
      if (scrollDelta !== 0) {
        window.scrollBy({ top: scrollDelta, behavior: 'auto' });
        setDragCurrentScrollY(window.scrollY);
        const nextDropIndex = calculateDropIndex(y);
        if (nextDropIndex !== null) setDropIndex(nextDropIndex);
      }
    }, 16);
    window.addEventListener('pointermove', trackDrag, { passive: true });
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    return () => {
      clearInterval(autoScrollInterval);
      document.body.style.userSelect = '';
      document.body.style.touchAction = '';
      window.removeEventListener('pointermove', trackDrag);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
    };
  }, [draggedIndex, handleDragEnd, calculateDropIndex, dragStartPos, hasDragMovement]);

  // --- Delete Item Function (Reliable) ---
  const deleteItem = (itemId) => {
    if (confirm('この記録を削除しますか？\n「元に戻す」で復元できます。')) {
      saveToUndo();
      setProjects(prev => prev.map(p => {
        if (p.id !== activeProjectId) return p;
        return { ...p, items: p.items.filter(item => item.id !== itemId) };
      }));
    }
  };

  useEffect(() => {
    const closeListImageMenu = (e) => {
      if (e.target.closest('.list-image-context-menu')) return;
      setListImageContextMenu(null);
    };
    window.addEventListener('pointerdown', closeListImageMenu);
    return () => {
      window.removeEventListener('pointerdown', closeListImageMenu);
      if (listLongPressTimerRef.current) clearTimeout(listLongPressTimerRef.current);
    };
  }, []);

  const copyListImage = async (src) => {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        alert('このブラウザでは画像コピーに対応していません。');
        return;
      }
      const blob = await (await fetch(src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      alert('画像をコピーしました。');
    } catch (e) {
      console.error(e);
      alert('画像コピーに失敗しました。');
    }
  };

  const saveListImage = (src) => {
    const link = document.createElement('a');
    link.href = src;
    link.download = `report-list-image-${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (!isProjectsLoaded) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-500 font-bold">
        データを読み込み中...
      </div>
    );
  }

  if (currentView === 'home') {
    return (
      <div className="min-h-screen bg-gray-50 p-6 md:p-10 font-sans select-none">
        <header className="mb-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div><h1 className="text-3xl font-bold text-gray-900">評価レポート</h1><p className="text-gray-500 mt-1">プロジェクトを選択するか、新しく作成してください</p></div>
          <div className="flex items-center gap-3">
            <button onClick={() => setIsSettingsOpen(prev => !prev)} className="flex items-center gap-2 bg-white text-gray-700 px-4 py-3 rounded-xl hover:bg-gray-100 shadow-sm border border-gray-200 transition">
              <Settings size={20} /> <span className="font-semibold hidden sm:inline">設定</span>
            </button>
            <button onClick={() => { setIsProjectModalOpen(true); setNewProjectTitle(''); }} className="flex items-center gap-2 bg-blue-600 text-white px-5 py-3 rounded-xl hover:bg-blue-700 shadow-md transition">
              <Plus size={24} /> <span className="font-semibold text-lg hidden sm:inline">新規プロジェクト</span>
            </button>
          </div>
        </header>
        {isSettingsOpen && (
          <section className="mb-8 bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
            <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2 mb-2"><Settings size={18} /> Gemini設定</h2>
            <p className="text-sm text-gray-500 mb-4">図形認識・OCR機能では Gemini API を使用します。APIキーを入力して保存してください。</p>
            <div className="flex flex-col md:flex-row gap-3">
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="Gemini APIキー"
                className="flex-1 px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
              <button
                onClick={() => {
                  localStorage.setItem('gemini_api_key', apiKeyInput.trim());
                  alert('Gemini APIキーを保存しました。');
                }}
                className="px-5 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-bold"
              >
                保存
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-3">アプリバージョン: <span className="font-semibold text-gray-700">{APP_VERSION}</span></p>
          </section>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {projects.length === 0 ? (
            <div className="col-span-full flex flex-col items-center justify-center py-20 text-gray-400"><FolderOpen size={64} className="mb-4" /> <p className="text-xl">プロジェクトがありません</p></div>
          ) : (
            projects.map(p => (
              <div key={p.id} className="relative group">
                <div onClick={() => { setActiveProjectId(p.id); setCurrentView('project'); }} className="bg-white p-6 rounded-2xl shadow-sm hover:shadow-md cursor-pointer border border-gray-100 transition active:scale-95">
                  <div className="flex items-center gap-4 mb-4"><div className="bg-blue-100 p-3 rounded-xl text-blue-600"><FolderOpen size={32} /></div><h2 className="text-2xl font-bold text-gray-800 line-clamp-1">{p.title}</h2></div>
                  <div className="text-gray-500 font-medium">記録項目: {p.items.length} 件</div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); if(confirm(`プロジェクト「${p.title}」を削除しますか？`)) setProjects(prev => prev.filter(proj => proj.id !== p.id)); }} className="absolute top-4 right-4 p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition opacity-0 group-hover:opacity-100"><Trash2 size={20} /></button>
              </div>
            ))
          )}
        </div>
        {isProjectModalOpen && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
              <h2 className="text-2xl font-bold mb-4 text-gray-800">新しいプロジェクト</h2>
              <input autoFocus type="text" value={newProjectTitle} onChange={(e) => setNewProjectTitle(e.target.value)} placeholder="プロジェクト名を入力" className="w-full px-4 py-3 border border-gray-300 rounded-xl mb-6 text-lg focus:outline-none focus:ring-2 focus:ring-blue-500 select-text" onKeyDown={(e) => { if (e.key === 'Enter' && newProjectTitle.trim()) { setProjects([...projects, { id: Date.now().toString(), title: newProjectTitle.trim(), items: [], createdAt: new Date() }]); setIsProjectModalOpen(false); } }} />
              <div className="flex justify-end gap-3">
                <button onClick={() => setIsProjectModalOpen(false)} className="px-5 py-2.5 rounded-xl text-gray-600 hover:bg-gray-100 font-medium">キャンセル</button>
                <button onClick={() => { if (newProjectTitle.trim()) { setProjects([...projects, { id: Date.now().toString(), title: newProjectTitle.trim(), items: [], createdAt: new Date() }]); setIsProjectModalOpen(false); } }} disabled={!newProjectTitle.trim()} className="px-5 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 font-medium">作成</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (currentView === 'project') {
    const project = projects.find(p => p.id === activeProjectId);
    if (!project) return null;

    return (
      <div className="min-h-screen bg-gray-50 font-sans print:bg-white select-none">
        <header className="bg-white border-b px-6 py-4 flex items-center justify-between sticky top-0 z-30 print:hidden flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <button onClick={() => setCurrentView('home')} className="p-2 hover:bg-gray-100 rounded-full text-gray-600"><ChevronLeft size={28} /></button>
            <h1 className="text-2xl font-bold text-gray-800 break-all">{project.title}</h1>
            {undoHistory.length > 0 && (
              <button onClick={handleUndoAction} className="flex items-center gap-1.5 ml-4 px-3 py-1.5 bg-amber-50 text-amber-700 rounded-lg font-bold text-sm transition border border-amber-200 shadow-sm hover:bg-amber-100">
                <Undo size={16} /> 元に戻す
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setIsExportSettingsOpen(true)} className="flex items-center gap-2 bg-orange-100 text-orange-700 px-4 py-2 rounded-lg font-bold hover:bg-orange-200">
              <Presentation size={20} /> <span className="hidden sm:inline">PPTX出力</span>
            </button>
            <button onClick={() => window.print()} className="flex items-center gap-2 bg-gray-100 text-gray-700 px-4 py-2 rounded-lg font-medium hover:bg-gray-200">
              <Printer size={20} /> <span className="hidden sm:inline">印刷</span>
            </button>
          </div>
        </header>

        <main className="p-6 md:p-10 max-w-4xl mx-auto">
          <div className="hidden print:block mb-8 border-b-2 border-black pb-4">
            <h1 className="text-4xl font-bold text-black">{project.title}</h1>
            <p className="text-gray-500 mt-2">作成日: {new Date(project.createdAt).toLocaleDateString()}</p>
          </div>

          <div className="relative space-y-4">
            {project.items.map((item, index) => {
              const images = item.images || [];
              const isDragging = draggedIndex === index;
              const dragDx = isDragging && dragStartPos && dragCurrentPos ? dragCurrentPos.x - dragStartPos.x : 0;
              const dragDy = isDragging && dragStartPos && dragCurrentPos ? (dragCurrentPos.y - dragStartPos.y) + (dragCurrentScrollY - dragStartScrollY) : 0;
              return (
                <React.Fragment key={item.id}>
                  {draggedIndex !== null && hasDragMovement && dropIndex === index && !(dropIndex === project.items.length - 1 && index === project.items.length - 1) && (
                    <div className="h-1.5 bg-blue-500/70 rounded-full mx-2 shadow-sm" />
                  )}
                  <div
                    data-item-index={index}
                    onPointerDown={(e) => {
                      if (e.target.closest('.drag-handle')) handleDragStart(index, e);
                    }}
                    className={`bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden print:border-gray-300 print:shadow-none break-inside-avoid relative group ${isDragging ? 'z-50 shadow-2xl ring-2 ring-blue-200 transition-none' : 'z-10 transition-all duration-200 ease-out'}`}
                    style={{
                      transform: isDragging ? `translate(${dragDx}px, ${dragDy}px) scale(1.02)` : 'translate(0, 0) scale(1)',
                      opacity: isDragging ? 0.95 : 1,
                      cursor: isDragging ? 'grabbing' : 'default'
                    }}
                  >
                    <div className="bg-gray-50 px-4 py-2 border-b text-gray-500 font-medium flex justify-between items-center select-none drag-handle cursor-grab active:cursor-grabbing" style={{ touchAction: 'none' }}>
                      <div className="flex items-center gap-3">
                        <GripVertical size={20} className="text-gray-400" />
                        <span className="font-bold text-gray-700">No. {index + 1}</span>
                      </div>
                      <div className="flex items-center gap-2 print:hidden pointer-events-auto">
                        <button 
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); setEditingItem(item); setCurrentView('item-editor'); }} 
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition font-bold text-sm"
                        >
                          <Edit size={16} /> 編集
                        </button>
                        <button 
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()} // ドラッグ開始を阻止
                          onPointerUp={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); deleteItem(item.id); }} 
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition font-bold text-sm"
                        >
                          <Trash2 size={16} /> 削除
                        </button>
                      </div>
                    </div>
                    <div>
                      {images.length > 0 && (
                        <div className={`w-full grid gap-1 bg-gray-100 border-b p-2 ${images.length === 1 ? 'grid-cols-1' : images.length === 2 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'}`}>
                          {images.map(img => (
                            <div
                              key={img.id}
                              className="bg-white flex justify-center items-center p-1 rounded shadow-sm relative"
                              onContextMenu={(e) => {
                                e.preventDefault();
                                const src = img.image || img.baseImage;
                                if (!src) return;
                                setListImageContextMenu({ src, x: e.clientX, y: e.clientY });
                              }}
                              onPointerDown={(e) => {
                                if (e.pointerType !== 'touch') return;
                                if (listLongPressTimerRef.current) clearTimeout(listLongPressTimerRef.current);
                                const src = img.image || img.baseImage;
                                if (!src) return;
                                listLongPressTimerRef.current = setTimeout(() => {
                                  setListImageContextMenu({ src, x: e.clientX, y: e.clientY });
                                }, 550);
                              }}
                              onPointerUp={() => { if (listLongPressTimerRef.current) clearTimeout(listLongPressTimerRef.current); }}
                              onPointerCancel={() => { if (listLongPressTimerRef.current) clearTimeout(listLongPressTimerRef.current); }}
                            >
                              <img src={img.image || img.baseImage} alt="Report Item" className="w-full h-auto max-h-[30vh] object-contain" />
                            </div>
                          ))}
                        </div>
                      )}
                      {item.memo && <div className="p-6 text-gray-800 whitespace-pre-wrap text-base leading-relaxed line-clamp-3">{item.memo}</div>}
                    </div>
                  </div>
                  {draggedIndex !== null && hasDragMovement && index === project.items.length - 1 && dropIndex === project.items.length - 1 && (
                    <div className="h-1.5 bg-blue-500/70 rounded-full mx-2 shadow-sm" />
                  )}
                </React.Fragment>
              );
            })}
            {project.items.length === 0 && (
              <div className="text-center py-20 text-gray-400 print:hidden">
                <FileText size={64} className="mx-auto mb-4 opacity-50" />
                <p className="text-xl">まだ記録がありません。<br/>右下の「＋」ボタンから追加してください。</p>
              </div>
            )}
          </div>
        </main>

        <div className="fixed bottom-8 right-8 z-40 print:hidden">
          <button onClick={() => { setEditingItem(null); setCurrentView('item-editor'); }} className="flex items-center justify-center w-20 h-20 bg-blue-600 text-white rounded-full shadow-xl hover:bg-blue-700 hover:scale-105 transition-transform"><Plus size={40} /></button>
        </div>

        {listImageContextMenu && (
          <div className="fixed z-[90] list-image-context-menu bg-white border border-gray-200 rounded-xl shadow-2xl p-1.5 min-w-[170px]" style={{ left: Math.min(listImageContextMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1024) - 190), top: Math.min(listImageContextMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 768) - 120) }}>
            <button onClick={() => { copyListImage(listImageContextMenu.src); setListImageContextMenu(null); }} className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-100 font-medium text-gray-700">画像をコピー</button>
            <button onClick={() => { saveListImage(listImageContextMenu.src); setListImageContextMenu(null); }} className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-100 font-medium text-gray-700">画像を保存</button>
          </div>
        )}

        {isExportSettingsOpen && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[80] p-4 font-sans">
            <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl">
              <h2 className="text-xl font-bold mb-4 text-gray-800 flex items-center gap-2">
                <Presentation size={24} className="text-orange-600" /> 出力設定
              </h2>
              <div className="space-y-4 mb-6">
                <label className="flex items-center gap-3 cursor-pointer bg-gray-50 p-3 rounded-xl border hover:bg-gray-100 transition">
                  <input type="checkbox" checked={pptxSettings.showPageNumber} onChange={(e) => setPptxSettings({...pptxSettings, showPageNumber: e.target.checked})} className="w-5 h-5 accent-orange-600 cursor-pointer" />
                  <span className="font-bold text-gray-700">スライド右上に「No.」を表示する</span>
                </label>
              </div>
              <div className="flex justify-end gap-3">
                <button onClick={() => setIsExportSettingsOpen(false)} className="px-5 py-2.5 rounded-xl text-gray-600 hover:bg-gray-100 font-medium">キャンセル</button>
                <button onClick={handleExportPPTX} disabled={isExportingPPTX} className="px-5 py-2.5 bg-orange-600 text-white rounded-xl hover:bg-orange-700 font-bold transition flex items-center gap-2">
                  {isExportingPPTX ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />} 出力を開始
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (currentView === 'item-editor') {
    return (
      <ItemEditor 
        key={editingItem ? editingItem.id : 'new'}
        initialItem={editingItem}
        onCancel={() => setCurrentView('project')}
        onSave={(newItem) => { 
          saveToUndo();
          setProjects(prev => prev.map(p => {
            if (p.id !== activeProjectId) return p;
            const existingIdx = p.items.findIndex(i => i.id === newItem.id);
            if (existingIdx >= 0) {
              const newItems = [...p.items]; newItems[existingIdx] = newItem; return { ...p, items: newItems };
            } else {
              return { ...p, items: [...p.items, newItem] };
            }
          })); 
          setCurrentView('project'); 
        }}
      />
    );
  }
  return null;
}

// --- Item Editor Component ---
function ItemEditor({ onCancel, onSave, initialItem }) {
  const resolveStoredImageSrc = useCallback((imgObj) => {
    if (!imgObj) return '';
    if (typeof imgObj.baseImage === 'string' && imgObj.baseImage.trim()) return imgObj.baseImage;
    if (imgObj.baseImage && typeof imgObj.baseImage === 'object' && typeof imgObj.baseImage.src === 'string' && imgObj.baseImage.src.trim()) return imgObj.baseImage.src;
    if (typeof imgObj.image === 'string' && imgObj.image.trim()) return imgObj.image;
    if (imgObj.image && typeof imgObj.image === 'object' && typeof imgObj.image.src === 'string' && imgObj.image.src.trim()) return imgObj.image.src;
    return '';
  }, []);

  const [memo, setMemo] = useState(initialItem ? initialItem.memo : '');
  const [imagesData, setImagesData] = useState([]);
  const [activeImageId, setActiveImageId] = useState(null);
  const [layoutSettings, setLayoutSettings] = useState(initialItem?.layout || { template: 'default', memoRect: { x: 0.5, y: 1.2, w: 3.5, h: 4.0 }, customImageRects: [] });
  const [isLayoutModalOpen, setIsLayoutModalOpen] = useState(false);
  const [isImageSourcePickerOpen, setIsImageSourcePickerOpen] = useState(false);
  const [thumbContextMenu, setThumbContextMenu] = useState(null);
  const [showAdvancedLayout, setShowAdvancedLayout] = useState(false);
  const previewContainerRef = useRef(null);
  const cameraInputRef = useRef(null);
  const albumInputRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const suppressThumbClickRef = useRef(false);
  const [baseImage, setBaseImage] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [history, setHistory] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const canvasRef = useRef(null); const wrapperRef = useRef(null);
  const historySnapshotRef = useRef(null);
  const [clipboard, setClipboard] = useState([]);
  const [transform, _setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const transformRef = useRef({ scale: 1, x: 0, y: 0 });
  const setTransform = useCallback((val) => {
    _setTransform(prev => { const next = typeof val === 'function' ? val(prev) : val; transformRef.current = next; return next; });
  }, []);
  const panStartTransformRef = useRef(null);
  const panStartClientRef = useRef(null);
  const [currentAnnotation, setCurrentAnnotation] = useState(null);
  const [currentTool, setCurrentTool] = useState(ToolType.PEN); const currentToolRef = useRef(currentTool);
  const [lineWidth, setLineWidth] = useState(4); const [fontSize, setFontSize] = useState(48);
  const [strokeColor, setStrokeColor] = useState(COLORS[0]); const [fillColor, setFillColor] = useState(COLORS[1]);
  const [isFillTransparent, setIsFillTransparent] = useState(true); const [textGlow, setTextGlow] = useState(false);
  const toolSettingsRef = useRef({
    [ToolType.PEN]: { lineWidth: 4, strokeColor: COLORS[0], textGlow: false }, [ToolType.HANDWRITING_TEXT]: { lineWidth: 4, fontSize: 48, strokeColor: COLORS[0], textGlow: false },
    [ToolType.TEXT]: { fontSize: 48, strokeColor: COLORS[0], textGlow: false }, [ToolType.LINE]: { lineWidth: 4, strokeColor: COLORS[0], textGlow: false },
    [ToolType.ARROW]: { lineWidth: 4, strokeColor: COLORS[0], textGlow: false }, [ToolType.RECT]: { lineWidth: 4, strokeColor: COLORS[0], fillColor: COLORS[1], isFillTransparent: true, textGlow: false },
    [ToolType.CIRCLE]: { lineWidth: 4, strokeColor: COLORS[0], fillColor: COLORS[1], isFillTransparent: true, textGlow: false }, [ToolType.ERASER_PIXEL]: { lineWidth: 20 },
  });
  const [activePopover, setActivePopover] = useState(null); const [textInput, setTextInput] = useState(null); 
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false); const [fingerDrawMode, setFingerDrawMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]); const [lassoPoints, setLassoPoints] = useState([]); 
  const [isOcrLoading, setIsOcrLoading] = useState(false); const [isCleanUpLoading, setIsCleanUpLoading] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(''); const [errorMessage, setErrorMessage] = useState('');
  const dragModeRef = useRef(null); const isDrawingRef = useRef(false); const dragStartAnnsRef = useRef([]); const dragStartPointerRef = useRef(null);
  const isPotentialTapRef = useRef(false); const dragStartClientPosRef = useRef(null);
  const activePointers = useRef(new Map()); const lastPinch = useRef(null);
  const annotationsRef = useRef(annotations); useEffect(() => { annotationsRef.current = annotations; }, [annotations]);
  const handwritingTimerRef = useRef(null); const handwritingStrokesRef = useRef([]); const [isAutoOcrLoading, setIsAutoOcrLoading] = useState(false);
  const clipboardReadInFlightRef = useRef(false);
  const lastPasteEventAtRef = useRef(0);

  useEffect(() => {
    if (initialItem && initialItem.images) {
      const loadImages = async () => {
        const loadedImages = await Promise.all(initialItem.images.map(async (img) => {
          return new Promise((resolve) => {
            const imageElement = new Image();
            const baseSrc = resolveStoredImageSrc(img);
            if (!baseSrc) {
              resolve(null);
              return;
            }
            imageElement.onload = () => {
              resolve({
                id: img.id,
                baseImage: {
                  src: baseSrc,
                  element: imageElement,
                  width: img.baseWidth || imageElement.naturalWidth,
                  height: img.baseHeight || imageElement.naturalHeight
                },
                annotations: img.annotations || [],
                history: [],
                redoHistory: []
              });
            };
            imageElement.src = baseSrc;
          });
        }));
        const validImages = loadedImages.filter(Boolean);
        setImagesData(validImages);
        if (validImages.length > 0) { setBaseImage(validImages[0].baseImage); setAnnotations(validImages[0].annotations); setActiveImageId(validImages[0].id); setRedoStack([]); }
      };
      loadImages();
    }
  }, [initialItem, resolveStoredImageSrc]);

  useEffect(() => { if (layoutSettings.template !== 'custom') { const newLayout = calculateTemplateLayout(layoutSettings.template, imagesData); setLayoutSettings(prev => ({ ...prev, memoRect: newLayout.memoRect, customImageRects: newLayout.customImageRects })); } }, [layoutSettings.template, imagesData.length]);

  const captureCurrentCanvas = () => {
    if (!canvasRef.current || !baseImage) return null;
    const fCanvas = document.createElement('canvas'); fCanvas.width = canvasRef.current.width; fCanvas.height = canvasRef.current.height;
    const fCtx = fCanvas.getContext('2d'); fCtx.fillStyle = '#ffffff'; fCtx.fillRect(0, 0, fCanvas.width, fCanvas.height);
    fCtx.drawImage(baseImage.element, 0, 0, fCanvas.width, fCanvas.height); fCtx.drawImage(canvasRef.current, 0, 0);
    return fCanvas.toDataURL('image/jpeg', 0.8);
  };

  const switchImage = (newId, isInitial = false) => {
    if (activeImageId === newId) return;
    const currentFinal = activeImageId && canvasRef.current ? captureCurrentCanvas() : null;
    setImagesData(prev => {
      let nextData = prev;
      if (!isInitial && activeImageId) nextData = nextData.map(img => img.id === activeImageId ? { ...img, annotations: annotationsRef.current, history: history, redoHistory: redoStack, finalImage: currentFinal } : img );
      const nextImg = nextData.find(img => img.id === newId);
      if (nextImg) { setTimeout(() => { setBaseImage(nextImg.baseImage); setAnnotations(nextImg.annotations || []); setHistory(nextImg.history || []); setRedoStack(nextImg.redoHistory || []); setActiveImageId(newId); setSelectedIds([]); setTransform({ scale: 1, x: 0, y: 0 }); }, 0); }
      return nextData;
    });
  };

  const handleDeleteImage = (imgId) => { if (confirm('この画像を削除しますか？')) { setImagesData(prev => { const next = prev.filter(img => img.id !== imgId); if (activeImageId === imgId) { if (next.length > 0) setTimeout(() => switchImage(next[0].id, true), 0); else { setActiveImageId(null); setBaseImage(null); setAnnotations([]); setHistory([]); setRedoStack([]); } } return next; }); } };
  const addImagesFromFiles = useCallback((files) => {
    let validFiles = files.filter(file => file.type.startsWith('image/')); if (validFiles.length === 0) return;
    validFiles.forEach(file => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img; const MAX_SIZE = 1600;
          if (width > MAX_SIZE || height > MAX_SIZE) { if (width > height) { height = Math.round((height * MAX_SIZE) / width); width = MAX_SIZE; } else { width = Math.round((width * MAX_SIZE) / height); height = MAX_SIZE; } }
          const newImgData = { id: 'img_' + Date.now() + Math.random(), baseImage: { src: event.target.result, element: img, width, height }, annotations: [], history: [], redoHistory: [] };
          setImagesData(prev => { const next = [...prev, newImgData]; if (next.length === 1 && !activeImageId) { setTimeout(() => { setBaseImage(newImgData.baseImage); setAnnotations([]); setHistory([]); setRedoStack([]); setActiveImageId(newImgData.id); setSelectedIds([]); setTransform({ scale: 1, x: 0, y: 0 }); }, 0); } return next; });
        }; img.src = event.target.result;
      }; reader.readAsDataURL(file);
    });
  }, [activeImageId]);
  const handleImageUpload = (e) => { const files = Array.from(e.target.files); addImagesFromFiles(files); e.target.value = ''; };
  const readImagesFromClipboardAPI = useCallback(async ({ waitForPermission = false } = {}) => {
    if (clipboardReadInFlightRef.current) return false;
    if (!navigator.clipboard?.read) return false;
    clipboardReadInFlightRef.current = true;
    try {
      const maxAttempts = waitForPermission ? 8 : 2;
      const waitMs = waitForPermission ? 350 : 120;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const clipboardItems = await navigator.clipboard.read();
        const files = [];
        for (const item of clipboardItems) {
          const imageType = item.types.find(t => t.startsWith('image/'));
          if (!imageType) continue;
          const blob = await item.getType(imageType);
          files.push(new File([blob], `clipboard-${Date.now()}.png`, { type: imageType }));
        }
        if (files.length > 0) {
          addImagesFromFiles(files);
          return true;
        }
        if (attempt < maxAttempts - 1) await new Promise(r => setTimeout(r, waitMs));
      }
    } catch (err) {
      // iPad Safari では権限/仕様で失敗しうるため黙って通常フローへフォールバック
    } finally {
      clipboardReadInFlightRef.current = false;
    }
    return false;
  }, [addImagesFromFiles]);

  useEffect(() => {
    const handleGlobalPaste = async (e) => {
      lastPasteEventAtRef.current = Date.now();
      if (isLayoutModalOpen || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT') return;
      const items = e.clipboardData?.items;
      const imageFiles = [];
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.indexOf('image') !== -1) imageFiles.push(items[i].getAsFile());
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addImagesFromFiles(imageFiles);
        return;
      }
      const readViaAPI = await readImagesFromClipboardAPI();
      if (readViaAPI) e.preventDefault();
    };
    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, [addImagesFromFiles, isLayoutModalOpen, readImagesFromClipboardAPI]);

  useEffect(() => {
    const handlePasteShortcut = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'v') return;
      if (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT') return;
      // iPadでpasteイベントが来ないケースのみフォールバック読み取り
      setTimeout(() => {
        if (Date.now() - lastPasteEventAtRef.current > 160) readImagesFromClipboardAPI({ waitForPermission: true });
      }, 180);
    };
    window.addEventListener('keydown', handlePasteShortcut);
    return () => window.removeEventListener('keydown', handlePasteShortcut);
  }, [readImagesFromClipboardAPI]);

  useEffect(() => {
    const closeMenu = (e) => {
      if (e.target.closest('.thumb-context-menu')) return;
      setThumbContextMenu(null);
    };
    window.addEventListener('pointerdown', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', closeMenu);
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };
  }, []);

  const copyThumbnailImage = async (img) => {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        alert('このブラウザでは画像コピーに対応していません。');
        return;
      }
      const src = img?.baseImage?.src;
      if (!src) return;
      const blob = await (await fetch(src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      alert('画像をコピーしました。');
    } catch (e) {
      console.error(e);
      alert('画像コピーに失敗しました。');
    }
  };

  const saveThumbnailImage = (img) => {
    const src = img?.baseImage?.src;
    if (!src) return;
    const link = document.createElement('a');
    link.href = src;
    link.download = `report-image-${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const pushHistory = useCallback((prevState) => {
    setHistory(prev => {
      const newHistory = [...prev, prevState];
      if (newHistory.length > 50) newHistory.shift();
      return newHistory;
    });
    setRedoStack([]);
  }, []);
  const handleUndo = useCallback(() => {
    if (history.length > 0) {
      const previous = history[history.length - 1];
      setRedoStack(prev => [...prev, annotationsRef.current]);
      setAnnotations(previous);
      setHistory(prev => prev.slice(0, -1));
      setSelectedIds([]);
    }
  }, [history]);
  const handleRedo = useCallback(() => {
    if (redoStack.length > 0) {
      const next = redoStack[redoStack.length - 1];
      setHistory(prev => {
        const newHistory = [...prev, annotationsRef.current];
        if (newHistory.length > 50) newHistory.shift();
        return newHistory;
      });
      setRedoStack(prev => prev.slice(0, -1));
      setAnnotations(next);
      setSelectedIds([]);
    }
  }, [redoStack]);
  const updateSelectedObj = useCallback((updates) => { setAnnotations(prev => prev.map(a => selectedIds.includes(a.id) ? { ...a, ...updates } : a)); }, [selectedIds]);
  const handleToolChange = useCallback((newTool, keepSelection = false) => { setCurrentTool(newTool); currentToolRef.current = newTool; if (!keepSelection) setSelectedIds([]); setActivePopover(null); const settings = toolSettingsRef.current[newTool]; if (settings) { if (settings.lineWidth !== undefined) setLineWidth(settings.lineWidth); if (settings.fontSize !== undefined) setFontSize(settings.fontSize); if (settings.strokeColor !== undefined) setStrokeColor(settings.strokeColor); if (settings.fillColor !== undefined) setFillColor(settings.fillColor); if (settings.isFillTransparent !== undefined) setIsFillTransparent(settings.isFillTransparent); if (settings.textGlow !== undefined) setTextGlow(settings.textGlow); } }, []);
  const updateSettings = useCallback((updatesObj) => {
    if (updatesObj.lineWidth !== undefined) setLineWidth(updatesObj.lineWidth); if (updatesObj.fontSize !== undefined) setFontSize(updatesObj.fontSize); if (updatesObj.strokeColor !== undefined) setStrokeColor(updatesObj.strokeColor); if (updatesObj.fillColor !== undefined) setFillColor(updatesObj.fillColor); if (updatesObj.isFillTransparent !== undefined) setIsFillTransparent(updatesObj.isFillTransparent); if (updatesObj.textGlow !== undefined) setTextGlow(updatesObj.textGlow); if (currentTool !== ToolType.SELECT && currentTool !== ToolType.LASSO && toolSettingsRef.current[currentTool]) Object.assign(toolSettingsRef.current[currentTool], updatesObj);
    if (selectedIds.length > 0) { pushHistory(annotationsRef.current); const annUpdates = {}; if (updatesObj.lineWidth !== undefined) annUpdates.width = updatesObj.lineWidth; if (updatesObj.fontSize !== undefined) annUpdates.fontSize = updatesObj.fontSize; if (updatesObj.strokeColor !== undefined) annUpdates.color = updatesObj.strokeColor; const newIsTransp = updatesObj.isFillTransparent !== undefined ? updatesObj.isFillTransparent : isFillTransparent; const newFColor = updatesObj.fillColor !== undefined ? updatesObj.fillColor : fillColor; if (updatesObj.fillColor !== undefined || updatesObj.isFillTransparent !== undefined) annUpdates.fillColor = newIsTransp ? 'transparent' : newFColor; if (updatesObj.textGlow !== undefined) annUpdates.hasGlow = updatesObj.textGlow; updateSelectedObj(annUpdates); }
  }, [currentTool, selectedIds, isFillTransparent, fillColor, updateSelectedObj, pushHistory]);

  const handleDeleteSelected = useCallback(() => { if (selectedIds.length === 0) return; pushHistory(annotationsRef.current); setAnnotations(prev => prev.filter(a => !selectedIds.includes(a.id))); setSelectedIds([]); }, [selectedIds, pushHistory]);
  const handleCopySelected = useCallback(() => { if (selectedIds.length === 0) return; const copied = annotationsRef.current.filter(a => selectedIds.includes(a.id)).map(a => JSON.parse(JSON.stringify(a))); setClipboard(copied); }, [selectedIds]);
  const handlePaste = useCallback(() => {
    if (clipboard.length === 0) return; pushHistory(annotationsRef.current); const newIds = []; const newGroupIdMapping = {}; 
    const pasted = clipboard.map(ann => { const newId = Date.now().toString() + Math.random().toString(36).substring(2, 9); newIds.push(newId); const offset = 30; const newAnn = JSON.parse(JSON.stringify(ann)); newAnn.id = newId; if (newAnn.groupId) { if (!newGroupIdMapping[newAnn.groupId]) newGroupIdMapping[newAnn.groupId] = 'grp_' + Date.now() + Math.random().toString(36).substring(2, 9); newAnn.groupId = newGroupIdMapping[newAnn.groupId]; } if (['pen', 'handwriting_text', 'eraser_pixel', 'polyline', 'polygon'].includes(newAnn.type)) { if (newAnn.points) newAnn.points = newAnn.points.map(p => ({ x: p.x + offset, y: p.y + offset })); } else if (newAnn.type === 'text') { newAnn.x += offset; newAnn.y += offset; } else { if (newAnn.startX !== undefined) newAnn.startX += offset; if (newAnn.startY !== undefined) newAnn.startY += offset; if (newAnn.endX !== undefined) newAnn.endX += offset; if (newAnn.endY !== undefined) newAnn.endY += offset; if (newAnn.midX !== undefined) newAnn.midX += offset; if (newAnn.midY !== undefined) newAnn.midY += offset; } if(newAnn.tx !== undefined) newAnn.tx += offset; if(newAnn.ty !== undefined) newAnn.ty += offset; return newAnn; });
    setAnnotations(prev => [...prev, ...pasted]); setSelectedIds(newIds); setClipboard(pasted); if (currentToolRef.current !== ToolType.SELECT) handleToolChange(ToolType.SELECT, true);
  }, [clipboard, pushHistory, handleToolChange]);

  const handleGroup = () => { const newGroupId = 'grp_' + Date.now() + Math.random().toString(36).substring(2, 9); pushHistory(annotationsRef.current); setAnnotations(prev => prev.map(a => selectedIds.includes(a.id) ? { ...a, groupId: newGroupId } : a)); };
  const handleUngroup = () => { pushHistory(annotationsRef.current); setAnnotations(prev => prev.map(a => selectedIds.includes(a.id) ? { ...a, groupId: undefined } : a)); };
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const key = e.key.toLowerCase();
      const hasMeta = e.ctrlKey || e.metaKey;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        e.preventDefault();
        handleDeleteSelected();
      } else if (hasMeta && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if (hasMeta && key === 'y') {
        e.preventDefault();
        handleRedo();
      } else if (hasMeta && key === 'c' && selectedIds.length > 0) {
        e.preventDefault();
        handleCopySelected();
      } else if (hasMeta && key === 'v' && clipboard.length > 0) {
        e.preventDefault();
        handlePaste();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, handleDeleteSelected, handleCopySelected, handlePaste, clipboard, handleUndo, handleRedo]);

  const triggerAutoOCR = async (strokeIds) => {
    if (!strokeIds || strokeIds.length === 0) return; setIsAutoOcrLoading(true);
    try {
      const currentAnns = annotationsRef.current; const targetAnns = currentAnns.filter(a => strokeIds.includes(a.id)); if (targetAnns.length === 0) { setIsAutoOcrLoading(false); return; }
      const bbox = getMultiBBox(currentAnns, strokeIds); if (!bbox || bbox.w === 0 || bbox.h === 0) { setIsAutoOcrLoading(false); return; }
      const margin = 20; const rawW = bbox.w + margin * 2; const rawH = bbox.h + margin * 2; const MAX_DIM = 1024; let scale = 1; if (rawW > MAX_DIM || rawH > MAX_DIM) scale = Math.min(MAX_DIM / rawW, MAX_DIM / rawH);
      const tmpCanvas = document.createElement('canvas'); tmpCanvas.width = rawW * scale; tmpCanvas.height = rawH * scale; const tmpCtx = tmpCanvas.getContext('2d'); tmpCtx.scale(scale, scale); tmpCtx.fillStyle = '#ffffff'; tmpCtx.fillRect(0, 0, rawW, rawH); tmpCtx.translate(-bbox.x + margin, -bbox.y + margin);
      targetAnns.forEach(ann => { tmpCtx.save(); const abox = getBBox(ann); if (abox) { tmpCtx.translate(abox.x + abox.w/2 + (ann.tx || 0), abox.y + abox.h/2 + (ann.ty || 0)); tmpCtx.rotate(ann.rotation || 0); tmpCtx.scale(ann.scaleX || ann.scale || 1, ann.scaleY || ann.scale || 1); tmpCtx.translate(-(abox.x + abox.w/2), -(abox.y + abox.h/2)); } tmpCtx.strokeStyle = '#000000'; tmpCtx.lineWidth = Math.max(2, ann.width || 4); tmpCtx.lineCap = 'round'; tmpCtx.lineJoin = 'round'; tmpCtx.beginPath(); tmpCtx.moveTo(ann.points[0].x, ann.points[0].y); for (let i = 1; i < ann.points.length; i++) tmpCtx.lineTo(ann.points[i].x, ann.points[i].y); tmpCtx.stroke(); tmpCtx.restore(); });
      const base64Data = tmpCanvas.toDataURL('image/jpeg', 0.8); const payload = { contents: [{ role: "user", parts: [ { text: "Extract the handwritten text from the image. Keep explicit line breaks, otherwise output as a single line. Output ONLY the raw text without markdown." }, { inlineData: { mimeType: "image/jpeg", data: base64Data.split(',')[1] } } ] }] }; const data = await callGeminiAPI(payload, localStorage.getItem('gemini_api_key')); const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) { const lines = text.split('\n'); const lineCount = lines.length || 1; let maxCharCount = 1; lines.forEach(l => { if (l.length > maxCharCount) maxCharCount = l.length; }); let calcFontSize = Math.min(bbox.h / lineCount / 1.2, (bbox.w / maxCharCount) * 1.2); calcFontSize = Math.max(12, Math.min(300, calcFontSize)); pushHistory(annotationsRef.current); setAnnotations(prev => { const filteredAnns = prev.filter(a => !strokeIds.includes(a.id)); return [...filteredAnns, { id: Date.now().toString(), type: 'text', x: bbox.x + bbox.w/2, y: bbox.y + bbox.h/2, text: text, color: targetAnns[0].color || '#000000', fontSize: calcFontSize, scaleX: 1, scaleY: 1, rotation: 0, tx: 0, ty: 0, hasGlow: targetAnns[0].hasGlow !== undefined ? targetAnns[0].hasGlow : true }]; }); }
    } catch (e) { console.error("Auto OCR Error:", e); setErrorMessage(`自動文字認識に失敗しました: ${e.message || '通信エラー'}`); } finally { setIsAutoOcrLoading(false); }
  };

  const runOCR = async () => {
    setIsOcrLoading(true); setErrorMessage(''); setOcrProgress('AIで文字を解析中...');
    try {
      const bbox = getMultiBBox(annotations, selectedIds); if (!bbox) return;
      const margin = 20; const rawW = bbox.w + margin * 2; const rawH = bbox.h + margin * 2; const MAX_DIM = 1024; let scale = 1; if (rawW > MAX_DIM || rawH > MAX_DIM) scale = Math.min(MAX_DIM / rawW, MAX_DIM / rawH);
      const tmpCanvas = document.createElement('canvas'); tmpCanvas.width = rawW * scale; tmpCanvas.height = rawH * scale; const tmpCtx = tmpCanvas.getContext('2d'); tmpCtx.scale(scale, scale); tmpCtx.fillStyle = '#ffffff'; tmpCtx.fillRect(0, 0, rawW, rawH); tmpCtx.translate(-bbox.x + margin, -bbox.y + margin);
      selectedIds.forEach(id => { const ann = annotations.find(a => a.id === id); if (!ann || !['pen', 'handwriting_text'].includes(ann.type)) return; tmpCtx.save(); const abox = getBBox(ann); if (abox) { tmpCtx.translate(abox.x + abox.w/2 + (ann.tx || 0), abox.y + abox.h/2 + (ann.ty || 0)); tmpCtx.rotate(ann.rotation || 0); tmpCtx.scale(ann.scaleX || ann.scale || 1, ann.scaleY || ann.scale || 1); tmpCtx.translate(-(abox.x + abox.w/2), -(abox.y + abox.h/2)); } tmpCtx.strokeStyle = '#000000'; tmpCtx.lineWidth = Math.max(2, ann.width || 4); tmpCtx.lineCap = 'round'; tmpCtx.lineJoin = 'round'; tmpCtx.beginPath(); tmpCtx.moveTo(ann.points[0].x, ann.points[0].y); for (let i = 1; i < ann.points.length; i++) tmpCtx.lineTo(ann.points[i].x, ann.points[i].y); tmpCtx.stroke(); tmpCtx.restore(); });
      const base64Data = tmpCanvas.toDataURL('image/jpeg', 0.8); const payload = { contents: [{ role: "user", parts: [ { text: "Extract the handwritten text from the image. Keep explicit line breaks, otherwise output as a single line. Output ONLY the raw text without markdown." }, { inlineData: { mimeType: "image/jpeg", data: base64Data.split(',')[1] } } ] }] }; const data = await callGeminiAPI(payload, localStorage.getItem('gemini_api_key')); const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) { const lines = text.split('\n'); const lineCount = lines.length || 1; let maxCharCount = 1; lines.forEach(l => { if (l.length > maxCharCount) maxCharCount = l.length; }); let calcFontSize = Math.min(bbox.h / lineCount / 1.2, (bbox.w / maxCharCount) * 1.2); calcFontSize = Math.max(12, Math.min(300, calcFontSize)); pushHistory(annotationsRef.current); setAnnotations(prev => { const idsToRemove = selectedIds.filter(id => { const ann = prev.find(a => a.id === id); return ann && ['pen', 'handwriting_text'].includes(ann.type); }); const filteredAnns = prev.filter(a => !idsToRemove.includes(a.id)); return [...filteredAnns, { id: Date.now().toString(), type: 'text', x: bbox.x + bbox.w/2, y: bbox.y + bbox.h/2, text: text, color: strokeColor, fontSize: calcFontSize, scaleX: 1, scaleY: 1, rotation: 0, tx: 0, ty: 0, hasGlow: textGlow }]; }); } else setErrorMessage('文字が検出されませんでした。');
    } catch (e) { console.error(e); setErrorMessage("OCR読み取りに失敗しました。インターネット接続を確認してください。"); } finally { setIsOcrLoading(false); setOcrProgress(''); setSelectedIds([]); }
  };

  const handleAutoCleanUp = async () => {
    let targetPenAnns = annotations.filter(a => ['pen', 'handwriting_text'].includes(a.type)); if (selectedIds.length > 0) targetPenAnns = targetPenAnns.filter(a => selectedIds.includes(a.id)); if (targetPenAnns.length === 0) { setErrorMessage('整頓する手書きの線がありません。（一部だけ整頓したい場合は、選択してから実行してください）'); return; }
    setIsCleanUpLoading(true); setOcrProgress('AIで図形を分析・整形中...'); setErrorMessage(''); const targetIds = targetPenAnns.map(a => a.id); setSelectedIds([]);
    try {
      const bbox = getMultiBBox(annotations, targetIds); if (!bbox || bbox.w === 0 || bbox.h === 0) { setErrorMessage("線の範囲が小さすぎるか、無効です。"); setIsCleanUpLoading(false); return; }
      const margin = 60; const rawW = bbox.w + margin * 2; const rawH = bbox.h + margin * 2; const MAX_DIM = 1024; let scale = 1; if (rawW > MAX_DIM || rawH > MAX_DIM) scale = Math.min(MAX_DIM / rawW, MAX_DIM / rawH);
      const tmpCanvas = document.createElement('canvas'); tmpCanvas.width = rawW * scale; tmpCanvas.height = rawH * scale; const tmpCtx = tmpCanvas.getContext('2d'); tmpCtx.scale(scale, scale); tmpCtx.fillStyle = '#ffffff'; tmpCtx.fillRect(0, 0, rawW, rawH); tmpCtx.translate(-bbox.x + margin, -bbox.y + margin); const annMap = {};
      targetPenAnns.forEach((ann, index) => { const numId = index + 1; annMap[numId] = ann; tmpCtx.save(); const abox = getBBox(ann); if (abox) { tmpCtx.translate(abox.x + abox.w/2 + (ann.tx || 0), abox.y + abox.h/2 + (ann.ty || 0)); tmpCtx.rotate(ann.rotation || 0); tmpCtx.scale(ann.scaleX || ann.scale || 1, ann.scaleY || ann.scale || 1); tmpCtx.translate(-(abox.x + abox.w/2), -(abox.y + abox.h/2)); } tmpCtx.strokeStyle = '#000000'; tmpCtx.lineWidth = Math.max(2, ann.width || 4); tmpCtx.lineCap = 'round'; tmpCtx.lineJoin = 'round'; tmpCtx.beginPath(); tmpCtx.moveTo(ann.points[0].x, ann.points[0].y); for (let i = 1; i < ann.points.length; i++) tmpCtx.lineTo(ann.points[i].x, ann.points[i].y); tmpCtx.stroke(); tmpCtx.restore(); if (abox) { tmpCtx.save(); const textPos = transformPoint(abox.x, abox.y, ann); tmpCtx.fillStyle = '#ef4444'; tmpCtx.font = 'bold 32px sans-serif'; tmpCtx.textAlign = 'left'; tmpCtx.textBaseline = 'bottom'; const txt = `[${numId}]`; const textW = tmpCtx.measureText(txt).width; tmpCtx.fillStyle = 'rgba(255,255,255,0.9)'; tmpCtx.fillRect(textPos.x - 4, textPos.y - 34, textW + 8, 36); tmpCtx.fillStyle = '#ef4444'; tmpCtx.fillText(txt, textPos.x, textPos.y - 2); tmpCtx.restore(); } });
      const base64Data = tmpCanvas.toDataURL('image/jpeg', 0.8).split(',')[1];
      const payload = { contents: [{ role: "user", parts: [ { text: "Analyze handwritten elements marked with red numbers like [1], [2]. Identify their shape type from: 'text', 'rect', 'circle', 'triangle', 'star', 'arrow', 'double_arrow', 'line', 'curve', 'curve_arrow', 'double_curve_arrow', 'polyline', 'polygon'. If multiple numbers form one shape (e.g. arrow head and line), group their ids in 'ids' array. Group all text strokes into a single 'text' object. Return a JSON array." }, { inlineData: { mimeType: "image/jpeg", data: base64Data } } ] }], generationConfig: { responseMimeType: "application/json", responseSchema: { type: "ARRAY", items: { type: "OBJECT", properties: { ids: { type: "ARRAY", items: { type: "INTEGER" } }, type: { type: "STRING", enum: ["text", "rect", "circle", "triangle", "star", "arrow", "double_arrow", "line", "curve", "curve_arrow", "double_curve_arrow", "polyline", "polygon"] }, content: { type: "STRING" } }, required: ["ids", "type"] } } } };
      const data = await callGeminiAPI(payload, localStorage.getItem('gemini_api_key'));
      const cleanText = (data.candidates?.[0]?.content?.parts?.[0]?.text || '[]').replace(/```json/g, '').replace(/```/g, '').trim(); const parsedElements = JSON.parse(cleanText);
      const newAnns = parsedElements.map(el => {
        const originalAnns = (el.ids || []).map(id => annMap[id]).filter(Boolean); if (originalAnns.length === 0) return null; const strokes = originalAnns.map(ann => ann.points.map(p => transformPoint(p.x, p.y, ann))); const actualPts = strokes.flat(); if (actualPts.length < 2) return null; let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; actualPts.forEach(p => { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }); let startX, startY, endX, endY; if (['arrow', 'double_arrow', 'line'].includes(el.type)) { if (strokes.length > 1) { let longestStroke = strokes[0]; let maxDist = 0; strokes.forEach(stroke => { const d = dist2(stroke[0], stroke[stroke.length - 1]); if (d > maxDist) { maxDist = d; longestStroke = stroke; } }); let p1 = longestStroke[0]; let p2 = longestStroke[longestStroke.length - 1]; if (el.type === 'arrow') { const otherPts = strokes.filter(s => s !== longestStroke).flat(); let cx = 0, cy = 0; otherPts.forEach(p => { cx += p.x; cy += p.y; }); if (otherPts.length > 0) { cx /= otherPts.length; cy /= otherPts.length; if (dist2(p1, {x: cx, y: cy}) < dist2(p2, {x: cx, y: cy})) { endX = p1.x; endY = p1.y; startX = p2.x; startY = p2.y; } else { endX = p2.x; endY = p2.y; startX = p1.x; startY = p1.y; } } else { startX = p1.x; startY = p1.y; endX = p2.x; endY = p2.y; } } else { startX = p1.x; startY = p1.y; endX = p2.x; endY = p2.y; } } else { const pts = strokes[0]; const simplified = simplifyLine(pts, 15); if (simplified.length > 2 && (el.type === 'arrow' || el.type === 'double_arrow')) { let maxSegLen = 0; let maxSegIdx = 0; for (let i = 0; i < simplified.length - 1; i++) { const d = dist2(simplified[i], simplified[i+1]); if (d > maxSegLen) { maxSegLen = d; maxSegIdx = i; } } const pA = simplified[maxSegIdx]; const pB = simplified[maxSegIdx + 1]; if (el.type === 'arrow') { const otherPts = simplified.filter((p, i) => i !== maxSegIdx && i !== maxSegIdx + 1); let cx = 0, cy = 0; otherPts.forEach(p => { cx += p.x; cy += p.y; }); if (otherPts.length > 0) { cx /= otherPts.length; cy /= otherPts.length; if (dist2(pA, {x: cx, y: cy}) < dist2(pB, {x: cx, y: cy})) { endX = pA.x; endY = pA.y; startX = pB.x; startY = pB.y; } else { endX = pB.x; endY = pB.y; startX = pA.x; startY = pA.y; } } else { startX = pts[0].x; startY = pts[0].y; endX = pts[pts.length - 1].x; endY = pts[pts.length - 1].y; } } else { startX = pA.x; startY = pA.y; endX = pB.x; endY = pB.y; } } else { startX = pts[0].x; startY = pts[0].y; endX = pts[pts.length - 1].x; endY = pts[pts.length - 1].y; } } } else { startX = minX; startY = minY; endX = maxX; endY = maxY; } let midPt = actualPts[Math.floor(actualPts.length / 2)]; if (['curve', 'curve_arrow', 'double_curve_arrow'].includes(el.type)) { if (strokes.length > 1) { let longestStroke = strokes[0]; let maxDist = 0; strokes.forEach(stroke => { const d = dist2(stroke[0], stroke[stroke.length - 1]); if (d > maxDist) { maxDist = d; longestStroke = stroke; } }); startX = longestStroke[0].x; startY = longestStroke[0].y; endX = longestStroke[longestStroke.length - 1].x; endY = longestStroke[longestStroke.length - 1].y; midPt = longestStroke[Math.floor(longestStroke.length / 2)]; if (el.type === 'curve_arrow' || el.type === 'double_curve_arrow') { const otherPts = strokes.filter(s => s !== longestStroke).flat(); let cx = 0, cy = 0; otherPts.forEach(p => { cx += p.x; cy += p.y; }); if (otherPts.length > 0) { cx /= otherPts.length; cy /= otherPts.length; if (dist2({x: startX, y: startY}, {x: cx, y: cy}) < dist2({x: endX, y: endY}, {x: cx, y: cy})) { let tmpX = startX, tmpY = startY; startX = endX; startY = endY; endX = tmpX; endY = tmpY; } } } } else { const pts = strokes[0]; startX = pts[0].x; startY = pts[0].y; endX = pts[pts.length - 1].x; endY = pts[pts.length - 1].y; } }
        const baseProps = { id: Date.now().toString() + Math.random().toString(36).substring(2, 9), color: originalAnns[0].color || strokeColor, fillColor: 'transparent', width: originalAnns[0].width || lineWidth, scaleX: 1, scaleY: 1, rotation: 0, tx: 0, ty: 0, hasGlow: originalAnns[0].hasGlow || false }; if (el.type === 'text') { const content = el.content || ''; const lines = content.split('\n'); let maxC = 1; lines.forEach(l => { if (l.length > maxC) maxC = l.length; }); let fs = Math.min((maxY - minY) / lines.length / 1.2, ((maxX - minX) / maxC) * 1.2); fs = Math.max(16, Math.min(150, fs)); return { ...baseProps, type: 'text', x: (minX + maxX)/2, y: (minY + maxY)/2, text: content, fontSize: fs }; } else if (['rect', 'circle', 'triangle', 'star'].includes(el.type)) return { ...baseProps, type: el.type, startX: minX, startY: minY, endX: maxX, endY: maxY }; else if (['line', 'arrow', 'double_arrow'].includes(el.type)) return { ...baseProps, type: el.type, startX, startY, endX, endY }; else if (['curve', 'curve_arrow', 'double_curve_arrow'].includes(el.type)) return { ...baseProps, type: el.type, startX: startX, startY: startY, endX: endX, endY: endY, midX: midPt.x, midY: midPt.y }; else if (['polyline', 'polygon'].includes(el.type)) { const simplifiedPts = simplifyLine(actualPts, 15); if (el.type === 'polygon' && simplifiedPts.length > 2) { simplifiedPts[simplifiedPts.length - 1] = { x: simplifiedPts[0].x, y: simplifiedPts[0].y }; return { ...baseProps, type: 'polygon', points: simplifiedPts }; } else if (simplifiedPts.length > 1) return { ...baseProps, type: 'polyline', points: simplifiedPts }; else return { ...baseProps, type: 'line', startX: minX, startY: minY, endX: maxX, endY: maxY }; } return null;
      }).filter(Boolean);
      const successfullyProcessedIds = parsedElements.flatMap(el => el.ids || []).filter(id => annMap[id]).map(id => annMap[id].id); if (successfullyProcessedIds.length > 0) { pushHistory(annotationsRef.current); setAnnotations(prev => { const others = prev.filter(a => !successfullyProcessedIds.includes(a.id)); return [...others, ...newAnns]; }); } else setErrorMessage("図形を認識できませんでした。");
    } catch (e) { console.error(e); setErrorMessage("AI一括整形に失敗しました。線が複雑すぎるか、通信エラーです。"); } finally { setIsCleanUpLoading(false); setOcrProgress(''); }
  };

  const handleSave = () => {
    let finalImagesData = [...imagesData];
    if (activeImageId && baseImage) { const currentFinal = captureCurrentCanvas(); finalImagesData = finalImagesData.map(img => img.id === activeImageId ? { ...img, annotations: annotationsRef.current, finalImage: currentFinal } : img ); }
    onSave({
      id: initialItem ? initialItem.id : Date.now().toString(),
      images: finalImagesData.map(img => {
        const safeBaseSrc = typeof img.baseImage?.src === 'string' ? img.baseImage.src : resolveStoredImageSrc(img);
        const safeFinalSrc = typeof img.finalImage === 'string' && img.finalImage ? img.finalImage : safeBaseSrc;
        return ({
        id: img.id,
        image: safeFinalSrc,
        baseImage: safeBaseSrc,
        baseWidth: img.baseImage?.width || 1200,
        baseHeight: img.baseImage?.height || 800,
        annotations: img.annotations
      });
      }),
      memo,
      layout: layoutSettings
    });
  };

  useEffect(() => {
    if (!activeImageId || !canvasRef.current || !offCanvas) return;
    const canvas = canvasRef.current; const ctx = canvas.getContext('2d'); const w = baseImage ? baseImage.width : 1200; const h = baseImage ? baseImage.height : 800; if (canvas.width !== w) { canvas.width = w; canvas.height = h; } if (offCanvas.width !== w) { offCanvas.width = w; offCanvas.height = h; } ctx.clearRect(0, 0, canvas.width, canvas.height);
    const drawAnn = (ann) => {
      if (textInput && ann.id === textInput.id) return; const hasErasers = ann.erasers && ann.erasers.length > 0; const tCtx = hasErasers ? offCtx : ctx; if (hasErasers) tCtx.clearRect(0, 0, w, h); tCtx.save();
      const drawShape = (isGlow) => {
        tCtx.save(); tCtx.beginPath();
        if (ann.type === 'text') { const bbox = getBBox(ann); if (bbox) { const cx = bbox.x + bbox.w/2; const cy = bbox.y + bbox.h/2; tCtx.translate(cx + (ann.tx || 0), cy + (ann.ty || 0)); tCtx.rotate(ann.rotation || 0); tCtx.scale(ann.scaleX || ann.scale || 1, ann.scaleY || ann.scale || 1); tCtx.translate(-cx, -cy); } tCtx.font = `bold ${ann.fontSize || 48}px sans-serif`; tCtx.textBaseline = 'middle'; tCtx.textAlign = 'center'; const lines = (ann.text || '').split('\n'); const lineHeight = (ann.fontSize || 48) * 1.2; let maxWidth = 0; lines.forEach(line => { const lw = tCtx.measureText(line).width; if (lw > maxWidth) maxWidth = lw; }); ann._w = maxWidth; ann._h = lines.length * lineHeight; const startY = ann.y - ((lines.length - 1) * lineHeight) / 2; lines.forEach((line, index) => { const ly = startY + index * lineHeight; if (isGlow) { tCtx.miterLimit = 2; tCtx.lineWidth = (ann.fontSize || 48) / 4; tCtx.strokeStyle = '#ffffff'; tCtx.strokeText(line, ann.x, ly); } else { tCtx.fillStyle = ann.color; tCtx.fillText(line, ann.x, ly); } }); tCtx.restore(); return; }
        if (isGlow) { tCtx.lineWidth = (ann.width || 4) + 8; tCtx.strokeStyle = '#ffffff'; tCtx.lineCap = 'round'; tCtx.lineJoin = 'round'; } else { if (ann.type === 'eraser_pixel') { tCtx.globalCompositeOperation = 'destination-out'; tCtx.strokeStyle = 'rgba(0,0,0,1)'; } else { tCtx.globalCompositeOperation = 'source-over'; tCtx.strokeStyle = ann.color; } tCtx.fillStyle = ann.fillColor || 'transparent'; tCtx.lineWidth = ann.width || 4; tCtx.lineCap = 'round'; tCtx.lineJoin = 'round'; }
        switch (ann.type) {
          case 'pen': case 'handwriting_text': case 'eraser_pixel': if (ann.points?.length > 0) { const p0 = transformPoint(ann.points[0].x, ann.points[0].y, ann); tCtx.moveTo(p0.x, p0.y); for (let i = 1; i < ann.points.length; i++) { const pt = transformPoint(ann.points[i].x, ann.points[i].y, ann); tCtx.lineTo(pt.x, pt.y); } } break;
          case 'rect': { const r1 = transformPoint(ann.startX, ann.startY, ann); const r2 = transformPoint(ann.endX, ann.startY, ann); const r3 = transformPoint(ann.endX, ann.endY, ann); const r4 = transformPoint(ann.startX, ann.endY, ann); tCtx.moveTo(r1.x, r1.y); tCtx.lineTo(r2.x, r2.y); tCtx.lineTo(r3.x, r3.y); tCtx.lineTo(r4.x, r4.y); tCtx.closePath(); break; }
          case 'triangle': { const t_r1 = transformPoint((ann.startX + ann.endX)/2, ann.startY, ann); const t_r2 = transformPoint(ann.endX, ann.endY, ann); const t_r3 = transformPoint(ann.startX, ann.endY, ann); tCtx.moveTo(t_r1.x, t_r1.y); tCtx.lineTo(t_r2.x, t_r2.y); tCtx.lineTo(t_r3.x, t_r3.y); tCtx.closePath(); break; }
          case 'circle': { const cx = (ann.startX + ann.endX) / 2; const cy = (ann.startY + ann.endY) / 2; const center = transformPoint(cx, cy, ann); const rx = Math.abs(ann.endX - ann.startX) / 2 * Math.abs(ann.scaleX || ann.scale || 1); const ry = Math.abs(ann.endY - ann.startY) / 2 * Math.abs(ann.scaleY || ann.scale || 1); tCtx.ellipse(center.x, center.y, rx, ry, ann.rotation || 0, 0, 2 * Math.PI); break; }
          case 'star': { const c_star = transformPoint((ann.startX + ann.endX) / 2, (ann.startY + ann.endY) / 2, ann); const rx_star = Math.abs(ann.endX - ann.startX) / 2 * Math.abs(ann.scaleX || ann.scale || 1); const ry_star = Math.abs(ann.endY - ann.startY) / 2 * Math.abs(ann.scaleY || ann.scale || 1); const outerRadius = Math.min(rx_star, ry_star); const innerRadius = outerRadius * 0.4; let rot_star = -Math.PI / 2 + (ann.rotation || 0); let step_star = Math.PI / 5; tCtx.moveTo(c_star.x + Math.cos(rot_star) * outerRadius, c_star.y + Math.sin(rot_star) * outerRadius); for(let i=0; i<5; i++){ tCtx.lineTo(c_star.x + Math.cos(rot_star) * outerRadius, c_star.y + Math.sin(rot_star) * outerRadius); rot_star += step_star; tCtx.lineTo(c_star.x + Math.cos(rot_star) * innerRadius, c_star.y + Math.sin(rot_star) * innerRadius); rot_star += step_star; } tCtx.closePath(); break; }
          case 'line': tCtx.moveTo(ann.startX, ann.startY); tCtx.lineTo(ann.endX, ann.endY); break;
          case 'polyline': if (ann.points?.length > 0) { tCtx.moveTo(ann.points[0].x, ann.points[0].y); for (let i = 1; i < ann.points.length; i++) tCtx.lineTo(ann.points[i].x, ann.points[i].y); } break;
          case 'polygon': if (ann.points?.length > 0) { tCtx.moveTo(ann.points[0].x, ann.points[0].y); for (let i = 1; i < ann.points.length; i++) tCtx.lineTo(ann.points[i].x, ann.points[i].y); tCtx.closePath(); } break;
          case 'curve': tCtx.moveTo(ann.startX, ann.startY); if (ann.midX !== undefined) tCtx.quadraticCurveTo(ann.midX, ann.midY, ann.endX, ann.endY); else tCtx.lineTo(ann.endX, ann.endY); break;
          case 'arrow': tCtx.moveTo(ann.startX, ann.startY); tCtx.lineTo(ann.endX, ann.endY); const headlen = Math.max(15, (ann.width || 4) * 3); const angle = Math.atan2(ann.endY - ann.startY, ann.endX - ann.startX); tCtx.moveTo(ann.endX, ann.endY); tCtx.lineTo(ann.endX - headlen * Math.cos(angle - Math.PI / 6), ann.endY - headlen * Math.sin(angle - Math.PI / 6)); tCtx.moveTo(ann.endX, ann.endY); tCtx.lineTo(ann.endX - headlen * Math.cos(angle + Math.PI / 6), ann.endY - headlen * Math.sin(angle + Math.PI / 6)); break;
          case 'double_arrow': tCtx.moveTo(ann.startX, ann.startY); tCtx.lineTo(ann.endX, ann.endY); const headlenD = Math.max(15, (ann.width || 4) * 3); const angleD = Math.atan2(ann.endY - ann.startY, ann.endX - ann.startX); tCtx.moveTo(ann.endX, ann.endY); tCtx.lineTo(ann.endX - headlenD * Math.cos(angleD - Math.PI / 6), ann.endY - headlenD * Math.sin(angleD - Math.PI / 6)); tCtx.moveTo(ann.endX, ann.endY); tCtx.lineTo(ann.endX - headlenD * Math.cos(angleD + Math.PI / 6), ann.endY - headlenD * Math.sin(angleD + Math.PI / 6)); tCtx.moveTo(ann.startX, ann.startY); tCtx.lineTo(ann.startX + headlenD * Math.cos(angleD - Math.PI / 6), ann.startY + headlenD * Math.sin(angleD - Math.PI / 6)); tCtx.moveTo(ann.startX, ann.startY); tCtx.lineTo(ann.startX + headlenD * Math.cos(angleD + Math.PI / 6), ann.startY + headlenD * Math.sin(angleD + Math.PI / 6)); break;
          case 'curve_arrow': tCtx.moveTo(ann.startX, ann.startY); if (ann.midX !== undefined) tCtx.quadraticCurveTo(ann.midX, ann.midY, ann.endX, ann.endY); else tCtx.lineTo(ann.endX, ann.endY); const headlenC = Math.max(15, (ann.width || 4) * 3); const angleC = ann.midX !== undefined ? Math.atan2(ann.endY - ann.midY, ann.endX - ann.midX) : Math.atan2(ann.endY - ann.startY, ann.endX - ann.startX); tCtx.moveTo(ann.endX, ann.endY); tCtx.lineTo(ann.endX - headlenC * Math.cos(angleC - Math.PI / 6), ann.endY - headlenC * Math.sin(angleC - Math.PI / 6)); tCtx.moveTo(ann.endX, ann.endY); tCtx.lineTo(ann.endX - headlenC * Math.cos(angleC + Math.PI / 6), ann.endY - headlenC * Math.sin(angleC + Math.PI / 6)); break;
          case 'double_curve_arrow': tCtx.moveTo(ann.startX, ann.startY); if (ann.midX !== undefined) tCtx.quadraticCurveTo(ann.midX, ann.midY, ann.endX, ann.endY); else tCtx.lineTo(ann.endX, ann.endY); const headlenDC = Math.max(15, (ann.width || 4) * 3); const angleEnd = ann.midX !== undefined ? Math.atan2(ann.endY - ann.midY, ann.endX - ann.midX) : Math.atan2(ann.endY - ann.startY, ann.endX - ann.startX); tCtx.moveTo(ann.endX, ann.endY); tCtx.lineTo(ann.endX - headlenDC * Math.cos(angleEnd - Math.PI / 6), ann.endY - headlenDC * Math.sin(angleEnd - Math.PI / 6)); tCtx.moveTo(ann.endX, ann.endY); tCtx.lineTo(ann.endX - headlenDC * Math.cos(angleEnd + Math.PI / 6), ann.endY - headlenDC * Math.sin(angleEnd + Math.PI / 6)); const angleStart = ann.midX !== undefined ? Math.atan2(ann.startY - ann.midY, ann.startX - ann.midX) : Math.atan2(ann.startY - ann.endY, ann.startX - ann.endX); tCtx.moveTo(ann.startX, ann.startY); tCtx.lineTo(ann.startX - headlenDC * Math.cos(angleStart - Math.PI / 6), ann.startY - headlenDC * Math.sin(angleStart - Math.PI / 6)); tCtx.moveTo(ann.startX, ann.startY); tCtx.lineTo(ann.startX - headlenDC * Math.cos(angleStart + Math.PI / 6), ann.startY - headlenDC * Math.sin(angleStart + Math.PI / 6)); break;
        }
        if (!isGlow && ann.fillColor && ann.fillColor !== 'transparent' && ['rect', 'circle', 'triangle', 'star', 'polygon'].includes(ann.type)) tCtx.fill(); tCtx.stroke(); tCtx.restore();
      };
      if (ann.hasGlow && ann.type !== 'eraser_pixel') drawShape(true); drawShape(false); tCtx.restore();
      if (hasErasers) { tCtx.save(); tCtx.globalCompositeOperation = 'destination-out'; tCtx.lineCap = 'round'; tCtx.lineJoin = 'round'; tCtx.strokeStyle = 'rgba(0,0,0,1)'; for (let eraser of ann.erasers) { tCtx.lineWidth = eraser.width || 4; tCtx.beginPath(); if (eraser.points?.length > 0) { const p0 = transformPoint(eraser.points[0].x, eraser.points[0].y, ann); tCtx.moveTo(p0.x, p0.y); for (let i = 1; i < eraser.points.length; i++) { const pt = transformPoint(eraser.points[i].x, eraser.points[i].y, ann); tCtx.lineTo(pt.x, pt.y); } tCtx.stroke(); } } tCtx.restore(); ctx.drawImage(offCanvas, 0, 0); }
    };
    annotations.forEach(drawAnn); if (currentAnnotation) drawAnn(currentAnnotation);
    if (selectedIds.length === 1 && (currentTool === ToolType.SELECT || currentTool === ToolType.LASSO)) { const ann = annotations.find(a => a.id === selectedIds[0]); if (ann && (!textInput || ann.id !== textInput.id)) { ctx.save(); const drawHandle = (pos, isRound) => { ctx.beginPath(); if (isRound) ctx.arc(pos.x, pos.y, 6, 0, Math.PI*2); else ctx.rect(pos.x - 6, pos.y - 6, 12, 12); ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2; ctx.fill(); ctx.stroke(); }; if (['arrow', 'line', 'curve', 'curve_arrow', 'polyline', 'double_arrow', 'double_curve_arrow', 'polygon'].includes(ann.type)) { if (['polyline', 'polygon'].includes(ann.type)) ann.points.forEach(p => drawHandle(p, true)); else { drawHandle({ x: ann.startX, y: ann.startY }, true); drawHandle({ x: ann.endX, y: ann.endY }, true); if (ann.midX !== undefined) drawHandle({ x: ann.midX, y: ann.midY }, true); } } else { const bbox = getBBox(ann); if (bbox) { const p1 = transformPoint(bbox.x, bbox.y, ann); const p2 = transformPoint(bbox.x + bbox.w, bbox.y, ann); const p3 = transformPoint(bbox.x + bbox.w, bbox.y + bbox.h, ann); const p4 = transformPoint(bbox.x, bbox.y + bbox.h, ann); const pt = transformPoint(bbox.x + bbox.w/2, bbox.y, ann); const pb = transformPoint(bbox.x + bbox.w/2, bbox.y + bbox.h, ann); const pl = transformPoint(bbox.x, bbox.y + bbox.h/2, ann); const pr = transformPoint(bbox.x + bbox.w, bbox.y + bbox.h/2, ann); ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]); drawHandle(p1, true); drawHandle(p2, true); drawHandle(p3, true); drawHandle(p4, true); drawHandle(pt, false); drawHandle(pb, false); drawHandle(pl, false); drawHandle(pr, false); const rotAngle = (ann.rotation || 0) - Math.PI/2; const protX = pt.x + 30 * Math.cos(rotAngle); const protY = pt.y + 30 * Math.sin(rotAngle); ctx.beginPath(); ctx.moveTo(pt.x, pt.y); ctx.lineTo(protX, protY); ctx.stroke(); drawHandle({x: protX, y: protY}, true); } } ctx.restore(); } } else if (selectedIds.length > 1 && (currentTool === ToolType.SELECT || currentTool === ToolType.LASSO)) { const multiBox = getMultiBBox(annotations, selectedIds); if (multiBox) { ctx.save(); ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]); ctx.strokeRect(multiBox.x, multiBox.y, multiBox.w, multiBox.h); ctx.restore(); } }
    if (currentTool === ToolType.LASSO && lassoPoints.length > 0) { ctx.save(); ctx.beginPath(); ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y); for (let i = 1; i < lassoPoints.length; i++) ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y); ctx.closePath(); ctx.strokeStyle = '#3b82f6'; ctx.setLineDash([8, 8]); ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = 'rgba(59, 130, 246, 0.15)'; ctx.fill(); ctx.restore(); }
  }, [activeImageId, baseImage, annotations, currentAnnotation, selectedIds, currentTool, lassoPoints, textInput]);

  const getCanvasPos = (clientX, clientY) => { const canvas = canvasRef.current; const rect = canvas.getBoundingClientRect(); return { x: (clientX - rect.left) * (canvas.width / rect.width), y: (clientY - rect.top) * (canvas.height / rect.height) }; };
  const checkHandleHit = (px, py, ann) => {
    const hs = 20; if (['arrow', 'line', 'curve', 'curve_arrow', 'polyline', 'double_arrow', 'double_curve_arrow', 'polygon'].includes(ann.type)) { if (['polyline', 'polygon'].includes(ann.type)) { for (let i = 0; i < ann.points.length; i++) if (Math.hypot(px - ann.points[i].x, py - ann.points[i].y) < hs) return `poly_${i}`; const threshold = Math.max((ann.width || 4) / 2 + 10, 15); for (let i = 0; i < ann.points.length - 1; i++) if (distToSegment({x: px, y: py}, ann.points[i], ann.points[i+1]) < threshold) return 'move'; return null; } if (Math.hypot(px - ann.startX, py - ann.startY) < hs) return 'start'; if (Math.hypot(px - ann.endX, py - ann.endY) < hs) return 'end'; if (ann.midX !== undefined && Math.hypot(px - ann.midX, py - ann.midY) < hs) return 'mid'; const threshold = Math.max((ann.width || 4) / 2 + 10, 15); if (ann.midX !== undefined) { if (distToSegment({x: px, y: py}, {x: ann.startX, y: ann.startY}, {x: ann.midX, y: ann.midY}) < threshold || distToSegment({x: px, y: py}, {x: ann.midX, y: ann.midY}, {x: ann.endX, y: ann.endY}) < threshold) return 'move'; } else { if (distToSegment({x: px, y: py}, {x: ann.startX, y: ann.startY}, {x: ann.endX, y: ann.endY}) < threshold) return 'move'; } return null; }
    const bbox = getBBox(ann); if (!bbox) return null; const check = (hx, hy, type) => { const p = transformPoint(hx, hy, ann); if (Math.hypot(px - p.x, py - p.y) < hs) return type; return null; }; let hit = null; const pt = transformPoint(bbox.x + bbox.w/2, bbox.y, ann); const rotAngle = (ann.rotation || 0) - Math.PI/2; if (Math.hypot(px - (pt.x + 30 * Math.cos(rotAngle)), py - (pt.y + 30 * Math.sin(rotAngle))) < hs) return 'rotate'; hit = check(bbox.x, bbox.y, 'tl'); if (hit) return hit; hit = check(bbox.x + bbox.w, bbox.y, 'tr'); if (hit) return hit; hit = check(bbox.x, bbox.y + bbox.h, 'bl'); if (hit) return hit; hit = check(bbox.x + bbox.w, bbox.y + bbox.h, 'br'); if (hit) return hit; hit = check(bbox.x + bbox.w/2, bbox.y, 't'); if (hit) return hit; hit = check(bbox.x + bbox.w/2, bbox.y + bbox.h, 'b'); if (hit) return hit; hit = check(bbox.x, bbox.y + bbox.h/2, 'l'); if (hit) return hit; hit = check(bbox.x + bbox.w, bbox.y + bbox.h/2, 'r'); if (hit) return hit; const lp = inverseTransformPoint(px, py, ann); if (lp.x >= bbox.x - 10 && lp.x <= bbox.x + bbox.w + 10 && lp.y >= bbox.y - 10 && lp.y <= bbox.y + bbox.h + 10) return 'move'; return null;
  };
  const checkHit = useCallback((x, y, anns) => {
    for (let i = anns.length - 1; i >= 0; i--) { const a = anns[i]; const lp = inverseTransformPoint(x, y, a); const threshold = Math.max(a.width / 2 + 10, 15); let hit = false; if (a.type === 'pen' || a.type === 'handwriting_text' || a.type === 'eraser_pixel') { for (let j = 0; j < a.points.length - 1; j++) if (distToSegment(lp, a.points[j], a.points[j+1]) < threshold) { hit = true; break; } } else if (a.type === 'rect' || a.type === 'triangle' || a.type === 'star') { const rx = Math.min(a.startX, a.endX), ry = Math.min(a.startY, a.endY), rw = Math.abs(a.endX - a.startX), rh = Math.abs(a.endY - a.startY); if (a.fillColor && a.fillColor !== 'transparent') { if (lp.x >= rx && lp.x <= rx + rw && lp.y >= ry && lp.y <= ry + rh) hit = true; } else { if ((lp.x >= rx - 10 && lp.x <= rx + rw + 10 && Math.abs(lp.y - ry) < 15) || (lp.x >= rx - 10 && lp.x <= rx + rw + 10 && Math.abs(lp.y - (ry + rh)) < 15) || (lp.y >= ry - 10 && lp.y <= ry + rh + 10 && Math.abs(lp.x - rx) < 15) || (lp.y >= ry - 10 && lp.y <= ry + rh + 10 && Math.abs(lp.x - (rx + rw)) < 15)) hit = true; } } else if (a.type === 'polygon') { if (a.fillColor && a.fillColor !== 'transparent') { if (pointInPolygon(lp, a.points)) hit = true; } else { for (let j = 0; j < a.points.length; j++) if (distToSegment({x: lp.x, y: lp.y}, a.points[j], a.points[(j + 1) % a.points.length]) < threshold) { hit = true; break; } } } else if (a.type === 'circle') { const cx = (a.startX + a.endX) / 2, cy = (a.startY + a.endY) / 2, rx = Math.abs(a.endX - a.startX) / 2, ry = Math.abs(a.endY - a.startY) / 2; if (rx > 0 && ry > 0) { const d = Math.pow(lp.x - cx, 2) / Math.pow(rx, 2) + Math.pow(lp.y - cy, 2) / Math.pow(ry, 2); if ((a.fillColor && a.fillColor !== 'transparent') ? d <= 1 : Math.abs(d - 1) < 0.3) hit = true; } } else if (['arrow', 'line', 'curve', 'curve_arrow', 'polyline', 'double_arrow', 'double_curve_arrow'].includes(a.type)) { if (a.type === 'polyline') { for (let j = 0; j < a.points.length - 1; j++) if (distToSegment({x: lp.x, y: lp.y}, a.points[j], a.points[j+1]) < threshold) { hit = true; break; } } else if (a.midX !== undefined) { if (distToSegment({x: lp.x, y: lp.y}, {x: a.startX, y: a.startY}, {x: a.midX, y: a.midY}) < threshold) hit = true; if (distToSegment({x: lp.x, y: lp.y}, {x: a.midX, y: a.midY}, {x: a.endX, y: a.endY}) < threshold) hit = true; } else { if (distToSegment({x: lp.x, y: lp.y}, {x: a.startX, y: a.startY}, {x: a.endX, y: a.endY}) < threshold) hit = true; } } else if (a.type === 'text') { if (lp.x >= a.x - (a._w || 100)/2 - 10 && lp.x <= a.x + (a._w || 100)/2 + 10 && lp.y >= a.y - (a._h || 48)/2 - 10 && lp.y <= a.y + (a._h || 48)/2 + 10) hit = true; } if (hit) return a; } return null;
  }, []);

  const handlePointerDown = (e) => {
    if (e.target.closest('.text-overlay') || e.target.closest('.selection-menu')) return; if (e.target.tagName === 'CANVAS' || e.target.closest('.canvas-container')) e.preventDefault(); const isTouch = e.pointerType === 'touch'; setActivePopover(null); if (textInput) handleTextSubmit(); historySnapshotRef.current = annotations; activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.current.size >= 2) { isDrawingRef.current = false; setCurrentAnnotation(null); dragModeRef.current = null; const pts = Array.from(activePointers.current.values()); const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y); const center = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }; lastPinch.current = { dist, center, initialTransform: { ...transformRef.current } }; return; }
    if (activePointers.current.size === 1) { if (e.target.tagName !== 'CANVAS') return; const pos = getCanvasPos(e.clientX, e.clientY); const isUniversalNavigation = e.button === 1 || (e.button === 0 && e.altKey); const isSelectModeNavigation = currentToolRef.current === ToolType.SELECT && e.button === 0 && !e.altKey; const isTouchNavigation = isTouch && !fingerDrawMode; const effectiveShouldNavigate = isUniversalNavigation || isSelectModeNavigation || isTouchNavigation;
      if (effectiveShouldNavigate) { if (selectedIds.length === 1) { const selAnn = annotations.find(a => a.id === selectedIds[0]); const handle = checkHandleHit(pos.x, pos.y, selAnn); if (handle) { dragModeRef.current = handle; dragStartPointerRef.current = pos; dragStartAnnsRef.current = [JSON.parse(JSON.stringify(selAnn))]; if (currentToolRef.current !== ToolType.SELECT) handleToolChange(ToolType.SELECT, true); isPotentialTapRef.current = false; return; } }
        if (selectedIds.length > 0) { const mBox = getMultiBBox(annotations, selectedIds); if (mBox && pos.x >= mBox.x && pos.x <= mBox.x + mBox.w && pos.y >= mBox.y && pos.y <= mBox.y + mBox.h) { dragModeRef.current = 'move_multi'; dragStartPointerRef.current = pos; dragStartAnnsRef.current = annotations.filter(a => selectedIds.includes(a.id)).map(a => JSON.parse(JSON.stringify(a))); if (currentToolRef.current !== ToolType.SELECT) handleToolChange(ToolType.SELECT, true); isPotentialTapRef.current = true; dragStartClientPosRef.current = { x: e.clientX, y: e.clientY }; return; } }
        const hit = checkHit(pos.x, pos.y, annotations); if (hit) { let targetIds = [hit.id]; if (hit.groupId) targetIds = annotations.filter(a => a.groupId === hit.groupId).map(a => a.id); setSelectedIds(targetIds); if (hit.color) setStrokeColor(hit.color); if (hit.fillColor !== undefined) { setIsFillTransparent(hit.fillColor === 'transparent'); if (hit.fillColor !== 'transparent') setFillColor(hit.fillColor); } if (hit.width) setLineWidth(hit.width); if (hit.fontSize) setFontSize(hit.fontSize); if (hit.hasGlow !== undefined) setTextGlow(hit.hasGlow); dragModeRef.current = 'move'; dragStartPointerRef.current = pos; dragStartAnnsRef.current = annotations.filter(a => targetIds.includes(a.id)).map(a => JSON.parse(JSON.stringify(a))); if (currentToolRef.current !== ToolType.SELECT) handleToolChange(ToolType.SELECT, true); isPotentialTapRef.current = true; dragStartClientPosRef.current = { x: e.clientX, y: e.clientY }; return; }
        if (currentToolRef.current === ToolType.SELECT) setSelectedIds([]); isPotentialTapRef.current = true; dragStartClientPosRef.current = { x: e.clientX, y: e.clientY }; dragModeRef.current = 'canvas_pan'; panStartClientRef.current = { x: e.clientX, y: e.clientY }; panStartTransformRef.current = { ...transformRef.current }; return;
      }
      if (currentToolRef.current === ToolType.LASSO) { setSelectedIds([]); setLassoPoints([pos]); isDrawingRef.current = true; return; } if (currentToolRef.current === ToolType.ERASER_OBJ) { isDrawingRef.current = true; const hit = checkHit(pos.x, pos.y, annotations); if (hit) { pushHistory(annotations); setAnnotations(prev => prev.filter(a => a.id !== hit.id && (!hit.groupId || a.groupId !== hit.groupId))); } return; } if (currentToolRef.current === ToolType.TEXT) { setSelectedIds([]); setTextInput({ canvasX: pos.x, canvasY: pos.y, value: '' }); return; } if (currentToolRef.current === ToolType.HANDWRITING_TEXT) { if (handwritingTimerRef.current) clearTimeout(handwritingTimerRef.current); }
      setSelectedIds([]); isDrawingRef.current = true; const baseAnn = { id: Date.now().toString(), type: currentToolRef.current, color: strokeColor, fillColor: isFillTransparent ? 'transparent' : fillColor, width: lineWidth, fontSize: fontSize, scaleX: 1, scaleY: 1, rotation: 0, tx: 0, ty: 0, hasGlow: textGlow }; if (currentToolRef.current === ToolType.PEN || currentToolRef.current === ToolType.ERASER_PIXEL || currentToolRef.current === ToolType.HANDWRITING_TEXT) setCurrentAnnotation({ ...baseAnn, points: [{ x: pos.x, y: pos.y }] }); else setCurrentAnnotation({ ...baseAnn, startX: pos.x, startY: pos.y, endX: pos.x, endY: pos.y });
    }
  };

  const handlePointerMove = (e) => {
    if (e.target.closest('.text-overlay') || e.target.closest('.selection-menu')) return; if (e.target.tagName === 'CANVAS' || e.target.closest('.canvas-container')) e.preventDefault(); if (activePointers.current.has(e.pointerId)) activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.current.size >= 2) { const pts = Array.from(activePointers.current.values()); const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y); const center = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }; if (lastPinch.current && wrapperRef.current) { const { dist: startDist, center: startCenter, initialTransform } = lastPinch.current; const scaleRatio = dist / startDist; let newScale = Math.min(Math.max(0.1, initialTransform.scale * scaleRatio), 10); const dx = center.x - startCenter.x; const dy = center.y - startCenter.y; const wrapperRect = wrapperRef.current.getBoundingClientRect(); const pinchOffsetX = startCenter.x - (wrapperRect.left + wrapperRect.width / 2); const pinchOffsetY = startCenter.y - (wrapperRect.top + wrapperRect.height / 2); const actualRatio = newScale / initialTransform.scale; setTransform({ scale: newScale, x: initialTransform.x + dx + (pinchOffsetX - pinchOffsetX * actualRatio), y: initialTransform.y + dy + (pinchOffsetY - pinchOffsetY * actualRatio) }); } return; }
    if (activePointers.current.size === 1) { if (isPotentialTapRef.current && dragStartClientPosRef.current) { if (Math.hypot(e.clientX - dragStartClientPosRef.current.x, e.clientY - dragStartClientPosRef.current.y) > 10) isPotentialTapRef.current = false; } if (dragModeRef.current === 'canvas_pan') { if (panStartClientRef.current && panStartTransformRef.current) { const dx = e.clientX - panStartClientRef.current.x; const dy = e.clientY - panStartClientRef.current.y; setTransform({ ...panStartTransformRef.current, x: panStartTransformRef.current.x + dx, y: panStartTransformRef.current.y + dy }); } return; } const pos = getCanvasPos(e.clientX, e.clientY); if (currentToolRef.current === ToolType.LASSO && isDrawingRef.current) { setLassoPoints(prev => [...prev, pos]); return; } const dragMode = dragModeRef.current;
      if (dragMode && dragMode !== 'canvas_pan') { const startPos = dragStartPointerRef.current; const dx = pos.x - startPos.x; const dy = pos.y - startPos.y; if (dragMode === 'move_multi' || (dragMode === 'move' && selectedIds.length > 1)) { if (dragStartAnnsRef.current.length > 0) { setAnnotations(prev => prev.map(a => { if (selectedIds.includes(a.id)) { const startAnn = dragStartAnnsRef.current.find(sa => sa.id === a.id); if (!startAnn) return a; if (['arrow', 'line', 'curve', 'curve_arrow', 'polyline', 'double_arrow', 'double_curve_arrow', 'polygon'].includes(startAnn.type)) { if (['polyline', 'polygon'].includes(startAnn.type)) return { ...a, points: startAnn.points.map(p => ({ x: p.x + dx, y: p.y + dy })) }; return { ...a, startX: startAnn.startX + dx, startY: startAnn.startY + dy, endX: startAnn.endX + dx, endY: startAnn.endY + dy, midX: startAnn.midX !== undefined ? startAnn.midX + dx : undefined, midY: startAnn.midY !== undefined ? startAnn.midY + dy : undefined }; } else return { ...a, tx: (startAnn.tx || 0) + dx, ty: (startAnn.ty || 0) + dy }; } return a; })); } return; } if (selectedIds.length === 1 && dragStartAnnsRef.current[0]) { const startAnn = dragStartAnnsRef.current[0]; const selectedId = selectedIds[0]; if (['arrow', 'line', 'curve', 'curve_arrow', 'polyline', 'double_arrow', 'double_curve_arrow', 'polygon'].includes(startAnn.type)) { if (dragMode.startsWith('poly_')) { const idx = parseInt(dragMode.split('_')[1], 10); setAnnotations(prev => prev.map(a => { if (a.id === selectedId) { const newPoints = [...a.points]; newPoints[idx] = { x: startAnn.points[idx].x + dx, y: startAnn.points[idx].y + dy }; if (startAnn.type === 'polygon') { if (idx === 0) newPoints[newPoints.length - 1] = newPoints[0]; if (idx === startAnn.points.length - 1) newPoints[0] = newPoints[newPoints.length - 1]; } return { ...a, points: newPoints }; } return a; })); } else if (dragMode === 'start') setAnnotations(prev => prev.map(a => a.id === selectedId ? { ...a, startX: startAnn.startX + dx, startY: startAnn.startY + dy } : a)); else if (dragMode === 'end') setAnnotations(prev => prev.map(a => a.id === selectedId ? { ...a, endX: startAnn.endX + dx, endY: startAnn.endY + dy } : a)); else if (dragMode === 'mid') setAnnotations(prev => prev.map(a => a.id === selectedId ? { ...a, midX: startAnn.midX + dx, midY: startAnn.midY + dy } : a)); else if (dragMode === 'move') { if (['polyline', 'polygon'].includes(startAnn.type)) setAnnotations(prev => prev.map(a => a.id === selectedId ? { ...a, points: startAnn.points.map(p => ({ x: p.x + dx, y: p.y + dy })) } : a)); else setAnnotations(prev => prev.map(a => a.id === selectedId ? { ...a, startX: startAnn.startX + dx, startY: startAnn.startY + dy, endX: startAnn.endX + dx, endY: startAnn.endY + dy, midX: startAnn.midX !== undefined ? startAnn.midX + dx : undefined, midY: startAnn.midY !== undefined ? startAnn.midY + dy : undefined } : a)); } return; } const r = startAnn.rotation || 0; const cosR = Math.cos(r), sinR = Math.sin(r); const ldx = dx * cosR + dy * sinR; const ldy = -dx * sinR + dy * cosR; const bbox = getBBox(startAnn); const w = bbox.w || 1; const h = bbox.h || 1; const oldSx = startAnn.scaleX || startAnn.scale || 1; const oldSy = startAnn.scaleY || startAnn.scale || 1; let newSx = oldSx, newSy = oldSy; let dcx = 0, dcy = 0; if (['l', 'r', 't', 'b'].includes(dragMode)) { if (dragMode === 'l') { newSx = oldSx - ldx / w; dcx = ldx / 2; } if (dragMode === 'r') { newSx = oldSx + ldx / w; dcx = ldx / 2; } if (dragMode === 't') { newSy = oldSy - ldy / h; dcy = ldy / 2; } if (dragMode === 'b') { newSy = oldSy + ldy / h; dcy = ldy / 2; } newSx = Math.max(0.05, newSx); newSy = Math.max(0.05, newSy); if (dragMode === 'l' || dragMode === 'r') dcx = (dragMode === 'r' ? (newSx - oldSx) : -(newSx - oldSx)) * w / 2; if (dragMode === 't' || dragMode === 'b') dcy = (dragMode === 'b' ? (newSy - oldSy) : -(newSy - oldSy)) * h / 2; } else if (['tl', 'tr', 'bl', 'br'].includes(dragMode)) { let fixLx = dragMode.includes('l') ? (w/2) * oldSx : -(w/2) * oldSx; let fixLy = dragMode.includes('t') ? (h/2) * oldSy : -(h/2) * oldSy; let currentLx = -fixLx + ldx, currentLy = -fixLy + ldy; let ratio = Math.hypot(currentLx - fixLx, currentLy - fixLy) / Math.max(1, Math.hypot(-fixLx - fixLx, -fixLy - fixLy)); newSx = Math.max(0.05, oldSx * ratio); newSy = Math.max(0.05, oldSy * ratio); const actualRatio = newSx / oldSx; dcx = fixLx * (1 - actualRatio); dcy = fixLy * (1 - actualRatio); } else if (dragMode === 'rotate') { const center = transformPoint(bbox.x + bbox.w/2, bbox.y + bbox.h/2, startAnn); setAnnotations(prev => prev.map(a => a.id === selectedId ? { ...a, rotation: (startAnn.rotation || 0) + (Math.atan2(pos.y - center.y, pos.x - center.x) - Math.atan2(startPos.y - center.y, startPos.x - center.x)) } : a)); return; } else if (dragMode === 'move') { setAnnotations(prev => prev.map(a => a.id === selectedId ? { ...a, tx: (startAnn.tx || 0) + dx, ty: (startAnn.ty || 0) + dy } : a)); return; } if (['l', 'r', 't', 'b', 'tl', 'tr', 'bl', 'br'].includes(dragMode)) { const dtx = dcx * cosR - dcy * sinR; const dty = dcx * sinR + dcy * cosR; setAnnotations(prev => prev.map(a => a.id === selectedId ? { ...a, scaleX: newSx, scaleY: newSy, tx: (startAnn.tx || 0) + dtx, ty: (startAnn.ty || 0) + dty } : a)); } return; } } if (currentToolRef.current === ToolType.ERASER_OBJ && isDrawingRef.current) { const hit = checkHit(pos.x, pos.y, annotations); if (hit) { pushHistory(annotationsRef.current); setAnnotations(prev => prev.filter(a => a.id !== hit.id && (!hit.groupId || a.groupId !== hit.groupId))); } return; } if (isDrawingRef.current && currentAnnotation) { if (currentAnnotation.type === ToolType.PEN || currentAnnotation.type === ToolType.ERASER_PIXEL || currentAnnotation.type === ToolType.HANDWRITING_TEXT) setCurrentAnnotation(prev => ({ ...prev, points: [...prev.points, { x: pos.x, y: pos.y }] })); else setCurrentAnnotation(prev => ({ ...prev, endX: pos.x, endY: pos.y })); }
    }
  };

  const handlePointerUp = (e) => {
    if (e.target.closest('.text-overlay') || e.target.closest('.selection-menu')) return; let isTap = isPotentialTapRef.current; let hasDragged = !!dragModeRef.current && dragModeRef.current !== 'canvas_pan'; activePointers.current.delete(e.pointerId); if (activePointers.current.size < 2) { lastPinch.current = null; } if (activePointers.current.size === 1 && dragModeRef.current === 'canvas_pan') { const remainingPointer = Array.from(activePointers.current.values())[0]; panStartClientRef.current = { x: remainingPointer.x, y: remainingPointer.y }; panStartTransformRef.current = { ...transformRef.current }; } else if (activePointers.current.size === 0) { panStartClientRef.current = null; panStartTransformRef.current = null; }
    if (isTap && !isDrawingRef.current) { const pos = getCanvasPos(e.clientX, e.clientY); const hit = checkHit(pos.x, pos.y, annotations); if (hit) { if (currentToolRef.current !== ToolType.SELECT) handleToolChange(ToolType.SELECT, true); let targetIds = [hit.id]; if (hit.groupId) targetIds = annotations.filter(a => a.groupId === hit.groupId).map(a => a.id); setSelectedIds(targetIds); if (hit.color) setStrokeColor(hit.color); if (hit.fillColor !== undefined) { setIsFillTransparent(hit.fillColor === 'transparent'); if (hit.fillColor !== 'transparent') setFillColor(hit.fillColor); } if (hit.width) setLineWidth(hit.width); if (hit.fontSize) setFontSize(hit.fontSize); if (hit.hasGlow !== undefined) setTextGlow(hit.hasGlow); } else { setSelectedIds([]); } }
    isPotentialTapRef.current = false; if (activePointers.current.size === 0) dragModeRef.current = null; dragStartAnnsRef.current = [];
    if (currentToolRef.current === ToolType.LASSO && isDrawingRef.current) { isDrawingRef.current = false; if (lassoPoints.length > 2) { const hits = annotations.filter(ann => { const bbox = getBBox(ann); if (!bbox) return false; return pointInPolygon(transformPoint(bbox.x + bbox.w/2, bbox.y + bbox.h/2, ann), lassoPoints); }); let selectedSet = new Set(hits.map(a => a.id)); hits.forEach(hit => { if (hit.groupId) annotations.filter(a => a.groupId === hit.groupId).forEach(a => selectedSet.add(a.id)); }); setSelectedIds(Array.from(selectedSet)); } else setSelectedIds([]); setLassoPoints([]); return; }
    if (isDrawingRef.current) { isDrawingRef.current = false; if (currentAnnotation) { if (currentAnnotation.type === ToolType.ERASER_PIXEL) { pushHistory(historySnapshotRef.current); setAnnotations(prev => { const eraserPoints = currentAnnotation.points; if (!eraserPoints || eraserPoints.length === 0) return prev; let newAnns = []; for (const a of prev) { let hit = false; for (let i = 0; i < eraserPoints.length; i += 3) { if (checkHit(eraserPoints[i].x, eraserPoints[i].y, [a])) { hit = true; break; } } if (!hit && checkHit(eraserPoints[eraserPoints.length-1].x, eraserPoints[eraserPoints.length-1].y, [a])) hit = true; if (hit) { const splitResult = splitAnnotationByEraser(a, eraserPoints, currentAnnotation.width); newAnns.push(...splitResult); } else { newAnns.push(a); } } return newAnns; }); } else if (currentAnnotation.type === ToolType.HANDWRITING_TEXT) { pushHistory(historySnapshotRef.current); setAnnotations(prev => [...prev, currentAnnotation]); handwritingStrokesRef.current.push(currentAnnotation.id); handwritingTimerRef.current = setTimeout(() => { triggerAutoOCR([...handwritingStrokesRef.current]); handwritingStrokesRef.current = []; }, 600); } else { pushHistory(historySnapshotRef.current); setAnnotations(prev => [...prev, currentAnnotation]); } setCurrentAnnotation(null); } } else if (hasDragged && historySnapshotRef.current) pushHistory(historySnapshotRef.current);
  };

  const handleWheel = (e) => { if (!wrapperRef.current) return; const wrapperRect = wrapperRef.current.getBoundingClientRect(); const scaleRatio = e.deltaY < 0 ? 1.1 : 0.9; setTransform(prev => { let newScale = Math.min(Math.max(0.1, prev.scale * scaleRatio), 10); const actualRatio = newScale / prev.scale; const pinchOffsetX = e.clientX - (wrapperRect.left + wrapperRect.width / 2); const pinchOffsetY = e.clientY - (wrapperRect.top + wrapperRect.height / 2); return { scale: newScale, x: prev.x + (pinchOffsetX - pinchOffsetX * actualRatio), y: prev.y + (pinchOffsetY - pinchOffsetY * actualRatio) }; }); };
  const handleTextSubmit = () => { if (textInput) { pushHistory(annotationsRef.current); if (textInput.value.trim() !== '') { if (textInput.id) setAnnotations(prev => prev.map(a => a.id === textInput.id ? { ...a, text: textInput.value.trim(), color: strokeColor, fontSize: fontSize, hasGlow: textGlow } : a)); else setAnnotations(prev => [...prev, { id: Date.now().toString(), type: 'text', x: textInput.canvasX, y: textInput.canvasY, text: textInput.value.trim(), color: strokeColor, fontSize: fontSize, scaleX: 1, scaleY: 1, rotation: 0, tx: 0, ty: 0, hasGlow: textGlow }]); } else if (textInput.id) setAnnotations(prev => prev.filter(a => a.id !== textInput.id)); } setTextInput(null); };
  const ToolButton = ({ tool, icon: Icon, label, onClick }) => { const isActive = currentTool === tool; return ( <button onClick={onClick || (() => handleToolChange(tool))} className={`p-2 rounded-lg flex flex-col items-center gap-1 transition-colors min-w-[44px] ${isActive ? 'bg-blue-100 text-blue-600' : 'hover:bg-gray-100 text-gray-600'}`}> <Icon size={22} strokeWidth={isActive ? 2.5 : 2} /> <span className="text-[9px] font-bold">{label}</span> </button> ); };
  const isSelectionMode = currentTool === ToolType.SELECT || currentTool === ToolType.LASSO; const shouldShowSelectionMenu = selectedIds.length > 0 && isSelectionMode; const boundingBoxForMenu = shouldShowSelectionMenu ? getMultiBBox(annotations, selectedIds) : null; const hasInkSelected = selectedIds.some(id => ['pen', 'handwriting_text'].includes(annotations.find(a => a.id === id)?.type)); const isSingleTextSelected = selectedIds.length === 1 && annotations.find(a => a.id === selectedIds[0])?.type === 'text'; const isGroupable = selectedIds.length > 1; const isUngroupable = selectedIds.length > 0 && selectedIds.every(id => { const ann = annotations.find(a => a.id === id); return ann?.groupId && annotations.filter(a => a.groupId === ann.groupId).every(a => selectedIds.includes(a.id)); });
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 768;

  return (
    <div className={`min-h-screen bg-gray-100 flex flex-col font-sans fixed inset-0 z-50 overflow-hidden select-none`}>
      {isAutoOcrLoading && <div className="absolute top-20 right-4 bg-white/95 border border-blue-200 text-blue-700 px-6 py-3 rounded-xl shadow-2xl z-[100] font-bold flex items-center gap-3"><Loader2 size={24} className="animate-spin" /><span>手書き文字を変換中...</span></div>}
      {errorMessage && <div className="absolute top-20 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-6 py-3 rounded-xl shadow-2xl z-[100] font-bold flex items-center gap-2"><span>{errorMessage}</span><button onClick={() => setErrorMessage('')} className="ml-4 opacity-70 hover:opacity-100 text-xl font-light">×</button></div>}
      {!isFullscreen && ( <header className="bg-white border-b px-4 py-3 flex justify-between items-center shrink-0 shadow-sm relative z-20"> <button onClick={onCancel} className="text-gray-500 p-2 hover:bg-gray-100 rounded-lg font-medium transition">キャンセル</button> <div className="font-bold text-gray-800 text-lg flex items-center gap-2"> {initialItem && <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-sm">再編集</span>} 画像の編集 </div> <button onClick={() => { setSelectedIds([]); setTimeout(handleSave, 50); }} disabled={imagesData.length === 0 && !memo} className="bg-blue-600 text-white px-5 py-2 rounded-lg font-bold hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 transition shadow-md"> <Save size={18} /> 保存 </button> </header> )}
      <div className={`flex-1 flex ${isFullscreen ? 'flex-col fixed inset-0 z-50 bg-gray-200' : 'flex-col lg:flex-row'} overflow-hidden`}>
        <div className="flex-1 flex flex-col bg-gray-200 overflow-hidden relative">
          <button onClick={() => setIsFullscreen(!isFullscreen)} className="absolute top-4 right-4 z-[60] p-3 bg-white/90 backdrop-blur rounded-full shadow-lg text-gray-700 hover:bg-white transition-transform hover:scale-110" title={isFullscreen ? "全画面解除" : "全画面表示"}> {isFullscreen ? <Minimize size={24} /> : <Maximize size={24} />} </button>
          {imagesData.length === 0 ? ( <div className="flex-1 flex flex-col items-center justify-center p-6 space-y-6"> <div className="text-center mb-4"><h2 className="text-2xl font-bold text-gray-700 mb-2">写真を追加しますか？</h2><p className="text-gray-500">Ctrl+V (Cmd+V) で直接貼り付けることも可能です</p></div> <div className="flex flex-col sm:flex-row gap-4 w-full max-w-lg"> <label className="flex-1 flex flex-col items-center justify-center bg-white p-8 rounded-2xl shadow-sm cursor-pointer hover:shadow-md hover:bg-blue-50 transition text-blue-600"><Camera size={48} className="mb-4" /> <span className="font-bold text-lg">カメラで撮影</span><input type="file" multiple accept="image/*" capture="environment" className="hidden" onChange={handleImageUpload} /></label> <label className="flex-1 flex flex-col items-center justify-center bg-white p-8 rounded-2xl shadow-sm cursor-pointer hover:shadow-md hover:bg-blue-50 transition text-blue-600"><ImageIcon size={48} className="mb-4" /> <span className="font-bold text-lg">アルバムから</span><input type="file" multiple accept="image/*" className="hidden" onChange={handleImageUpload} /></label> </div> </div> ) : ( <>
              <div className="bg-white border-b px-2 py-1.5 flex flex-wrap items-center gap-x-2 gap-y-2 shrink-0 shadow-sm z-10 relative pr-16">
                <div className="flex items-center bg-gray-50 p-1 rounded-xl">
                  <ToolButton tool={ToolType.SELECT} icon={MousePointer2} label="選択" /> <ToolButton tool={ToolType.LASSO} icon={Lasso} label="投げ輪" /> <div className="w-px h-6 bg-gray-300 mx-1"></div> <ToolButton tool={ToolType.PEN} icon={PenTool} label="ペン" /> <ToolButton tool={ToolType.HANDWRITING_TEXT} icon={PenLine} label="手書き" /> <ToolButton tool={ToolType.TEXT} icon={Type} label="文字" /> <ToolButton tool={ToolType.LINE} icon={Minus} label="直線" /> <ToolButton tool={ToolType.ARROW} icon={ArrowUpRight} label="矢印" /> <ToolButton tool={ToolType.RECT} icon={Square} label="四角" /> <ToolButton tool={ToolType.CIRCLE} icon={Circle} label="丸" /> <div className="flex flex-col relative mx-1"> <ToolButton tool={currentTool === ToolType.ERASER_PIXEL ? ToolType.ERASER_PIXEL : ToolType.ERASER_OBJ} icon={Eraser} label="消す" onClick={() => handleToolChange(currentTool === ToolType.ERASER_OBJ ? ToolType.ERASER_PIXEL : ToolType.ERASER_OBJ)} /> {(currentTool === ToolType.ERASER_PIXEL || currentTool === ToolType.ERASER_OBJ) && ( <div className="absolute top-full mt-1 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-[9px] px-1.5 py-0.5 rounded whitespace-nowrap z-50">{currentTool === ToolType.ERASER_PIXEL ? '部分' : '全体'}</div> )} </div>
                </div>
                <div className="flex-1 min-w-[8px]"></div>
                <div className="flex items-center gap-1 bg-gray-50 p-1 rounded-xl">
                  <button onClick={handleAutoCleanUp} disabled={isCleanUpLoading || isOcrLoading} className="p-2 rounded-lg flex flex-col items-center min-w-[48px] bg-gradient-to-br from-purple-100 to-blue-100 text-purple-700 hover:scale-105 active:scale-95 transition shadow-sm border border-purple-200 disabled:opacity-50"> {isCleanUpLoading ? <Loader2 size={20} className="animate-spin" /> : <Sparkles size={20} strokeWidth={2.5} />}<span className="text-[9px] font-bold mt-1">AI整頓</span> </button> <div className="w-px h-6 bg-gray-300 mx-1"></div> <div className="relative"> <button onClick={() => setActivePopover(activePopover === 'width' ? null : 'width')} className={`p-2 rounded-lg flex flex-col items-center min-w-[48px] ${activePopover === 'width' ? 'bg-blue-100 text-blue-600' : 'hover:bg-gray-200 text-gray-700'}`}> <Scaling size={20} /> <span className="text-[9px] font-bold mt-1">{(currentTool === ToolType.TEXT || currentTool === ToolType.HANDWRITING_TEXT) ? 'ｻｲｽﾞ/太さ' : '太さ'}</span> </button> {activePopover === 'width' && ( <div className="absolute top-full right-0 mt-2 bg-white p-4 rounded-xl shadow-xl border border-gray-200 z-50 w-48 flex flex-col items-center"> {currentTool === ToolType.HANDWRITING_TEXT ? ( <><span className="text-xs font-bold text-gray-500 mb-2">線の太さ: {lineWidth}px</span><input type="range" min="1" max="40" value={lineWidth} onChange={(e) => updateSettings({ lineWidth: parseInt(e.target.value) })} className="w-full accent-blue-500 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer mb-4" /><span className="text-xs font-bold text-gray-500 mb-2">変換後の文字サイズ: {fontSize}px</span><input type="range" min="16" max="120" value={fontSize} onChange={(e) => updateSettings({ fontSize: parseInt(e.target.value) })} className="w-full accent-blue-500 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer" /></> ) : currentTool === ToolType.TEXT ? ( <><span className="text-xs font-bold text-gray-500 mb-2">文字サイズ: {fontSize}px</span><input type="range" min="16" max="120" value={fontSize} onChange={(e) => updateSettings({ fontSize: parseInt(e.target.value) })} className="w-full accent-blue-500 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer" /></> ) : ( <><span className="text-xs font-bold text-gray-500 mb-2">線の太さ: {lineWidth}px</span><input type="range" min="1" max="40" value={lineWidth} onChange={(e) => updateSettings({ lineWidth: parseInt(e.target.value) })} className="w-full accent-blue-500 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer" /></> )} </div> )} </div> <div className="relative"> <button onClick={() => setActivePopover(activePopover === 'stroke' ? null : 'stroke')} className={`p-2 rounded-lg flex flex-col items-center min-w-[48px] ${activePopover === 'stroke' ? 'bg-blue-100 text-blue-600' : 'hover:bg-gray-200 text-gray-700'}`}> <div className="w-5 h-5 rounded-full border-2 border-gray-300 shadow-sm" style={{ backgroundColor: strokeColor }}></div> <span className="text-[10px] font-bold mt-1">線の色</span> </button> {activePopover === 'stroke' && ( <div className="absolute top-full right-0 mt-2 bg-white p-3 rounded-xl shadow-xl border border-gray-200 z-50 w-48 grid grid-cols-4 gap-2">{COLORS.map(c => ( <button key={`stroke-${c}`} onClick={() => { updateSettings({ strokeColor: c }); setActivePopover(null); }} className={`w-8 h-8 rounded-full border-2 mx-auto ${strokeColor === c ? 'border-blue-500 scale-110 shadow-md' : 'border-gray-200'}`} style={{ backgroundColor: c }} /> ))}</div> )} </div> <div className="relative"> <button onClick={() => setActivePopover(activePopover === 'fill' ? null : 'fill')} className={`p-2 rounded-lg flex flex-col items-center min-w-[48px] ${activePopover === 'fill' ? 'bg-blue-100 text-blue-600' : 'hover:bg-gray-200 text-gray-700'}`}> <div className="w-5 h-5 rounded-full border-2 border-gray-300 shadow-sm flex items-center justify-center bg-gray-50" style={{ backgroundColor: isFillTransparent ? 'transparent' : fillColor }}>{isFillTransparent && <Droplet size={12} className="text-gray-400" />}</div><span className="text-[10px] font-bold mt-1">塗り</span> </button> {activePopover === 'fill' && ( <div className="absolute top-full right-0 mt-2 bg-white p-3 rounded-xl shadow-xl border border-gray-200 z-50 w-48 grid grid-cols-4 gap-2"> <button onClick={() => { updateSettings({ isFillTransparent: true }); setActivePopover(null); }} className={`w-8 h-8 rounded-full border-2 mx-auto flex items-center justify-center bg-gray-50 ${isFillTransparent ? 'border-blue-500 scale-110 shadow-md text-blue-500' : 'border-gray-200 text-gray-400'}`}><Droplet size={14} /></button> {COLORS.map(c => ( <button key={`fill-${c}`} onClick={() => { updateSettings({ fillColor: c, isFillTransparent: false }); setActivePopover(null); }} className={`w-8 h-8 rounded-full border-2 mx-auto ${fillColor === c && !isFillTransparent ? 'border-blue-500 scale-110 shadow-md' : 'border-gray-200'}`} style={{ backgroundColor: c }} /> ))} </div> )} </div> <button onClick={() => updateSettings({ textGlow: !textGlow })} className={`p-2 rounded-lg flex flex-col items-center min-w-[48px] ${textGlow ? 'bg-amber-100 text-amber-600' : 'hover:bg-gray-200 text-gray-700'}`}> <Sparkles size={20} strokeWidth={textGlow ? 2.5 : 2} /> <span className="text-[10px] font-bold mt-1">光彩</span> </button> <button onClick={() => setFingerDrawMode(!fingerDrawMode)} className={`p-2 rounded-lg flex flex-col items-center min-w-[48px] ${fingerDrawMode ? 'bg-blue-100 text-blue-600 shadow-inner' : 'hover:bg-gray-200 text-gray-700'}`}> <Hand size={20} /> <span className="text-[9px] font-bold mt-1">指で描く</span> </button>
                </div>
                <div className="flex-1 min-w-[8px]"></div>
                <div className="flex items-center gap-1"> <button onClick={handlePaste} disabled={clipboard.length === 0} className="p-2 text-blue-600 hover:bg-blue-100 rounded-lg disabled:opacity-30 flex flex-col items-center min-w-[48px]" title="貼り付け (Ctrl+V)"><ClipboardPaste size={20} /><span className="text-[10px] font-bold mt-1">貼付</span></button> <div className="w-px h-6 bg-gray-300 mx-1"></div> <button onClick={() => setTransform({ scale: 1, x: 0, y: 0 })} className="p-2 text-gray-600 hover:bg-gray-200 rounded-lg flex flex-col items-center min-w-[48px]"><RefreshCw size={20} /><span className="text-[10px] font-bold mt-1">表示ﾘｾｯﾄ</span></button> <button onClick={handleUndo} disabled={history.length === 0} className="p-2 text-gray-600 hover:bg-gray-200 rounded-lg disabled:opacity-30 flex flex-col items-center min-w-[48px]" title="元に戻す (Ctrl/Cmd+Z)"><Undo size={20} /><span className="text-[10px] font-bold mt-1">戻す</span></button> <button onClick={handleRedo} disabled={redoStack.length === 0} className="p-2 text-gray-600 hover:bg-gray-200 rounded-lg disabled:opacity-30 flex flex-col items-center min-w-[48px]" title="やり直し (Ctrl/Cmd+Y)"><Redo2 size={20} /><span className="text-[10px] font-bold mt-1">進む</span></button> <button onClick={() => setIsClearConfirmOpen(true)} disabled={annotations.length === 0} className="p-2 text-red-500 hover:bg-red-50 rounded-lg disabled:opacity-30 flex flex-col items-center min-w-[48px]"><Trash2 size={20} /><span className="text-[10px] font-bold mt-1">クリア</span></button> </div>
              </div>
              {activeImageId && (
                <div ref={wrapperRef} className="flex-1 overflow-hidden relative flex items-center justify-center p-4 touch-none canvas-container" onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onPointerLeave={handlePointerUp} onWheel={handleWheel}>
                  <div className="relative flex items-center justify-center shadow-lg bg-white actual-canvas-wrapper shrink-0" style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`, transformOrigin: 'center', width: baseImage ? baseImage.width : 1200, height: baseImage ? baseImage.height : 800 }}>
                    {baseImage && <img src={baseImage.src} className="absolute inset-0 w-full h-full object-contain pointer-events-none" alt="Base" />}
                    <canvas ref={canvasRef} className={`absolute inset-0 w-full h-full ${currentTool === ToolType.SELECT || currentTool === ToolType.LASSO ? 'cursor-default' : 'cursor-crosshair'}`} />
                    {textInput && (
                      <div className="absolute z-50 transform -translate-x-1/2 -translate-y-1/2 text-overlay flex flex-col justify-center items-center pointer-events-auto" style={{ left: `${(textInput.canvasX / canvasRef.current.width) * 100}%`, top: `${(textInput.canvasY / canvasRef.current.height) * 100}%`, transform: `translate(-50%, -50%) rotate(${textInput.rotation || 0}rad) scale(${textInput.scale || 1})` }}>
                        <div className="mb-2 bg-white/95 backdrop-blur-sm px-3 py-2 rounded-xl shadow-2xl flex items-center gap-2 border border-gray-200" onPointerDown={e => e.stopPropagation()}>
                          <div className="flex gap-1"> {COLORS.slice(0, 4).map(c => <button key={`ti-${c}`} onClick={() => setStrokeColor(c)} className={`w-6 h-6 rounded-full border shadow-sm ${strokeColor === c ? 'border-blue-500 scale-110' : 'border-gray-200'}`} style={{ backgroundColor: c }} />)} </div> <div className="w-px h-5 bg-gray-300 mx-1" /> <div className="flex items-center gap-2"> <span className="text-xs font-bold text-gray-600">ｻｲｽﾞ</span> <input type="range" min="16" max="120" value={fontSize} onChange={e => setFontSize(parseInt(e.target.value))} className="w-20 accent-blue-500" /> </div> <div className="w-px h-5 bg-gray-300 mx-1" /> <button onClick={() => setTextGlow(!textGlow)} className={`p-1.5 rounded-lg flex items-center gap-1 ${textGlow ? 'bg-amber-100 text-amber-600' : 'text-gray-400 hover:bg-gray-100'}`} title="光彩"> <Sparkles size={16} strokeWidth={textGlow ? 2.5 : 2} /> <span className="text-[10px] font-bold">光彩</span> </button> <div className="w-px h-5 bg-gray-300 mx-1" /> <button onClick={handleTextSubmit} className="bg-blue-600 text-white px-4 py-1.5 rounded-lg font-bold text-sm hover:bg-blue-700 shadow-md">確定</button>
                        </div>
                        <textarea autoFocus value={textInput.value} onChange={(e) => setTextInput({...textInput, value: e.target.value})} onKeyDown={(e) => { if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTextSubmit(); } }} onPointerDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} className="p-2 font-bold border-4 border-blue-500 rounded-lg shadow-2xl focus:outline-none bg-transparent text-center resize-none overflow-hidden select-text touch-auto" style={{ color: strokeColor, textShadow: textGlow ? '0 0 10px white, 0 0 10px white, 0 0 10px white' : 'none', minWidth: '200px', width: `${Math.max(200, textInput.value.split('\n').reduce((a,b)=>a.length>b.length?a:b, '').length * fontSize * 1.2 + 40)}px`, fontSize: `${fontSize}px`, lineHeight: 1.2, height: `${Math.max(1, textInput.value.split('\n').length) * fontSize * 1.2 + 32}px` }} placeholder="文字を入力 (Shift+Enterで改行)" />
                      </div>
                    )}
                    {shouldShowSelectionMenu && boundingBoxForMenu && canvasRef.current && (
                      <div className="absolute z-50 selection-menu flex items-center gap-1 p-1.5 bg-white rounded-xl shadow-2xl border border-gray-200 pointer-events-auto" style={{ left: `${((boundingBoxForMenu.x + boundingBoxForMenu.w/2) / canvasRef.current.width) * 100}%`, top: `${((boundingBoxForMenu.y + boundingBoxForMenu.h + 20) / canvasRef.current.height) * 100}%`, transform: `translateX(-50%) scale(${1 / transform.scale})`, transformOrigin: 'top center' }} onPointerDown={(e) => e.stopPropagation()}>
                        {isSingleTextSelected && (() => { const ann = annotations.find(a => a.id === selectedIds[0]); return (<button onClick={(e) => { e.stopPropagation(); setTextInput({ id: ann.id, canvasX: ann.x + (ann.tx || 0), canvasY: ann.y + (ann.ty || 0), value: ann.text, scale: ann.scaleX || ann.scale || 1, rotation: ann.rotation || 0 }); setFontSize(ann.fontSize || 48); setStrokeColor(ann.color || '#000000'); setTextGlow(ann.hasGlow !== undefined ? ann.hasGlow : true); }} className="flex items-center gap-1.5 px-3 py-2 bg-blue-50 text-blue-600 font-bold rounded-lg hover:bg-blue-100 transition whitespace-nowrap"><PenTool size={18} /> 編集</button>); })()}
                        {hasInkSelected && ( <> <button onClick={(e) => { e.stopPropagation(); handleAutoCleanUp(); }} disabled={isCleanUpLoading || isOcrLoading} className={`flex items-center gap-1.5 px-3 py-2 ${isCleanUpLoading ? 'bg-gray-100 text-gray-400' : 'bg-purple-50 text-purple-700 hover:bg-purple-100'} font-bold rounded-lg transition whitespace-nowrap`}>{isCleanUpLoading ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}<span className="hidden sm:inline">{isCleanUpLoading ? (ocrProgress || '処理中...') : 'AI整頓'}</span></button> <button onClick={(e) => { e.stopPropagation(); runOCR(); }} disabled={isCleanUpLoading || isOcrLoading} className={`flex items-center gap-1.5 px-3 py-2 ${isOcrLoading ? 'bg-gray-100 text-gray-400' : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'} font-bold rounded-lg transition whitespace-nowrap`}>{isOcrLoading ? <Loader2 size={18} className="animate-spin" /> : <ScanText size={18} />}<span className="hidden sm:inline">{isOcrLoading ? (ocrProgress || '処理中...') : '自動文字認識'}</span></button> </> )}
                        {isGroupable && <button onClick={(e) => { e.stopPropagation(); handleGroup(); }} className="flex items-center gap-1.5 px-3 py-2 bg-emerald-50 text-emerald-700 font-bold rounded-lg hover:bg-emerald-100 transition whitespace-nowrap" title="グループ化"><Link size={18} /> <span className="hidden sm:inline">グループ</span></button>}
                        {isUngroupable && <button onClick={(e) => { e.stopPropagation(); handleUngroup(); }} className="flex items-center gap-1.5 px-3 py-2 bg-gray-50 text-gray-700 font-bold rounded-lg hover:bg-gray-200 transition whitespace-nowrap" title="グループ解除"><Unlink size={18} /> <span className="hidden sm:inline">解除</span></button>}
                        {(isSingleTextSelected || hasInkSelected || isGroupable || isUngroupable) && <div className="w-px h-6 bg-gray-200 mx-1"></div>} <button onClick={(e) => { e.stopPropagation(); handleCopySelected(); }} className="flex items-center justify-center w-10 h-10 text-gray-600 hover:bg-gray-100 rounded-lg transition" title="コピー (Ctrl+C)"><Copy size={20} /></button> <button onClick={(e) => { e.stopPropagation(); handleDeleteSelected(); }} className="flex items-center justify-center w-10 h-10 text-red-500 hover:bg-red-50 rounded-lg transition" title="削除 (Delete)"><Trash2 size={20} /></button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {imagesData.length > 0 && ( <div className="bg-white border-t px-4 py-2 flex items-center gap-3 overflow-x-auto shrink-0 z-10 shadow-[0_-2px_10px_rgba(0,0,0,0.05)]"> {imagesData.map((img) => ( <div key={img.id} onClick={() => { if (suppressThumbClickRef.current) { suppressThumbClickRef.current = false; return; } switchImage(img.id); }} onContextMenu={(e) => { e.preventDefault(); setThumbContextMenu({ img, x: e.clientX, y: e.clientY }); }} onPointerDown={(e) => { if (e.pointerType === 'touch') { if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current); longPressTimerRef.current = setTimeout(() => { suppressThumbClickRef.current = true; setThumbContextMenu({ img, x: e.clientX, y: e.clientY }); }, 550); } }} onPointerUp={() => { if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current); }} onPointerCancel={() => { if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current); }} className={`relative w-16 h-16 shrink-0 rounded-lg overflow-hidden border-2 cursor-pointer transition-all ${activeImageId === img.id ? 'border-blue-500 shadow-md ring-2 ring-blue-200' : 'border-gray-200 opacity-70 hover:opacity-100'}`}> <img src={img.baseImage.src} className="w-full h-full object-cover bg-gray-100" /> <button onClick={(e) => { e.stopPropagation(); handleDeleteImage(img.id); }} className="absolute top-0.5 right-0.5 p-1 bg-black/60 text-white rounded-full hover:bg-red-500 transition"><X size={12} /></button> </div> ))} <button onClick={() => setIsImageSourcePickerOpen(true)} className="w-16 h-16 shrink-0 rounded-lg border-2 border-dashed border-gray-300 flex flex-col items-center justify-center text-gray-500 cursor-pointer hover:bg-blue-50 hover:text-blue-600 hover:border-blue-300 transition" title="追加方法を選択"> <Plus size={20} /><span className="text-[9px] mt-0.5 font-bold">追加</span></button> </div> )}
            </>
          )}
        </div>
        {!isFullscreen && ( <div className="w-full lg:w-80 bg-white border-t lg:border-t-0 lg:border-l border-gray-200 flex flex-col shrink-0 relative z-20"> <div className="p-4 bg-gray-50 border-b font-bold text-gray-700 flex justify-between items-center"> <div className="flex items-center gap-2"><FileText size={20} /> メモ (任意)</div> <button onClick={() => setIsLayoutModalOpen(true)} className="flex items-center gap-1 text-xs bg-white border border-gray-300 px-2 py-1.5 rounded-lg hover:bg-gray-100 text-gray-600 transition shadow-sm font-medium"><LayoutTemplate size={14} /> PPTレイアウト</button> </div> <textarea value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="評価のコメントやメモを入力..." className="flex-1 p-5 text-lg text-gray-800 resize-none focus:outline-none focus:ring-inset focus:ring-2 focus:ring-blue-500 select-text"></textarea> </div> )}
      </div>
      {thumbContextMenu && ( <div className="fixed z-[66] thumb-context-menu bg-white border border-gray-200 rounded-xl shadow-2xl p-1.5 min-w-[170px]" style={{ left: Math.min(thumbContextMenu.x, viewportW - 190), top: Math.min(thumbContextMenu.y, viewportH - 120) }}> <button onClick={() => { copyThumbnailImage(thumbContextMenu.img); setThumbContextMenu(null); }} className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-100 font-medium text-gray-700">画像をコピー</button> <button onClick={() => { saveThumbnailImage(thumbContextMenu.img); setThumbContextMenu(null); }} className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-100 font-medium text-gray-700">画像を保存</button> </div> )}
      {isClearConfirmOpen && ( <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4"> <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl"> <h2 className="text-xl font-bold mb-2 text-gray-800">書き込みの消去</h2><p className="text-gray-600 mb-6">すべての書き込みを消去しますか？</p> <div className="flex justify-end gap-3"><button onClick={() => setIsClearConfirmOpen(false)} className="px-5 py-2.5 rounded-xl text-gray-600 hover:bg-gray-100 font-medium">キャンセル</button><button onClick={() => { pushHistory(annotations); setAnnotations([]); setIsClearConfirmOpen(false); }} className="px-5 py-2.5 bg-red-600 text-white rounded-xl hover:bg-red-700 font-medium">消去する</button></div> </div> </div> )}
      {isImageSourcePickerOpen && ( <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[65] p-4"> <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-2xl"> <h2 className="text-2xl font-bold text-gray-800 mb-2">画像の追加方法</h2><p className="text-gray-500 mb-5">カメラで撮影するか、アルバムから選択してください。</p><div className="flex flex-col sm:flex-row gap-4"> <button onClick={() => { setIsImageSourcePickerOpen(false); setTimeout(() => cameraInputRef.current?.click(), 0); }} className="flex-1 flex flex-col items-center justify-center bg-blue-50 p-6 rounded-2xl hover:bg-blue-100 text-blue-700 transition"><Camera size={44} className="mb-3" /><span className="font-bold text-lg">カメラで撮影</span></button> <button onClick={() => { setIsImageSourcePickerOpen(false); setTimeout(() => albumInputRef.current?.click(), 0); }} className="flex-1 flex flex-col items-center justify-center bg-indigo-50 p-6 rounded-2xl hover:bg-indigo-100 text-indigo-700 transition"><ImageIcon size={44} className="mb-3" /><span className="font-bold text-lg">アルバムから選択</span></button> </div><div className="mt-5 flex justify-end"><button onClick={() => setIsImageSourcePickerOpen(false)} className="px-5 py-2.5 rounded-xl text-gray-600 hover:bg-gray-100 font-medium">キャンセル</button></div></div></div> )}
      <input ref={cameraInputRef} type="file" multiple accept="image/*" capture="environment" className="hidden" onChange={handleImageUpload} />
      <input ref={albumInputRef} type="file" multiple accept="image/*" className="hidden" onChange={handleImageUpload} />
      {isLayoutModalOpen && ( <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-4 font-sans select-none backdrop-blur-sm"> <div className="bg-white rounded-2xl p-6 w-full max-w-3xl shadow-2xl max-h-[95vh] overflow-y-auto flex flex-col"> <div className="flex justify-between items-center mb-4"> <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2"><LayoutTemplate size={24} className="text-blue-600" /> スライド出力レイアウト設定</h2> <button onClick={() => setIsLayoutModalOpen(false)} className="p-2 text-gray-400 hover:bg-gray-100 rounded-full transition"><X size={24} /></button> </div> <div className="mb-6 flex gap-2 overflow-x-auto pb-2 shrink-0"> {[ { id: 'default', label: 'デフォルト (左メモ / 右画像)' }, { id: 'top_bottom', label: '上下分割 (上メモ / 下画像)' }, { id: 'images_only', label: '画像のみ (メモ非表示)' }, { id: 'custom', label: '完全カスタム (プレビューを操作)' } ].map(tpl => ( <button key={tpl.id} onClick={() => setLayoutSettings(prev => ({ ...prev, template: tpl.id }))} className={`px-4 py-2.5 border-2 rounded-xl text-sm font-bold whitespace-nowrap transition ${layoutSettings.template === tpl.id ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-sm' : 'border-gray-200 text-gray-600 hover:bg-gray-50 hover:border-gray-300'}`}>{tpl.label}</button> ))} </div> <div className="mb-4"> <div className="flex justify-between items-end mb-2"><h3 className="font-bold text-gray-700 text-sm">プレビュー (ドラッグ＆リサイズ可能)</h3><span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">16:9 スライド</span></div> <div ref={previewContainerRef} className="relative w-full aspect-video bg-white border-2 border-gray-300 shadow-inner overflow-hidden rounded-lg" style={{ backgroundImage: 'radial-gradient(#e5e7eb 1px, transparent 1px)', backgroundSize: '40px 40px', backgroundPosition: '0 0' }}> <div className="absolute top-1/2 left-0 w-full h-px bg-blue-500/20 pointer-events-none"></div><div className="absolute left-1/2 top-0 w-px h-full bg-blue-500/20 pointer-events-none"></div> {layoutSettings.memoRect && ( <LayoutRect rect={layoutSettings.memoRect} onChange={(r) => setLayoutSettings(p => ({...p, memoRect: r}))} onDragStart={() => setLayoutSettings(p => ({...p, template: 'custom'}))} label="📝 メモ配置エリア" isMemo={true} containerRef={previewContainerRef} /> )} {layoutSettings.customImageRects.map((rect, i) => ( <LayoutRect key={i} rect={rect} onChange={(r) => { const newArr = [...layoutSettings.customImageRects]; newArr[i] = r; setLayoutSettings(p => ({...p, customImageRects: newArr})); }} onDragStart={() => setLayoutSettings(p => ({...p, template: 'custom'}))} label={`🖼️ ${i+1}枚目の画像`} bgImg={imagesData[i]?.baseImage?.src} isMemo={false} containerRef={previewContainerRef} /> ))} </div> </div> <div className="border border-gray-200 rounded-xl overflow-hidden shrink-0"> <button onClick={() => setShowAdvancedLayout(!showAdvancedLayout)} className="w-full px-4 py-3 bg-gray-50 hover:bg-gray-100 flex justify-between items-center text-sm font-bold text-gray-700 transition">詳細な数値を手入力して微調整する {showAdvancedLayout ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button> {showAdvancedLayout && ( <div className="p-4 bg-white space-y-4"> <p className="text-xs text-gray-500 mb-2">※単位は「インチ」です（標準16:9スライド幅10.0、高さ5.625）。左上が原点(0,0)です。</p> {layoutSettings.memoRect && ( <div className="space-y-1"><h4 className="font-bold text-gray-700 text-xs flex items-center gap-1.5"><FileText size={14}/> メモ枠</h4> <div className="flex flex-wrap gap-2 items-center text-xs bg-gray-50 p-2 rounded border"> <label className="flex items-center gap-1 font-bold text-gray-600">X: <input type="number" step="0.1" value={layoutSettings.memoRect.x} onChange={e => setLayoutSettings(p => ({...p, template: 'custom', memoRect: {...p.memoRect, x: parseFloat(e.target.value)||0}}))} className="w-14 p-1 border rounded focus:ring-1 focus:ring-blue-500 outline-none" /></label> <label className="flex items-center gap-1 font-bold text-gray-600">Y: <input type="number" step="0.1" value={layoutSettings.memoRect.y} onChange={e => setLayoutSettings(p => ({...p, template: 'custom', memoRect: {...p.memoRect, y: parseFloat(e.target.value)||0}}))} className="w-14 p-1 border rounded focus:ring-1 focus:ring-blue-500 outline-none" /></label> <label className="flex items-center gap-1 font-bold text-gray-600">W: <input type="number" step="0.1" value={layoutSettings.memoRect.w} onChange={e => setLayoutSettings(p => ({...p, template: 'custom', memoRect: {...p.memoRect, w: parseFloat(e.target.value)||0}}))} className="w-14 p-1 border rounded focus:ring-1 focus:ring-blue-500 outline-none" /></label> <label className="flex items-center gap-1 font-bold text-gray-600">H: <input type="number" step="0.1" value={layoutSettings.memoRect.h} onChange={e => setLayoutSettings(p => ({...p, template: 'custom', memoRect: {...p.memoRect, h: parseFloat(e.target.value)||0}}))} className="w-14 p-1 border rounded focus:ring-1 focus:ring-blue-500 outline-none" /></label> </div> </div> )} <div className="space-y-1"><h4 className="font-bold text-gray-700 text-xs flex items-center justify-between"><span className="flex items-center gap-1.5"><ImageIcon size={14}/> 各画像枠</span><button onClick={() => setLayoutSettings(p => ({...p, template: 'custom', customImageRects: [...p.customImageRects, {x:0.5, y:1.0, w:4.0, h:3.0}]}))} className="text-blue-600 hover:text-blue-800 text-xs font-bold flex items-center gap-1"><Plus size={12}/> 枠を追加</button></h4> <div className="space-y-2 max-h-32 overflow-y-auto pr-1"> {layoutSettings.customImageRects.map((rect, idx) => ( <div key={idx} className="flex flex-wrap gap-2 items-center text-xs bg-gray-50 p-2 border rounded"> <span className="font-bold text-blue-600 w-12 text-center">{idx + 1}枚目</span> <label className="flex items-center gap-1 font-bold text-gray-600">X: <input type="number" step="0.1" value={rect.x} onChange={e => { const newArr = [...layoutSettings.customImageRects]; newArr[idx].x = parseFloat(e.target.value)||0; setLayoutSettings(p => ({...p, template: 'custom', customImageRects: newArr})); }} className="w-14 p-1 border rounded focus:ring-1 focus:ring-blue-500 outline-none" /></label> <label className="flex items-center gap-1 font-bold text-gray-600">Y: <input type="number" step="0.1" value={rect.y} onChange={e => { const newArr = [...layoutSettings.customImageRects]; newArr[idx].y = parseFloat(e.target.value)||0; setLayoutSettings(p => ({...p, template: 'custom', customImageRects: newArr})); }} className="w-14 p-1 border rounded focus:ring-1 focus:ring-blue-500 outline-none" /></label> <label className="flex items-center gap-1 font-bold text-gray-600">W: <input type="number" step="0.1" value={rect.w} onChange={e => { const newArr = [...layoutSettings.customImageRects]; newArr[idx].w = parseFloat(e.target.value)||0; setLayoutSettings(p => ({...p, template: 'custom', customImageRects: newArr})); }} className="w-14 p-1 border rounded focus:ring-1 focus:ring-blue-500 outline-none" /></label> <label className="flex items-center gap-1 font-bold text-gray-600">H: <input type="number" step="0.1" value={rect.h} onChange={e => { const newArr = [...layoutSettings.customImageRects]; newArr[idx].h = parseFloat(e.target.value)||0; setLayoutSettings(p => ({...p, template: 'custom', customImageRects: newArr})); }} className="w-14 p-1 border rounded focus:ring-1 focus:ring-blue-500 outline-none" /></label> <button onClick={() => { const newArr = layoutSettings.customImageRects.filter((_, i) => i !== idx); setLayoutSettings(p => ({...p, template: 'custom', customImageRects: newArr})); }} className="ml-auto text-red-500 hover:bg-red-100 p-1 rounded transition"><Trash2 size={14} /></button> </div> ))} </div> </div> </div> )} </div> <div className="mt-6 flex justify-end shrink-0"> <button onClick={() => setIsLayoutModalOpen(false)} className="px-8 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-bold transition shadow-lg flex items-center gap-2">設定を保存して戻る</button> </div> </div> </div> )}
    </div>
  );
}
