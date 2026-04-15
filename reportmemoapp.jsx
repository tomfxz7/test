import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  FolderOpen, Plus, Camera, Image as ImageIcon, 
  PenTool, Square, Circle, ArrowUpRight, Type, 
  Undo, Redo2, Trash2, Save, ChevronLeft, Printer,
  Droplet, FileText, Maximize, Minimize, MousePointer2, Eraser,
  Scaling, Sparkles, Minus, Lasso, ScanText, Loader2, Hand, PenLine, Settings,
  Download, Upload, Presentation, Copy, ClipboardPaste, X, RefreshCw, Link, Unlink, LayoutTemplate, ChevronDown, ChevronUp, GripVertical, Edit
} from 'lucide-react';

// --- Constants & Types ---
const ToolType = {
  SELECT: 'select', LASSO: 'lasso', PEN: 'pen', HANDWRITING_TEXT: 'handwriting_text',
  ERASER_PIXEL: 'eraser_pixel', ERASER_OBJ: 'eraser_obj', LINE: 'line', RECT: 'rect',
  CIRCLE: 'circle', ARROW: 'arrow', TEXT: 'text'
};

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#000000', '#ffffff'];
const APP_VERSION = 'v1.1.0';

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
  const finalApiKey = customKey || apiKey;
  if (!finalApiKey) throw new Error('Gemini APIキーが未設定です。ホーム画面の設定で入力してください。');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${finalApiKey}`;
  const retries = 5;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (response.ok) return await response.json();
      if (i === retries - 1) throw new Error(`API Error ${response.status}: ${await response.text()}`);
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

const drawAnnotationsOnSlide = (slide, pptx, annotations, drawX, drawY, drawW, baseW) => {
  const pRatio = drawW / baseW;
              if (item.images) return item;
              return { ...item, images: item.baseImage ? [{ id: 'img_legacy_' + item.id, image: item.image, baseImage: item.baseImage, baseWidth: item.baseWidth, baseHeight: item.baseHeight, annotations: item.annotations || [] }] : [] };
            })
          }));
        }
      } catch (e) { console.error(e); }
    }
    return [];
  });

  const [currentView, setCurrentView] = useState('home');
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [editingItem, setEditingItem] = useState(null);
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  
  const [undoHistory, setUndoHistory] = useState([]); // Project Item undo history
  const [isExportSettingsOpen, setIsExportSettingsOpen] = useState(false);
  const [pptxSettings, setPptxSettings] = useState({ showPageNumber: true });
  const [isExportingPPTX, setIsExportingPPTX] = useState(false);

  // --- Drag & Drop state ---
  const [draggedIndex, setDraggedIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const draggingFromHandleRef = useRef(false);

  useEffect(() => {
    try { localStorage.setItem('eval_report_projects', JSON.stringify(projects)); } 
    catch (e) { if (e.name === 'QuotaExceededError') alert('保存容量の上限に達しました。不要なプロジェクトや画像を削除してください。'); }
  }, [projects]);

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

  const handleSaveApiSettings = () => {
    localStorage.setItem('gemini_api_key', apiKeyInput.trim());
    alert('Gemini APIキーを保存しました。');
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
  const handleDragStart = (idx) => { setDraggedIndex(idx); draggingFromHandleRef.current = true; };
  const handleDragEnter = (targetIdx) => {
    if (draggedIndex === null || draggedIndex === targetIdx) return;
    setDragOverIndex(targetIdx);
    setProjects(prev => prev.map(p => {
      if (p.id !== activeProjectId) return p;
      const newItems = [...p.items];
      const draggedItem = newItems[draggedIndex];
      if (!draggedItem) return p;
      newItems.splice(draggedIndex, 1);
      newItems.splice(targetIdx, 0, draggedItem);
      return { ...p, items: newItems };
    }));
    setDraggedIndex(targetIdx);
  };
  const handleDragEnd = () => { setDraggedIndex(null); setDragOverIndex(null); draggingFromHandleRef.current = false; };

  useEffect(() => {
    if (draggedIndex === null) return;
    const handlePointerMove = (e) => {
      if (!draggingFromHandleRef.current) return;
      const hovered = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-item-index]');
      if (!hovered) return;
      const idx = Number(hovered.getAttribute('data-item-index'));
      if (!Number.isNaN(idx)) handleDragEnter(idx);
    };
    const resetDrag = () => handleDragEnd();
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', resetDrag);
    window.addEventListener('pointercancel', resetDrag);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', resetDrag);
      window.removeEventListener('pointercancel', resetDrag);
    };
  }, [draggedIndex]);

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

  if (currentView === 'home') {
    return (
      <div className="min-h-screen bg-gray-50 p-6 md:p-10 font-sans select-none">
        <header className="mb-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div><h1 className="text-3xl font-bold text-gray-900">評価レポート</h1><p className="text-gray-500 mt-1">プロジェクトを選択するか、新しく作成してください</p></div>
          <div className="flex items-center gap-3">
            <button onClick={() => { setIsProjectModalOpen(true); setNewProjectTitle(''); }} className="flex items-center gap-2 bg-blue-600 text-white px-5 py-3 rounded-xl hover:bg-blue-700 shadow-md transition">
              <Plus size={24} /> <span className="font-semibold text-lg hidden sm:inline">新規プロジェクト</span>
            </button>
          </div>
        </header>
        <section className="mb-6 bg-white border border-gray-200 rounded-2xl p-4 md:p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2"><Settings size={18} /> Gemini設定</h2>
            <span className="text-xs font-semibold text-gray-500 bg-gray-100 px-2 py-1 rounded-full">App {APP_VERSION}</span>
          </div>
          <div className="flex flex-col md:flex-row gap-3 md:items-end">
            <label className="flex-1">
              <span className="text-xs font-bold text-gray-600">Gemini APIキー（OCR/図形認識で使用）</span>
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="AIza..."
                className="mt-1 w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 select-text"
              />
            </label>
            <button onClick={handleSaveApiSettings} className="px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-bold">設定を保存</button>
          </div>
        </section>
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
              return (
                <div 
                  key={item.id} 
                  data-item-index={index}
                  onPointerDown={(e) => {
                    // グリップ（GripVertical）もしくはヘッダー部分を掴んだときだけドラッグ開始
                    if (e.target.closest('.drag-handle')) {
                       handleDragStart(index);
                    }
                  }}
                  onPointerUp={handleDragEnd}
                  className={`bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden print:border-gray-300 print:shadow-none break-inside-avoid relative transition-all duration-300 ease-out group ${isDragging ? 'opacity-40 scale-[0.98] z-0 grayscale' : 'z-10'}`}
                >
                  <div className="bg-gray-50 px-4 py-2 border-b text-gray-500 font-medium flex justify-between items-center select-none drag-handle cursor-grab active:cursor-grabbing touch-none">
                    <div className="flex items-center gap-3">
                      <GripVertical size={20} className="text-gray-400" />
                      <span className="font-bold text-gray-700">No. {index + 1}</span>
                    </div>
                    <div className="flex items-center gap-2 print:hidden pointer-events-auto">
                      <button 
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
                  <div className="pointer-events-none">
                    {images.length > 0 && (
                      <div className={`w-full grid gap-1 bg-gray-100 border-b p-2 ${images.length === 1 ? 'grid-cols-1' : images.length === 2 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'}`}>
                        {images.map(img => (
                          <div key={img.id} className="bg-white flex justify-center items-center p-1 rounded shadow-sm relative">
                            <img src={img.image || img.baseImage} alt="Report Item" className="w-full h-auto max-h-[30vh] object-contain" />
                          </div>
                        ))}
                      </div>
                    )}
                    {item.memo && <div className="p-6 text-gray-800 whitespace-pre-wrap text-base leading-relaxed line-clamp-3">{item.memo}</div>}
                  </div>
                </div>
              );
            })}
            {project.items.length === 0 && (
              <div className="text-center py-20 text-gray-400 print:hidden">
                <FileText size={64} className="mx-auto mb-4 opacity-50" />
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
  const [memo, setMemo] = useState(initialItem ? initialItem.memo : '');
  const [imagesData, setImagesData] = useState([]);
  const [activeImageId, setActiveImageId] = useState(null);
  const [layoutSettings, setLayoutSettings] = useState(initialItem?.layout || { template: 'default', memoRect: { x: 0.5, y: 1.2, w: 3.5, h: 4.0 }, customImageRects: [] });
  const [isLayoutModalOpen, setIsLayoutModalOpen] = useState(false);
  const [showAdvancedLayout, setShowAdvancedLayout] = useState(false);
  const previewContainerRef = useRef(null);
  const [baseImage, setBaseImage] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [history, setHistory] = useState([]);
  const [redoHistory, setRedoHistory] = useState([]);
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

  useEffect(() => {
    if (initialItem && initialItem.images) {
      const loadImages = async () => {
        const loadedImages = await Promise.all(initialItem.images.map(async (img) => {
          return new Promise((resolve) => {
            const imageElement = new Image();
            imageElement.onload = () => { resolve({ id: img.id, baseImage: { src: img.baseImage, element: imageElement, width: img.baseWidth, height: img.baseHeight }, annotations: img.annotations || [], history: img.history || [], redoHistory: img.redoHistory || [] }); };
            imageElement.src = img.baseImage;
          });
        }));
        setImagesData(loadedImages);
        if (loadedImages.length > 0) { setBaseImage(loadedImages[0].baseImage); setAnnotations(loadedImages[0].annotations); setActiveImageId(loadedImages[0].id); }
      };
      loadImages();
    }
  }, [initialItem]);

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
      if (!isInitial && activeImageId) nextData = nextData.map(img => img.id === activeImageId ? { ...img, annotations: annotationsRef.current, history: history, redoHistory: redoHistory, finalImage: currentFinal } : img );
      const nextImg = nextData.find(img => img.id === newId);
      if (nextImg) { setTimeout(() => { setBaseImage(nextImg.baseImage); setAnnotations(nextImg.annotations || []); setHistory(nextImg.history || []); setRedoHistory(nextImg.redoHistory || []); setActiveImageId(newId); setSelectedIds([]); setTransform({ scale: 1, x: 0, y: 0 }); }, 0); }
      return nextData;
    });
  };

  const handleDeleteImage = (imgId) => { if (confirm('この画像を削除しますか？')) { setImagesData(prev => { const next = prev.filter(img => img.id !== imgId); if (activeImageId === imgId) { if (next.length > 0) setTimeout(() => switchImage(next[0].id, true), 0); else { setActiveImageId(null); setBaseImage(null); setAnnotations([]); setHistory([]); setRedoHistory([]); } } return next; }); } };
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
         setImagesData(prev => { const next = [...prev, newImgData]; if (next.length === 1 && !activeImageId) { setTimeout(() => { setBaseImage(newImgData.baseImage); setAnnotations([]); setHistory([]); setRedoHistory([]); setActiveImageId(newImgData.id); setSelectedIds([]); setTransform({ scale: 1, x: 0, y: 0 }); }, 0); } return next; });
       };
