import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Text,
  Dimensions,
  PanResponder,
  Image,
  Alert,
} from 'react-native';
import Svg, { Path, Circle, Rect, Line, G } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { Annotation } from '../types';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

type DrawTool = 'pen' | 'eraser_pixel' | 'line' | 'rect' | 'circle' | 'arrow' | 'text';

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#000000', '#ffffff'];

interface Props {
  imageUri: string;
  imageWidth: number;
  imageHeight: number;
  annotations: Annotation[];
  onAnnotationsChange: (annotations: Annotation[]) => void;
  onClose: () => void;
}

export default function DrawingCanvas({
  imageUri,
  imageWidth,
  imageHeight,
  annotations,
  onAnnotationsChange,
  onClose,
}: Props) {
  const [currentTool, setCurrentTool] = useState<DrawTool>('pen');
  const [strokeColor, setStrokeColor] = useState('#ef4444');
  const [lineWidth, setLineWidth] = useState(4);
  const [currentPath, setCurrentPath] = useState<{ x: number; y: number }[]>([]);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [endPoint, setEndPoint] = useState<{ x: number; y: number } | null>(null);
  const [history, setHistory] = useState<Annotation[][]>([annotations]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [localAnnotations, setLocalAnnotations] = useState<Annotation[]>(annotations);
  const isDrawingRef = useRef(false);
  const canvasRef = useRef<View>(null);
  const [canvasLayout, setCanvasLayout] = useState({ x: 0, y: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT * 0.6 });

  // キャンバスのスケール計算
  const scale = Math.min(
    canvasLayout.width / imageWidth,
    canvasLayout.height / imageHeight
  );
  const displayWidth = imageWidth * scale;
  const displayHeight = imageHeight * scale;
  const offsetX = (canvasLayout.width - displayWidth) / 2;
  const offsetY = (canvasLayout.height - displayHeight) / 2;

  const toImageCoords = useCallback(
    (screenX: number, screenY: number) => {
      return {
        x: (screenX - offsetX) / scale,
        y: (screenY - offsetY) / scale,
      };
    },
    [offsetX, offsetY, scale]
  );

  const pushHistory = useCallback(
    (newAnnotations: Annotation[]) => {
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(newAnnotations);
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
      setLocalAnnotations(newAnnotations);
      onAnnotationsChange(newAnnotations);
    },
    [history, historyIndex, onAnnotationsChange]
  );

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setLocalAnnotations(history[newIndex]);
      onAnnotationsChange(history[newIndex]);
    }
  }, [history, historyIndex, onAnnotationsChange]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      setLocalAnnotations(history[newIndex]);
      onAnnotationsChange(history[newIndex]);
    }
  }, [history, historyIndex, onAnnotationsChange]);

  const clearAll = useCallback(() => {
    Alert.alert('全消去', 'すべての描画を消去しますか？', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '消去',
        style: 'destructive',
        onPress: () => pushHistory([]),
      },
    ]);
  }, [pushHistory]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        isDrawingRef.current = true;
        const imgCoords = toImageCoords(locationX, locationY);
        if (currentTool === 'pen' || currentTool === 'eraser_pixel') {
          setCurrentPath([imgCoords]);
        } else {
          setStartPoint(imgCoords);
          setEndPoint(imgCoords);
        }
      },
      onPanResponderMove: (evt) => {
        if (!isDrawingRef.current) return;
        const { locationX, locationY } = evt.nativeEvent;
        const imgCoords = toImageCoords(locationX, locationY);
        if (currentTool === 'pen' || currentTool === 'eraser_pixel') {
          setCurrentPath((prev) => [...prev, imgCoords]);
        } else {
          setEndPoint(imgCoords);
        }
      },
      onPanResponderRelease: (evt) => {
        if (!isDrawingRef.current) return;
        isDrawingRef.current = false;
        const { locationX, locationY } = evt.nativeEvent;
        const imgCoords = toImageCoords(locationX, locationY);

        const newAnnotation: Annotation = {
          id: Date.now().toString() + Math.random().toString(36).slice(2, 5),
          type: currentTool,
          color: strokeColor,
          width: lineWidth,
        };

        if (currentTool === 'pen' || currentTool === 'eraser_pixel') {
          const finalPath = [...currentPath, imgCoords];
          if (finalPath.length < 2) {
            setCurrentPath([]);
            return;
          }
          newAnnotation.points = finalPath;
        } else {
          if (!startPoint) return;
          newAnnotation.startX = startPoint.x;
          newAnnotation.startY = startPoint.y;
          newAnnotation.endX = imgCoords.x;
          newAnnotation.endY = imgCoords.y;
        }

        const newAnnotations = [...localAnnotations, newAnnotation];
        pushHistory(newAnnotations);
        setCurrentPath([]);
        setStartPoint(null);
        setEndPoint(null);
      },
    })
  ).current;

  // SVGパスを生成
  const buildPathD = (points: { x: number; y: number }[]) => {
    if (points.length < 2) return '';
    let d = `M ${points[0].x * scale + offsetX} ${points[0].y * scale + offsetY}`;
    for (let i = 1; i < points.length; i++) {
      d += ` L ${points[i].x * scale + offsetX} ${points[i].y * scale + offsetY}`;
    }
    return d;
  };

  const renderAnnotation = (ann: Annotation, key: string) => {
    const sx = ann.startX !== undefined ? ann.startX * scale + offsetX : 0;
    const sy = ann.startY !== undefined ? ann.startY * scale + offsetY : 0;
    const ex = ann.endX !== undefined ? ann.endX * scale + offsetX : 0;
    const ey = ann.endY !== undefined ? ann.endY * scale + offsetY : 0;
    const color = ann.color || '#000';
    const sw = (ann.width || 4) * Math.max(scale, 0.5);

    switch (ann.type) {
      case 'pen':
      case 'handwriting_text':
        return ann.points && ann.points.length >= 2 ? (
          <Path
            key={key}
            d={buildPathD(ann.points)}
            stroke={color}
            strokeWidth={sw}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null;
      case 'eraser_pixel':
        return ann.points && ann.points.length >= 2 ? (
          <Path
            key={key}
            d={buildPathD(ann.points)}
            stroke="#ffffff"
            strokeWidth={sw * 3}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null;
      case 'line':
        return (
          <Line
            key={key}
            x1={sx}
            y1={sy}
            x2={ex}
            y2={ey}
            stroke={color}
            strokeWidth={sw}
            strokeLinecap="round"
          />
        );
      case 'rect':
        return (
          <Rect
            key={key}
            x={Math.min(sx, ex)}
            y={Math.min(sy, ey)}
            width={Math.abs(ex - sx)}
            height={Math.abs(ey - sy)}
            stroke={color}
            strokeWidth={sw}
            fill="none"
          />
        );
      case 'circle':
        const cx = (sx + ex) / 2;
        const cy = (sy + ey) / 2;
        const rx = Math.abs(ex - sx) / 2;
        const ry = Math.abs(ey - sy) / 2;
        return (
          <Path
            key={key}
            d={`M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy}`}
            stroke={color}
            strokeWidth={sw}
            fill="none"
          />
        );
      case 'arrow': {
        const hl = Math.max(15, (ann.width || 4) * 3) * scale;
        const ang = Math.atan2(ey - sy, ex - sx);
        const d = `M ${sx} ${sy} L ${ex} ${ey} M ${ex} ${ey} L ${ex - hl * Math.cos(ang - Math.PI / 6)} ${ey - hl * Math.sin(ang - Math.PI / 6)} M ${ex} ${ey} L ${ex - hl * Math.cos(ang + Math.PI / 6)} ${ey - hl * Math.sin(ang + Math.PI / 6)}`;
        return (
          <Path key={key} d={d} stroke={color} strokeWidth={sw} fill="none" strokeLinecap="round" />
        );
      }
      default:
        return null;
    }
  };

  // プレビュー描画（描画中）
  const renderCurrentPreview = () => {
    if (currentTool === 'pen' || currentTool === 'eraser_pixel') {
      if (currentPath.length < 2) return null;
      return (
        <Path
          d={buildPathD(currentPath)}
          stroke={currentTool === 'eraser_pixel' ? '#ffffff' : strokeColor}
          strokeWidth={(lineWidth * (currentTool === 'eraser_pixel' ? 3 : 1)) * Math.max(scale, 0.5)}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.8}
        />
      );
    }
    if (!startPoint || !endPoint) return null;
    const tempAnn: Annotation = {
      id: 'preview',
      type: currentTool,
      color: strokeColor,
      width: lineWidth,
      startX: startPoint.x,
      startY: startPoint.y,
      endX: endPoint.x,
      endY: endPoint.y,
    };
    return renderAnnotation(tempAnn, 'preview');
  };

  return (
    <View style={styles.container}>
      {/* Toolbar */}
      <View style={styles.toolbar}>
        {/* Tools */}
        <View style={styles.toolGroup}>
          {(['pen', 'eraser_pixel', 'line', 'rect', 'circle', 'arrow'] as DrawTool[]).map((tool) => (
            <TouchableOpacity
              key={tool}
              style={[styles.toolBtn, currentTool === tool && styles.toolBtnActive]}
              onPress={() => setCurrentTool(tool)}
            >
              <Ionicons
                name={
                  tool === 'pen' ? 'pencil' :
                  tool === 'eraser_pixel' ? 'remove-circle-outline' :
                  tool === 'line' ? 'remove-outline' :
                  tool === 'rect' ? 'square-outline' :
                  tool === 'circle' ? 'ellipse-outline' :
                  'arrow-forward-outline'
                }
                size={20}
                color={currentTool === tool ? '#fff' : '#374151'}
              />
            </TouchableOpacity>
          ))}
        </View>

        {/* Actions */}
        <View style={styles.toolGroup}>
          <TouchableOpacity
            style={[styles.toolBtn, historyIndex <= 0 && styles.toolBtnDisabled]}
            onPress={undo}
            disabled={historyIndex <= 0}
          >
            <Ionicons name="arrow-undo-outline" size={20} color={historyIndex <= 0 ? '#d1d5db' : '#374151'} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toolBtn, historyIndex >= history.length - 1 && styles.toolBtnDisabled]}
            onPress={redo}
            disabled={historyIndex >= history.length - 1}
          >
            <Ionicons name="arrow-redo-outline" size={20} color={historyIndex >= history.length - 1 ? '#d1d5db' : '#374151'} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.toolBtn} onPress={clearAll}>
            <Ionicons name="trash-outline" size={20} color="#ef4444" />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.toolBtn, styles.closeBtn]} onPress={onClose}>
            <Ionicons name="checkmark" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Color Palette */}
      <View style={styles.colorPalette}>
        {COLORS.map((color) => (
          <TouchableOpacity
            key={color}
            style={[
              styles.colorDot,
              { backgroundColor: color },
              color === strokeColor && styles.colorDotActive,
              color === '#ffffff' && styles.colorDotWhite,
            ]}
            onPress={() => setStrokeColor(color)}
          />
        ))}
        {/* Line width */}
        <View style={styles.lineWidthGroup}>
          {[2, 4, 8, 16].map((w) => (
            <TouchableOpacity
              key={w}
              style={[styles.lineWidthBtn, lineWidth === w && styles.lineWidthBtnActive]}
              onPress={() => setLineWidth(w)}
            >
              <View
                style={[
                  styles.lineWidthPreview,
                  { height: Math.min(w, 8), backgroundColor: lineWidth === w ? '#fff' : '#374151' },
                ]}
              />
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Canvas */}
      <View
        ref={canvasRef}
        style={styles.canvas}
        onLayout={(e) => {
          setCanvasLayout({
            x: e.nativeEvent.layout.x,
            y: e.nativeEvent.layout.y,
            width: e.nativeEvent.layout.width,
            height: e.nativeEvent.layout.height,
          });
        }}
        {...panResponder.panHandlers}
      >
        <Image
          source={{ uri: imageUri }}
          style={[
            styles.baseImage,
            {
              width: displayWidth,
              height: displayHeight,
              left: offsetX,
              top: offsetY,
            },
          ]}
          resizeMode="contain"
        />
        <Svg
          style={StyleSheet.absoluteFill}
          width={canvasLayout.width}
          height={canvasLayout.height}
        >
          {localAnnotations.map((ann, i) => renderAnnotation(ann, `ann_${i}`))}
          {renderCurrentPreview()}
        </Svg>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },

  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#f8fafc',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  toolGroup: { flexDirection: 'row', gap: 4 },
  toolBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#f3f4f6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  toolBtnActive: { backgroundColor: '#2563eb' },
  toolBtnDisabled: { opacity: 0.4 },
  closeBtn: { backgroundColor: '#22c55e' },

  colorPalette: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    flexWrap: 'wrap',
  },
  colorDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  colorDotActive: { borderColor: '#2563eb', borderWidth: 2.5 },
  colorDotWhite: { borderColor: '#d1d5db' },

  lineWidthGroup: { flexDirection: 'row', gap: 4, marginLeft: 8 },
  lineWidthBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#f3f4f6',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  lineWidthBtnActive: { backgroundColor: '#2563eb' },
  lineWidthPreview: { width: '100%', borderRadius: 2 },

  canvas: { flex: 1, position: 'relative' },
  baseImage: { position: 'absolute' },
});
