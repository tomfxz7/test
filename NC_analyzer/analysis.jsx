import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Download, Settings2, BarChart3, AlertCircle, CheckCircle2, Info, Activity, Copy, Play, Square, Trash2, Save, FolderOpen, Plus, ArrowUp, ArrowDown, GripVertical, Search, List, AudioLines } from 'lucide-react';

// --- ユーティリティ: FFT実装 ---
function fft(re, im) {
    const N = re.length;
    for (let i = 0; i < N; i++) im[i] = 0;
    let j = 0;
    for (let i = 0; i < N - 1; i++) {
        if (i < j) {
            let tr = re[j], ti = im[j];
            re[j] = re[i]; im[j] = im[i];
            re[i] = tr; im[i] = ti;
        }
        let k = N / 2;
        while (k <= j) { j -= k; k /= 2; }
        j += k;
    }
    for (let l = 1; l < N; l *= 2) {
        let wr = Math.cos(Math.PI / l);
        let wi = -Math.sin(Math.PI / l);
        for (let i = 0; i < N; i += 2 * l) {
            let xr = 1, xi = 0;
            for (let j = 0; j < l; j++) {
                let tr = xr * re[i + j + l] - xi * im[i + j + l];
                let ti = xr * im[i + j + l] + xi * re[i + j + l];
                re[i + j + l] = re[i + j] - tr;
                im[i + j + l] = im[i + j] - ti;
                re[i + j] += tr;
                im[i + j] += ti;
                let txr = xr * wr - xi * wi;
                xi = xr * wi + xi * wr;
                xr = txr;
            }
        }
    }
}

// --- ユーティリティ: NC規格表の自動生成 ---
// 画像データから抽出した代表値(5刻み)
const ncBase = [
    { nc: 15, values: [47, 36, 29, 22, 17, 14, 12, 11] },
    { nc: 20, values: [51, 40, 33, 26, 22, 19, 17, 16] },
    { nc: 25, values: [54, 44, 37, 31, 27, 24, 22, 21] },
    { nc: 30, values: [57, 48, 41, 35, 31, 29, 28, 27] },
    { nc: 35, values: [60, 52, 45, 40, 36, 34, 33, 32] },
    { nc: 40, values: [64, 56, 50, 45, 41, 39, 38, 37] },
    { nc: 45, values: [67, 60, 54, 49, 46, 44, 43, 42] },
    { nc: 50, values: [71, 64, 58, 54, 51, 49, 48, 47] },
    { nc: 55, values: [74, 67, 62, 58, 56, 54, 53, 52] },
    { nc: 60, values: [77, 71, 67, 63, 61, 59, 58, 57] },
    { nc: 65, values: [80, 75, 71, 68, 66, 64, 63, 62] },
    { nc: 70, values: [83, 79, 75, 72, 71, 70, 69, 68] }
];

// 代表値間を線形補間してNC15〜70の全表を構築
const NCTable = (() => {
    const table = {};
    for (let i = 0; i < ncBase.length - 1; i++) {
        const start = ncBase[i];
        const end = ncBase[i + 1];
        table[start.nc] = start.values;
        for (let step = 1; step < 5; step++) {
            const currentNC = start.nc + step;
            table[currentNC] = start.values.map((val, idx) => {
                const diff = end.values[idx] - val;
                return Number((val + (diff / 5) * step).toFixed(1));
            });
        }
    }
    table[70] = ncBase[ncBase.length - 1].values;
    return table;
})();

const FREQUENCIES = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

// --- ユーティリティ: 音声処理 ---
let audioCtx = null;
const getAudioContext = () => {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
};

const decodeFile = async (file) => {
    const ctx = getAudioContext();
    const arrayBuffer = await file.arrayBuffer();
    return await ctx.decodeAudioData(arrayBuffer);
};

// 選択境界を一度だけサンプル位置へ変換し、解析とWAV出力で同じ音声を共有する。
const createSelectedBuffer = (source, startTime, endTime) => {
    const startSample = Math.max(0, Math.min(source.length, Math.floor(startTime * source.sampleRate)));
    const endSample = Math.max(startSample, Math.min(source.length, Math.ceil(endTime * source.sampleRate)));
    const frameCount = endSample - startSample;
    if (frameCount <= 0) throw new Error('解析する選択範囲がありません。');

    const selected = getAudioContext().createBuffer(source.numberOfChannels, frameCount, source.sampleRate);
    for (let channel = 0; channel < source.numberOfChannels; channel++) {
        selected.copyToChannel(source.getChannelData(channel).subarray(startSample, endSample), channel);
    }
    return selected;
};

// 校正音のRMSはファイルごとに保持し、基準レベルの変更では再復号しない。
const calibrationLevels = new WeakMap();
const calculateCalibrationOffset = async (file, refLevel) => {
    if (!calibrationLevels.has(file)) {
        calibrationLevels.set(file, (async () => {
            const buffer = await decodeFile(file);
            const data = buffer.getChannelData(0);
            let sumSquares = 0;
            for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i];
            return 10 * Math.log10(sumSquares / data.length || 1e-10);
        })());
    }
    return refLevel - await calibrationLevels.get(file);
};

// 分析: FFTを用いた1/1オクターブバンド分析
const analyzeAudio = async (buffer, offset, shouldCancel = () => false) => {
    // 従来版と同じく第1チャンネルだけを解析する。buffer自体は選択範囲のみ。
    const data = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;

    const N = 8192;
    const overlap = N / 2;
    const bands = FREQUENCIES.map(fc => ({
        fc, fl: fc / Math.SQRT2, fu: fc * Math.SQRT2
    }));

    // ハニング窓
    const windowFunc = new Float32Array(N);
    let windowPower = 0;
    for (let i = 0; i < N; i++) {
        windowFunc[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
        windowPower += windowFunc[i] * windowFunc[i];
    }
    windowPower /= N;

    let frameCount = 0;
    const totalPower = new Float32Array(N / 2 + 1);

    // 従来版と同じく完全な8192サンプルのフレームだけを解析する。
    // ただし選択範囲そのものが8192未満の場合に限り、解析可能にするため1フレームへゼロ詰めする。
    const lastFrameStart = data.length < N ? 0 : data.length - N;
    for (let p = 0; p <= lastFrameStart; p += overlap) {
        // 長いWAVでも入力を受け付け、変更前の計算を途中で中止できるようにする。
        if (frameCount % 8 === 0) {
            await new Promise(resolve => window.setTimeout(resolve, 0));
            if (shouldCancel()) throw new DOMException('解析条件が更新されました。', 'AbortError');
        }
        const re = new Float32Array(N);
        const im = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            re[i] = (data[p + i] || 0) * windowFunc[i];
        }

        fft(re, im);

        // パワースペクトルの計算 (片側)
        totalPower[0] += (re[0] * re[0] + im[0] * im[0]) / (N * N);
        for (let i = 1; i < N / 2; i++) {
            totalPower[i] += 2 * (re[i] * re[i] + im[i] * im[i]) / (N * N);
        }
        totalPower[N / 2] += (re[N / 2] * re[N / 2] + im[N / 2] * im[N / 2]) / (N * N);
        frameCount++;
        if (p + N >= data.length) break;
    }

    // 平均化と窓関数の補正
    for (let i = 0; i <= N / 2; i++) {
        totalPower[i] = (totalPower[i] / Math.max(1, frameCount)) / windowPower;
    }

    const df = sampleRate / N;
    return bands.map(band => {
        let pSum = 0;
        for (let i = 0; i <= N / 2; i++) {
            const f = i * df;
            if (f >= band.fl && f < band.fu) pSum += totalPower[i];
        }
        const db = 10 * Math.log10(pSum || 1e-10) + offset;
        return Number(db.toFixed(1));
    });
};

const formatTime = (seconds) => {
    const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const totalMillis = Math.round(value * 1000);
    const minutes = Math.floor(totalMillis / 60000);
    const secs = Math.floor(totalMillis / 1000) % 60;
    const millis = totalMillis % 1000;
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
};

const createTrimmedWav = (buffer, startTime, endTime, gain = 1) => {
    const start = Math.max(0, Math.floor(startTime * buffer.sampleRate));
    const end = Math.min(buffer.length, Math.ceil(endTime * buffer.sampleRate));
    const frames = end - start;
    if (frames <= 0) throw new Error('切り抜き範囲が空です。');
    const channels = buffer.numberOfChannels;
    const dataBytes = frames * channels * 2;
    const output = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(output);
    const ascii = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, dataBytes, true);
    let offset = 44;
    for (let i = start; i < end; i++) {
        for (let channel = 0; channel < channels; channel++) {
            const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i] * gain));
            view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
            offset += 2;
        }
    }
    return new Blob([output], { type: 'audio/wav' });
};

const sanitizeFileName = (name, fallback = 'untitled') => {
    const sanitized = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '');
    return sanitized || fallback;
};

const getOutputBaseName = (sourceFileName, clipName, useClipNameOnly = false) => {
    const sourceBase = sanitizeFileName(sourceFileName.replace(/\.wav$/i, ''), 'audio');
    const safeClipName = sanitizeFileName(clipName, 'trimmed');
    return useClipNameOnly ? safeClipName : `${sourceBase}_${safeClipName}`;
};

// 同名ファイルをZIP内で上書きしないよう、連番付きの一意なパスを返す。
const createUniquePath = (desiredPath, usedPaths) => {
    if (!usedPaths.has(desiredPath)) {
        usedPaths.add(desiredPath);
        return desiredPath;
    }
    const dotIndex = desiredPath.lastIndexOf('.');
    const base = dotIndex > desiredPath.lastIndexOf('/') ? desiredPath.slice(0, dotIndex) : desiredPath;
    const extension = dotIndex > desiredPath.lastIndexOf('/') ? desiredPath.slice(dotIndex) : '';
    let index = 2;
    let candidate;
    do candidate = `${base}_${index++}${extension}`; while (usedPaths.has(candidate));
    usedPaths.add(candidate);
    return candidate;
};

// 外部ライブラリに依存せず、無圧縮の標準ZIPを生成・読み込みする。
// .ncaと一括出力はWAVが中心なので、再圧縮しない方が処理も軽い。
const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let value = n;
        for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        table[n] = value >>> 0;
    }
    return table;
})();

const calculateCrc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
};

const toBytes = async (data) => {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    throw new Error('ZIPに保存できないデータ形式です。');
};

const createZipBlob = async (entries) => {
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    const encoder = new TextEncoder();
    for (const entry of entries) {
        const name = encoder.encode(entry.name);
        const data = await toBytes(entry.data);
        const crc = calculateCrc32(data);
        const local = new Uint8Array(30 + name.length);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, 0x0800, true);
        localView.setUint32(14, crc, true);
        localView.setUint32(18, data.length, true);
        localView.setUint32(22, data.length, true);
        localView.setUint16(26, name.length, true);
        local.set(name, 30);
        localParts.push(local, data);

        const central = new Uint8Array(46 + name.length);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, 0x0800, true);
        centralView.setUint32(16, crc, true);
        centralView.setUint32(20, data.length, true);
        centralView.setUint32(24, data.length, true);
        centralView.setUint16(28, name.length, true);
        centralView.setUint32(42, localOffset, true);
        central.set(name, 46);
        centralParts.push(central);
        localOffset += local.length + data.length;
    }
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, localOffset, true);
    return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
};

const readZipEntries = async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer);
    let endOffset = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
        if (view.getUint32(offset, true) === 0x06054b50) { endOffset = offset; break; }
    }
    if (endOffset < 0) throw new Error('有効なZIP形式のNCAファイルではありません。');
    const count = view.getUint16(endOffset + 10, true);
    let offset = view.getUint32(endOffset + 16, true);
    const decoder = new TextDecoder();
    const entries = new Map();
    for (let index = 0; index < count; index++) {
        if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIPのファイル一覧が破損しています。');
        const method = view.getUint16(offset + 10, true);
        const compressedSize = view.getUint32(offset + 20, true);
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const localHeaderOffset = view.getUint32(offset + 42, true);
        const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
        if (method !== 0 && method !== 8) throw new Error(`未対応のZIP圧縮方式です: ${name}`);
        if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) throw new Error('ZIPのファイル情報が破損しています。');
        const localNameLength = view.getUint16(localHeaderOffset + 26, true);
        const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
        const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
        let data = bytes.slice(dataOffset, dataOffset + compressedSize);
        if (method === 8) {
            if (typeof DecompressionStream === 'undefined') throw new Error(`このブラウザーでは圧縮されたNCAを展開できません: ${name}`);
            const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            data = new Uint8Array(await new Response(stream).arrayBuffer());
        }
        entries.set(name, data);
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
};

const downloadBlob = (blob, fileName) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const evaluateNC = (measuredLevels) => {
    let maxNC = 14;
    const details = [];

    for (let i = 0; i < 8; i++) {
        const level = measuredLevels[i];
        let bandNC = 14;
        for (let nc = 15; nc <= 70; nc++) {
            if (level <= NCTable[nc][i]) {
                bandNC = nc;
                break;
            }
            if (nc === 70 && level > NCTable[70][i]) {
                bandNC = 71;
            }
        }
        details.push(bandNC);
        if (bandNC > maxNC) maxNC = bandNC;
    }
    return { overall: maxNC, details };
};

const formatNC = (val) => {
    if (val < 15) return '< 15';
    if (val > 70) return '> 70';
    return val.toString();
};

// index.html のCSV読み込み形式（Mode/Lpeq行）に変換する
const createLpeqCsv = (levels) => {
    const frequencyLabels = FREQUENCIES.map(f => f >= 1000 ? `${f / 1000}k` : f);
    return [
        ['Mode', ...frequencyLabels].join(','),
        ['Lpeq', ...levels.map(level => level.toFixed(1))].join(',')
    ].join('\r\n');
};

const getCsvFileName = (wavFileName, clipName = '', useClipNameOnly = false) =>
    `${getOutputBaseName(wavFileName, clipName, useClipNameOnly)}.csv`;

const downloadResultCsv = (result) => {
    // BOMを付けて、表計算ソフトで開いた場合にもUTF-8として認識させる
    const blob = new Blob([`\uFEFF${createLpeqCsv(result.levels)}`], {
        type: 'text/csv;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = getCsvFileName(result.sourceFileName, result.clipName, result.useClipNameOnly);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

// --- SVGグラフコンポーネント ---
const SERIES_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#475569'];
const newId = () => window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const clampSetting = (value, min, max, fallback) => Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Number(value))) : fallback;

const ResultChart = ({ items, title, visibleNcCurves, lineWidth, pointSize, yAxisMax }) => {
    const width = 600, height = 340;
    const margin = { top: 25, right: 35, bottom: 50, left: 55 };
    const chartW = width - margin.left - margin.right;
    const chartH = height - margin.top - margin.bottom;
    const maximum = yAxisMax || Math.max(60, Math.ceil(Math.max(
        ...items.flatMap(item => item.levels), ...visibleNcCurves.flatMap(nc => NCTable[nc])
    ) / 10) * 10 + 10);
    const minimum = Math.min(0, Math.floor(Math.min(...items.flatMap(item => item.levels)) / 10) * 10);
    const getX = (idx) => margin.left + (idx / 7) * chartW;
    const getY = (val) => margin.top + chartH - ((val - minimum) / (maximum - minimum)) * chartH;
    const generatePath = (data) => data.map((v, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(v)}`).join(' ');
    const ticks = Array.from({ length: 6 }, (_, index) => minimum + (maximum - minimum) * index / 5);
    const clipId = `chart-${items[0]?.id || 'empty'}`;

    return (
        <svg role="img" aria-label={title} viewBox={`0 0 ${width} ${height}`} className="nc-result-chart">
            <defs><clipPath id={clipId}><rect x={margin.left - pointSize} y={margin.top} width={chartW + pointSize * 2} height={chartH} /></clipPath></defs>
            <text x={margin.left} y="14" fontSize="11" fill="#64748b">音圧レベル (dB)</text>
            {ticks.map(y => (
                <g key={`y-${y}`}>
                    <line x1={margin.left} y1={getY(y)} x2={width - margin.right} y2={getY(y)} stroke="#e2e8f0" strokeDasharray="4 4" />
                    <text x={margin.left - 10} y={getY(y) + 4} textAnchor="end" fontSize="11" fill="#64748b">{Math.round(y)}</text>
                </g>
            ))}
            {FREQUENCIES.map((f, i) => (
                <g key={`x-${f}`}>
                    <line x1={getX(i)} y1={margin.top} x2={getX(i)} y2={height - margin.bottom} stroke="#f1f5f9" />
                    <text x={getX(i)} y={height - margin.bottom + 20} textAnchor="middle" fontSize="11" fill="#64748b">
                        {f >= 1000 ? `${f / 1000}k` : f}
                    </text>
                </g>
            ))}

            <text x={margin.left + chartW / 2} y={height - 6} textAnchor="middle" fontSize="11" fill="#64748b">中心周波数 (Hz)</text>
            <g clipPath={`url(#${clipId})`}>
                {visibleNcCurves.map(nc => <g key={nc}>
                    <path d={generatePath(NCTable[nc])} fill="none" stroke="#94a3b8" strokeWidth="1" strokeDasharray="5 4" />
                    <text x={getX(7) - 3} y={getY(NCTable[nc][7]) - 5} textAnchor="end" fill="#64748b" fontSize="10">NC-{nc}</text>
                </g>)}
                {items.map(item => <g key={item.id} data-series-id={item.id} data-background-reference={item.isReference || undefined} opacity={item.isUpdating ? 0.4 : 1}>
                    <path d={generatePath(item.levels)} fill="none" stroke={item.isReference ? '#64748b' : item.color} strokeWidth={lineWidth} strokeDasharray={item.isReference ? '7 4' : undefined} />
                    {item.levels.map((val, i) => <circle key={i} cx={getX(i)} cy={getY(val)} r={pointSize} fill={item.isReference ? '#64748b' : item.color}>
                        <title>{item.clipName} / {FREQUENCIES[i]} Hz: {val.toFixed(1)} dB</title>
                    </circle>)}
                </g>)}
            </g>
        </svg>
    );
};

const SpectrogramEditor = ({ clip, disabled, onChange, zoom, height, frequencyMin, frequencyMax }) => {
    const canvasRef = useRef(null);
    const rasterRef = useRef(null);
    const sourceRef = useRef(null);
    const gainRef = useRef(null);
    const animationRef = useRef(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [dragTarget, setDragTarget] = useState(null);
    const [playhead, setPlayhead] = useState(clip.start);
    // Playback gain also applies to trimmed WAV exports; analysis and source
    // samples remain unchanged. Spectrogram gain only changes the display.
    const playbackGainPercent = clip.playbackGainPercent ?? 100;
    const spectrogramGain = clip.spectrogramGain ?? 1;

    const stopPlayback = () => {
        if (animationRef.current !== null) {
            cancelAnimationFrame(animationRef.current);
            animationRef.current = null;
        }
        if (sourceRef.current) {
            sourceRef.current.onended = null;
            try { sourceRef.current.stop(); } catch (_) { /* already stopped */ }
            sourceRef.current.disconnect();
            sourceRef.current = null;
        }
        if (gainRef.current) {
            gainRef.current.disconnect();
            gainRef.current = null;
        }
        setIsPlaying(false);
    };

    useEffect(() => () => {
        if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
        if (sourceRef.current) {
            sourceRef.current.onended = null;
            try { sourceRef.current.stop(); } catch (_) { /* already stopped */ }
            sourceRef.current.disconnect();
        }
        if (gainRef.current) gainRef.current.disconnect();
    }, []);

    useEffect(() => {
        if (!isPlaying) setPlayhead(current => Math.max(clip.start, Math.min(current, clip.end)));
    }, [clip.start, clip.end, isPlaying]);

    useEffect(() => {
        if (disabled) stopPlayback();
    }, [disabled]);

    useEffect(() => {
        if (gainRef.current) gainRef.current.gain.setValueAtTime(playbackGainPercent / 100, getAudioContext().currentTime);
    }, [playbackGainPercent]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const draw = () => {
            const rect = canvas.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            canvas.width = Math.max(1, Math.round(rect.width * ratio));
            canvas.height = Math.max(1, Math.round(rect.height * ratio));
            const ctx = canvas.getContext('2d');
            ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            const width = rect.width;
            const height = rect.height;
            ctx.fillStyle = '#020617'; ctx.fillRect(0, 0, width, height);

            // 範囲のドラッグではFFTを再計算せず、同じスペクトログラムを再利用する。
            const cached = rasterRef.current;
            let offscreen = cached?.canvas;
            const maxFrequency = Math.min(frequencyMax, clip.buffer.sampleRate / 2);
            const minFrequency = Math.min(frequencyMin, maxFrequency - 1);
            if (!cached || cached.buffer !== clip.buffer || cached.gain !== spectrogramGain || cached.width !== width || cached.height !== height || cached.min !== minFrequency || cached.max !== maxFrequency) {
            // 設定した周波数範囲を対数軸で描く。各チャンネルのスペクトルパワーを
            // 平均するため、ステレオ再生時も片チャンネルだけに偏らない表示になる。
            const fftSize = 2048;
            const columns = Math.max(1, Math.min(1800, Math.round(width)));
            const rows = Math.max(1, Math.round(height));
            const image = ctx.createImageData(columns, rows);
            const windowFunc = new Float32Array(fftSize);
            for (let i = 0; i < fftSize; i++) windowFunc[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / fftSize);
            const sensitivityDb = 20 * Math.log10(spectrogramGain);
            const channelData = Array.from({ length: clip.buffer.numberOfChannels }, (_, channel) => clip.buffer.getChannelData(channel));
            const powers = new Float64Array(fftSize / 2 + 1);

            for (let x = 0; x < columns; x++) {
                powers.fill(0);
                const center = Math.round((x / Math.max(1, columns - 1)) * Math.max(0, clip.buffer.length - 1));
                const frameStart = center - fftSize / 2;
                for (const samples of channelData) {
                    const re = new Float32Array(fftSize);
                    const im = new Float32Array(fftSize);
                    for (let i = 0; i < fftSize; i++) re[i] = (samples[frameStart + i] || 0) * windowFunc[i];
                    fft(re, im);
                    for (let bin = 0; bin <= fftSize / 2; bin++) powers[bin] += re[bin] * re[bin] + im[bin] * im[bin];
                }
                for (let y = 0; y < rows; y++) {
                    const ratioFromBottom = 1 - y / Math.max(1, rows - 1);
                    const frequency = minFrequency * Math.pow(maxFrequency / minFrequency, ratioFromBottom);
                    const bin = Math.min(fftSize / 2, Math.round(frequency * fftSize / clip.buffer.sampleRate));
                    const power = powers[bin] / Math.max(1, channelData.length * fftSize * fftSize);
                    const db = 10 * Math.log10(power || 1e-12) + sensitivityDb;
                    const level = Math.max(0, Math.min(1, (db + 100) / 80));
                    const pixel = (y * columns + x) * 4;
                    image.data[pixel] = Math.round(255 * Math.max(0, Math.min(1, level * 2.2 - 0.7)));
                    image.data[pixel + 1] = Math.round(255 * Math.max(0, Math.min(1, level * 1.8)));
                    image.data[pixel + 2] = Math.round(255 * Math.max(0, Math.min(1, 0.65 + level * 0.7 - Math.abs(level - 0.5))));
                    image.data[pixel + 3] = 255;
                }
            }
            offscreen = document.createElement('canvas');
            offscreen.width = columns; offscreen.height = rows;
            offscreen.getContext('2d').putImageData(image, 0, 0);
            rasterRef.current = { canvas: offscreen, buffer: clip.buffer, gain: spectrogramGain, width, height, min: minFrequency, max: maxFrequency };
            }
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(offscreen, 0, 0, width, height);
            ctx.font = '10px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.85)';
            ctx.fillText(`${maxFrequency} Hz`, 5, 12); ctx.fillText(`${minFrequency} Hz`, 5, height - 5);
            const inX = clip.start / clip.buffer.duration * width;
            const outX = clip.end / clip.buffer.duration * width;
            ctx.fillStyle = 'rgba(15, 23, 42, .32)'; ctx.fillRect(0, 0, inX, height); ctx.fillRect(outX, 0, width - outX, height);
            ctx.fillStyle = 'rgba(59, 130, 246, .10)'; ctx.fillRect(inX, 0, outX - inX, height);
            ctx.strokeStyle = '#eab308'; ctx.lineWidth = 3; ctx.strokeRect(inX, 1.5, outX - inX, height - 3);
            ctx.fillStyle = '#eab308'; ctx.fillRect(inX - 5, 0, 10, height); ctx.fillRect(outX - 5, 0, 10, height);
        };
        draw();
        const observer = new ResizeObserver(draw);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [clip.buffer, clip.start, clip.end, spectrogramGain, zoom, height, frequencyMin, frequencyMax]);

    const pointerTime = (event) => {
        const rect = canvasRef.current.getBoundingClientRect();
        return Math.max(0, Math.min(clip.buffer.duration, (event.clientX - rect.left) / rect.width * clip.buffer.duration));
    };
    const handlePointerDown = (event) => {
        if (disabled) return;
        stopPlayback();
        const time = pointerTime(event);
        const threshold = Math.max(0.05, clip.buffer.duration * 0.025);
        const target = Math.abs(time - clip.start) <= Math.abs(time - clip.end) && Math.abs(time - clip.start) < threshold ? 'start' :
            Math.abs(time - clip.end) < threshold ? 'end' : (time < (clip.start + clip.end) / 2 ? 'start' : 'end');
        setDragTarget(target);
        canvasRef.current.setPointerCapture(event.pointerId);
        onChange(target === 'start' ? { start: Math.min(time, clip.end - 0.001) } : { end: Math.max(time, clip.start + 0.001) });
    };
    const handlePointerMove = (event) => {
        if (!dragTarget || disabled) return;
        const time = pointerTime(event);
        onChange(dragTarget === 'start' ? { start: Math.min(time, clip.end - 0.001) } : { end: Math.max(time, clip.start + 0.001) });
    };
    const updateNumericBoundary = (key, rawValue) => {
        const value = Number(rawValue);
        if (!Number.isFinite(value)) return;
        stopPlayback();
        onChange(key === 'start'
            ? { start: Math.max(0, Math.min(value, clip.end - 0.001)) }
            : { end: Math.min(clip.buffer.duration, Math.max(value, clip.start + 0.001)) });
    };
    const playSelection = async () => {
        if (isPlaying) { stopPlayback(); return; }
        const ctx = getAudioContext();
        await ctx.resume();
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = clip.buffer;
        gain.gain.value = playbackGainPercent / 100;
        source.connect(gain);
        gain.connect(ctx.destination);
        const startedAt = ctx.currentTime;
        setPlayhead(clip.start);
        const updatePlayhead = () => {
            const current = Math.min(clip.end, clip.start + (ctx.currentTime - startedAt));
            setPlayhead(current);
            if (current < clip.end && sourceRef.current === source) {
                animationRef.current = requestAnimationFrame(updatePlayhead);
            }
        };
        source.onended = () => {
            if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
            animationRef.current = null;
            sourceRef.current = null;
            gain.disconnect();
            gainRef.current = null;
            setPlayhead(clip.end);
            setIsPlaying(false);
        };
        sourceRef.current = source;
        gainRef.current = gain;
        setIsPlaying(true);
        source.start(0, clip.start, clip.end - clip.start);
        animationRef.current = requestAnimationFrame(updatePlayhead);
    };

    return (
        <div className="nc-spectrogram-editor">
            <div className="nc-spectrogram-scroll">
            <div className="nc-spectrogram-content" style={{ width: `${zoom * 100}%`, height }}>
                <canvas ref={canvasRef} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
                    onPointerUp={() => setDragTarget(null)} onPointerCancel={() => setDragTarget(null)}
                    style={{ width: '100%', height: '100%', touchAction: 'none', cursor: 'ew-resize' }} aria-label={`${clip.name} の${frequencyMin}〜${frequencyMax} Hzスペクトログラム範囲選択`} />
                <div className="nc-playhead"
                    style={{ left: `${(playhead / clip.buffer.duration) * 100}%` }} aria-hidden="true" />
            </div>
            <div className="nc-time-ruler" style={{ width: `${zoom * 100}%` }}>
                {[0, 1, 2, 3, 4].map(tick => <span key={tick}>{formatTime(clip.buffer.duration * tick / 4)}</span>)}
            </div>
            </div>
            <div className="nc-boundaries">
                <label>IN (秒)<input aria-label={`${clip.name} IN (秒)`} type="number" min="0" max={clip.end} step="0.001" value={Number(clip.start.toFixed(3))} disabled={disabled}
                    onChange={e => updateNumericBoundary('start', e.target.value)} /></label>
                <label>OUT (秒)<input aria-label={`${clip.name} OUT (秒)`} type="number" min={clip.start} max={clip.buffer.duration} step="0.001" value={Number(clip.end.toFixed(3))} disabled={disabled}
                    onChange={e => updateNumericBoundary('end', e.target.value)} /></label>
            </div>
            <div className="nc-row nc-between nc-muted">
                <span><span className="font-mono text-red-600">{formatTime(playhead)}</span> / {formatTime(clip.end)}（選択 {formatTime(clip.end - clip.start)}）</span>
                <button type="button" disabled={disabled} onClick={playSelection}>
                    {isPlaying ? <Square /> : <Play />}{isPlaying ? '停止' : '範囲を再生'}
                </button>
            </div>
        </div>
    );
};


// --- ワークスペースUI ---
const workspaceStyles = `
.nc-app { color:#1e293b; background:#f1f5f9; min-height:100vh; padding:20px; font-family:ui-sans-serif,system-ui,sans-serif; font-size:13px; }
.nc-app * { box-sizing:border-box; }
.nc-app h1,.nc-app h2,.nc-app h3,.nc-app p { margin:0; }
.nc-app h1 { font-size:23px; font-weight:750; letter-spacing:-.03em; }
.nc-app h2 { font-size:15px; font-weight:700; }
.nc-app h3 { font-size:13px; font-weight:700; }
.nc-app svg:not(.nc-result-chart) { width:16px; height:16px; flex-shrink:0; }
.nc-app button { display:inline-flex; align-items:center; justify-content:center; gap:5px; border:1px solid #cbd5e1; border-radius:6px; background:white; color:#334155; padding:7px 9px; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; }
.nc-app button:hover { background:#f1f5f9; border-color:#94a3b8; }
.nc-app button:disabled { opacity:.4; cursor:not-allowed; }
.nc-app button:focus-visible,.nc-app input:focus-visible,.nc-app select:focus-visible,.nc-drop:focus-within { outline:2px solid #3b82f6; outline-offset:2px; }
.nc-app input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),.nc-app select { min-width:0; width:100%; border:1px solid #cbd5e1; border-radius:5px; background:white; padding:7px 8px; font-size:12px; color:#1e293b; }
.nc-app input[type=checkbox],.nc-app input[type=radio],.nc-app input[type=range] { accent-color:#2563eb; }
.nc-app input[type=range] { width:100%; margin:6px 0 0; }
.nc-app .nc-primary { background:#2563eb; color:white; border-color:#2563eb; }
.nc-app .nc-primary:hover { background:#1d4ed8; }
.nc-app .nc-danger { color:#dc2626; }
.nc-app .nc-icon { padding:6px; }
.nc-app .nc-active { color:#1d4ed8; background:#eff6ff; border-color:#93c5fd; }
.nc-header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:0 0 16px; margin-bottom:16px; border-bottom:1px solid #cbd5e1; }
.nc-header-title { display:flex; align-items:center; gap:12px; }
.nc-header-logo { background:#2563eb; color:white; padding:11px; border-radius:12px; }
.nc-header .nc-header-logo svg { width:24px; height:24px; }
.nc-muted { color:#64748b; font-size:11px; line-height:1.65; }
.nc-row { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.nc-between { justify-content:space-between; }
.nc-stack { display:flex; flex-direction:column; gap:12px; }
.nc-stack > * { flex-shrink:0; }
.nc-grid { display:grid; grid-template-columns:280px minmax(0,1.06fr) minmax(0,1fr); gap:16px; align-items:start; }
.nc-sidebar,.nc-center,.nc-results { min-width:0; }
.nc-card { background:white; border:1px solid #e2e8f0; border-radius:10px; box-shadow:0 1px 2px #0f172a06; }
.nc-card-head { padding:15px 16px; border-bottom:1px solid #e2e8f0; display:flex; align-items:center; justify-content:space-between; gap:10px; }
.nc-card-head h2 { display:flex; align-items:center; gap:7px; }
.nc-card-head h2 svg { color:#64748b; }
.nc-card-body { padding:14px; }
.nc-section-label { display:flex; align-items:center; gap:7px; font-size:13px; font-weight:700; margin-bottom:12px; }
.nc-section-label svg { color:#64748b; }
.nc-app label.nc-field { display:flex; flex-direction:column; gap:5px; font-size:11px; color:#475569; font-weight:600; }
.nc-drop { position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; padding:18px 12px; border:1.5px dashed #93c5fd; border-radius:8px; background:#f8fbff; color:#2563eb; text-align:center; cursor:pointer; overflow:hidden; }
.nc-drop.nc-dragging { background:#dbeafe; border-color:#2563eb; }
.nc-drop.nc-disabled { opacity:.45; cursor:wait; }
.nc-drop input { position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:inherit; }
.nc-drop small { font-size:10px; color:#64748b; }
.nc-drop strong { font-size:12px; }
.nc-file-label { color:#475569; overflow-wrap:anywhere; font-size:11px; }
.nc-note { display:flex; align-items:flex-start; gap:6px; background:#eff6ff; border:1px solid #dbeafe; color:#1e40af; border-radius:7px; padding:10px; font-size:11px; line-height:1.7; }
.nc-success { color:#047857; background:#ecfdf5; border-color:#a7f3d0; }
.nc-alert { display:flex; align-items:flex-start; gap:8px; background:#fef2f2; border:1px solid #fecaca; color:#b91c1c; padding:12px; border-radius:8px; margin-bottom:12px; }
.nc-badge { font-size:11px; padding:2px 7px; background:#f1f5f9; color:#64748b; border-radius:12px; white-space:nowrap; }
.nc-count { color:#2563eb; background:#eff6ff; }
.nc-pair { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.nc-full { width:100%; }
.nc-divider { border-top:1px solid #e2e8f0; padding-top:12px; }
.nc-group-entry { display:flex; align-items:center; gap:5px; }
.nc-group-entry input { flex:1; }
.nc-segment { display:inline-flex; padding:3px; background:#f1f5f9; border-radius:8px; gap:3px; }
.nc-segment button { background:transparent; border-color:transparent; padding:6px 9px; }
.nc-segment button[aria-pressed=true] { background:white; color:#1d4ed8; box-shadow:0 1px 3px #0f172a12; border-color:#e2e8f0; }
.nc-toolbar { display:flex; flex-direction:column; gap:10px; padding:12px; border-bottom:1px solid #e2e8f0; }
.nc-search { position:relative; flex:1; min-width:100px; }
.nc-search svg { position:absolute; left:8px; top:8px; color:#94a3b8; }
.nc-app .nc-search input { padding-left:29px !important; }
.nc-toolbar select { flex:1; }
.nc-table-scroll { overflow:auto; }
.nc-table { border-collapse:collapse; width:100%; font-size:11px; }
.nc-table th { padding:10px 7px; text-align:left; background:#f8fafc; color:#64748b; white-space:nowrap; border-bottom:1px solid #e2e8f0; font-weight:600; }
.nc-app .nc-table th button { background:transparent; border:0; padding:0; color:inherit; font-size:11px; }
.nc-table td { padding:9px 6px; border-bottom:1px solid #f1f5f9; vertical-align:middle; }
.nc-table tr.nc-selected { background:#eff6ff; }
.nc-table .nc-name-cell { min-width:130px; }
.nc-table .nc-file-label { font-size:10px; max-width:190px; margin-top:4px; }
.nc-table .nc-group-cell { min-width:102px; }
.nc-table .nc-compact { white-space:nowrap; }
.nc-app .nc-table input[type=text] { padding:5px 6px; }
.nc-app .nc-table select { padding:5px; }
.nc-grip { cursor:grab !important; color:#94a3b8 !important; }
.nc-drag-target { outline:2px dashed #93c5fd; outline-offset:-2px; }
.nc-empty { padding:48px 24px; text-align:center; display:flex; align-items:center; flex-direction:column; gap:12px; color:#64748b; }
.nc-empty > svg { width:34px !important; height:34px !important; color:#94a3b8; }
.nc-empty strong { color:#475569; font-size:14px; }

.nc-sheet { outline:none; }
.nc-sheet:focus-visible { box-shadow:inset 0 0 0 2px #93c5fd; }
.nc-sheet-table { white-space:nowrap; table-layout:auto; width:max-content; min-width:100%; font-size:12px; }
.nc-sheet-table thead th { border:1px solid #cbd5e1; background:#f1f5f9; padding:8px; }
 .nc-sheet-table thead th:nth-child(-n+3) { padding:6px 3px; font-size:10px; }
.nc-sheet-table thead th:nth-child(1) { width:54px; }
.nc-sheet-table thead th:nth-child(2),.nc-sheet-table thead th:nth-child(3) { width:32px; }
.nc-sheet-table thead th:nth-child(4) { width:52px; }
.nc-sheet-table thead th:nth-child(5) { width:145px; }
.nc-sheet-table thead th:nth-child(6) { width:125px; }
.nc-sheet-table thead th:nth-child(7) { width:105px; }
.nc-sheet-table thead th:nth-child(8) { width:70px; }
.nc-sheet-table thead th:nth-child(9) { width:65px; }
.nc-sheet-table .nc-sheet-cell { border:1px solid #cbd5e1; padding:8px 10px; height:37px; overflow:hidden; text-overflow:ellipsis; cursor:cell; user-select:none; touch-action:none; }
.nc-sheet-table .nc-sheet-cell[data-column=fileName] { overflow:visible; text-overflow:clip; }
.nc-sheet-cell:hover { background:#f8fafc; }
.nc-sheet-table .nc-cell-selected { background:#dbeafe; }
.nc-sheet-table .nc-cell-active { box-shadow:inset 0 0 0 2px #2563eb; }
.nc-sheet-table .nc-cell-hidden { color:#94a3b8; text-decoration:line-through; }
.nc-sheet-table .nc-cell-editing { padding:0; overflow:visible; background:white; }
.nc-app .nc-sheet-table .nc-cell-editing input,.nc-app .nc-sheet-table .nc-cell-editing select { width:100%; height:36px; border:2px solid #2563eb; border-radius:0; outline:none; padding:5px 8px; font-size:12px; }
.nc-sheet-table .nc-sheet-utility,.nc-sheet-table .nc-sheet-row-header { padding:3px; border:1px solid #cbd5e1; text-align:center; background:#f8fafc; }
.nc-sheet-table .nc-sheet-row-header { cursor:cell; user-select:none; touch-action:none; font-size:10px; font-weight:500; color:#64748b; }
.nc-sheet-row-header.nc-selected { background:#dbeafe; color:#1d4ed8; }
.nc-sheet-menu { position:fixed; z-index:40; width:230px; max-height:250px; overflow:auto; padding:5px; background:white; border:1px solid #cbd5e1; box-shadow:0 8px 25px #0f172a26; border-radius:7px; }
.nc-sheet-menu p { padding:8px; color:#64748b; font-size:11px; border-bottom:1px solid #e2e8f0; }
.nc-app .nc-sheet-menu button { display:block; width:100%; border:0; text-align:left; padding:9px; font-weight:500; }

.nc-editor-list { padding:12px; display:flex; flex-direction:column; gap:12px; }
.nc-editor-card { border:1px solid #e2e8f0; border-radius:8px; overflow:hidden; }
.nc-editor-card.nc-selected { border-color:#93c5fd; }
.nc-editor-head { padding:10px; background:#f8fafc; border-bottom:1px solid #e2e8f0; }
.nc-editor-head input[type=text] { flex:1; }
.nc-editor-head select { max-width:150px; }
.nc-spectrogram-editor { padding:10px; display:flex; flex-direction:column; gap:10px; }
.nc-spectrogram-scroll { overflow-x:auto; border-radius:5px; background:#020617; }
.nc-spectrogram-content { position:relative; min-width:100%; }
.nc-playhead { position:absolute; top:0; bottom:0; width:2px; pointer-events:none; background:#ef4444; }
.nc-time-ruler { display:flex; justify-content:space-between; padding:4px 5px; color:#94a3b8; font:9px ui-monospace,monospace; }
.nc-boundaries { display:grid; grid-template-columns:1fr 1fr; gap:10px; font-size:10px; color:#64748b; }
.nc-boundaries input { display:block; margin-top:4px; }
.nc-result-card { border:1px solid #e2e8f0; background:white; border-radius:9px; overflow:hidden; }
.nc-result-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:13px; border-bottom:1px solid #f1f5f9; }
.nc-result-head h3 { overflow-wrap:anywhere; }
.nc-result-chart { display:block; width:100%; height:auto; background:white; }
.nc-nc { color:#1d4ed8; background:#eff6ff; border:1px solid #dbeafe; border-radius:7px; font-size:18px; font-weight:750; padding:5px 9px; white-space:nowrap; }
.nc-result-actions { padding:10px 13px; border-top:1px solid #f1f5f9; }
.nc-legend { list-style:none; padding:0 13px 10px; margin:0; display:flex; flex-direction:column; gap:7px; }
.nc-legend li { display:flex; align-items:center; gap:8px; font-size:11px; }
.nc-legend li span:nth-child(2) { overflow-wrap:anywhere; flex:1; }
.nc-swatch { display:inline-block; width:20px; border-top:3px solid; flex-shrink:0; }
.nc-legend b { color:#334155; font-size:12px; white-space:nowrap; }
.nc-details { padding:10px 13px; font-size:11px; border-top:1px solid #f1f5f9; }
.nc-details summary { cursor:pointer; color:#64748b; }
.nc-details table { width:100%; border-collapse:collapse; margin-top:10px; font-size:11px; }
.nc-details th,.nc-details td { padding:5px; text-align:right; border-bottom:1px solid #f1f5f9; }
.nc-details th:first-child,.nc-details td:first-child { text-align:left; }
.nc-nc-curves { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; font-size:10px; }
.nc-progress { height:3px; background:#dbeafe; overflow:hidden; }
.nc-progress span { display:block; height:100%; background:#2563eb; transition:width .1s; }
@media (min-width:1100px) { .nc-column { max-height:calc(100vh - 115px); overflow-y:auto; scrollbar-width:thin; } .nc-sticky-head { position:sticky; top:0; z-index:2; background:white; } }
@media (max-width:1240px) and (min-width:1100px) { .nc-app { padding:12px; } .nc-grid { grid-template-columns:250px minmax(0,1fr) minmax(0,1fr); gap:10px; } }
@media (max-width:1099px) { .nc-grid { grid-template-columns:270px minmax(0,1fr); } .nc-results { grid-column:2; } .nc-sidebar { grid-row:1 / 3; } }
@media (max-width:700px) { .nc-app { padding:10px; } .nc-header { align-items:flex-start; flex-direction:column; gap:10px; } .nc-app h1 { font-size:20px; } .nc-grid { display:flex; flex-direction:column; } .nc-sidebar,.nc-center,.nc-results { width:100%; } .nc-app .nc-header-status { display:none; } }
`;

const FileDropZone = ({ label, hint, accept, multiple = false, disabled, onFiles }) => {
    const [dragging, setDragging] = useState(false);
    const dragDepth = useRef(0);
    return <label className={`nc-drop ${dragging ? 'nc-dragging' : ''} ${disabled ? 'nc-disabled' : ''}`}
        onDragEnter={event => { event.preventDefault(); dragDepth.current++; if (!disabled) setDragging(true); }}
        onDragOver={event => event.preventDefault()}
        onDragLeave={event => { event.preventDefault(); if (--dragDepth.current <= 0) setDragging(false); }}
        onDrop={event => {
            event.preventDefault(); dragDepth.current = 0; setDragging(false);
            if (!disabled) onFiles(Array.from(event.dataTransfer.files));
        }}>
        <Upload /><strong>{label}</strong><small>{hint}</small>
        <input type="file" aria-label={label} accept={accept} multiple={multiple} disabled={disabled}
            onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; if (files.length) onFiles(files); }} />
    </label>;
};

const GroupNameField = ({ name, disabled, onRename }) => {
    const [value, setValue] = useState(name);
    const cancelRef = useRef(false);
    useEffect(() => setValue(name), [name]);
    const commit = () => { if (!cancelRef.current) onRename(value.trim()); cancelRef.current = false; setValue(name); };
    return <input aria-label={`グループ名 ${name}`} value={value} disabled={disabled}
        onChange={event => setValue(event.target.value)} onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { cancelRef.current = true; setValue(name); event.currentTarget.blur(); } }} />;
};

const SelectAllCheckbox = ({ clips, selectedIds, onChange, disabled }) => {
    const ref = useRef(null);
    const count = clips.filter(clip => selectedIds.includes(clip.id)).length;
    useEffect(() => { if (ref.current) ref.current.indeterminate = count > 0 && count < clips.length; }, [count, clips.length]);
    return <input ref={ref} type="checkbox" aria-label="表示中のファイルをすべて選択" checked={clips.length > 0 && count === clips.length}
        disabled={disabled || !clips.length} onChange={event => onChange(event.target.checked)} />;
};

// index.html と同じ、セル範囲を選んで後からグループを割り当てる表。
// 選択は行番号ではなくIDに結び付け、ソート後も別ファイルに操作が移らないようにする。
const ANALYSIS_COLUMNS = [
    { key: 'fileName', label: '元ファイル', readOnly: true },
    { key: 'name', label: '表示名' },
    { key: 'groupName', label: 'グループ' },
    { key: 'nc', label: 'NC', readOnly: true }
];
const sheetKey = (id, column) => JSON.stringify([id, column]);

const AnalysisTable = ({ clips, groups, selectedIds, setSelectedIds, resultById, pendingIds, calibrationPending,
    disabled, onApplyEdits, onRemove, onDuplicate, onSort, dragHandle, rowDragProps, isBackground, onBackgroundChange }) => {
    const rootRef = useRef(null);
    const dragRef = useRef(null);
    const anchorRef = useRef(null);
    const [selectedCells, setSelectedCells] = useState(() => new Set(selectedIds.flatMap(id => ANALYSIS_COLUMNS.map(column => sheetKey(id, column.key)))));
    const [editing, setEditing] = useState(null);
    const editingRef = useRef(null);
    const [contextMenu, setContextMenu] = useState(null);
    const [activeCell, setActiveCell] = useState(null);
    const currentRef = useRef(null);

    const selectCells = (cells, active = activeCell) => {
        setSelectedCells(cells); setActiveCell(active);
        setSelectedIds([...new Set([...cells].map(key => JSON.parse(key)[0]))]);
    };
    useEffect(() => {
        // チェックボックス・全選択・スペクトログラム側の行選択とも同期する。
        setSelectedCells(current => {
            const next = new Set([...current].filter(key => selectedIds.includes(JSON.parse(key)[0])));
            const existing = new Set([...next].map(key => JSON.parse(key)[0]));
            selectedIds.forEach(id => { if (!existing.has(id)) ANALYSIS_COLUMNS.forEach(column => next.add(sheetKey(id, column.key))); });
            return next;
        });
        if (!selectedIds.length) { setActiveCell(null); anchorRef.current = null; setContextMenu(null); }
    }, [selectedIds]);
    useEffect(() => {
        if (disabled) { dragRef.current = null; editingRef.current = null; setEditing(null); setContextMenu(null); }
    }, [disabled]);

    const rectangle = (from, to) => {
        const fromRow = clips.findIndex(clip => clip.id === from.id), toRow = clips.findIndex(clip => clip.id === to.id);
        const fromCol = ANALYSIS_COLUMNS.findIndex(column => column.key === from.column), toCol = ANALYSIS_COLUMNS.findIndex(column => column.key === to.column);
        if (Math.min(fromRow, toRow, fromCol, toCol) < 0) return new Set([sheetKey(to.id, to.column)]);
        const next = new Set();
        for (let r = Math.min(fromRow, toRow); r <= Math.max(fromRow, toRow); r++) {
            for (let c = Math.min(fromCol, toCol); c <= Math.max(fromCol, toCol); c++) next.add(sheetKey(clips[r].id, ANALYSIS_COLUMNS[c].key));
        }
        return next;
    };
    const focusGrid = () => rootRef.current?.focus({ preventScroll: true });
    const beginSelection = (event, clip, column) => {
        if (disabled || event.button !== 0 || event.target.closest('input,select,button')) return;
        event.preventDefault(); focusGrid(); setContextMenu(null);
        const cell = { id: clip.id, column };
        const key = sheetKey(clip.id, column);
        const additive = event.ctrlKey || event.metaKey;
        if (!additive && !event.shiftKey && selectedCells.has(key) && selectedCells.size > 1) {
            // 選択範囲内のダブルクリックで、一括グループ編集の対象を保持する。
            anchorRef.current = cell; setActiveCell(cell);
            dragRef.current = { pointerId: event.pointerId, anchor: cell, base: new Set(), last: key, x: event.clientX, y: event.clientY };
            return;
        }
        const base = additive ? new Set(selectedCells) : new Set();
        if (additive && base.has(key)) { base.delete(key); selectCells(base, cell); dragRef.current = null; anchorRef.current = cell; return; }
        const anchor = event.shiftKey && anchorRef.current && clips.some(item => item.id === anchorRef.current.id) ? anchorRef.current : cell;
        anchorRef.current = anchor;
        selectCells(new Set([...base, ...rectangle(anchor, cell)]), cell);
        dragRef.current = { pointerId: event.pointerId, anchor, base, last: key, x: event.clientX, y: event.clientY };
    };
    const extendSelection = cell => {
        const drag = dragRef.current;
        if (!drag) return;
        if (drag.wholeRow) cell = { ...cell, column: ANALYSIS_COLUMNS.at(-1).key };
        const key = sheetKey(cell.id, cell.column);
        if (key === drag.last) return;
        drag.last = key;
        selectCells(new Set([...drag.base, ...rectangle(drag.anchor, cell)]), cell);
    };
    currentRef.current = { extendSelection };
    useEffect(() => {
        let frame;
        const updateFromPoint = () => {
            const drag = dragRef.current, root = rootRef.current;
            if (!drag || !root) return;
            const scroller = root.querySelector('.nc-table-scroll'), column = root.closest('.nc-column');
            const bounds = scroller.getBoundingClientRect(), vertical = column.getBoundingClientRect();
            const top = Math.max(bounds.top + 38, vertical.top), bottom = Math.min(bounds.bottom, vertical.bottom, window.innerHeight);
            if (drag.x >= bounds.left - 24 && drag.x <= bounds.right + 24) {
                if (drag.y > bottom - 24) column.scrollTop += 12;
                else if (drag.y < top + 16) column.scrollTop -= 12;
                if (drag.x > bounds.right - 24) scroller.scrollLeft += 12;
                else if (drag.x < bounds.left + 24) scroller.scrollLeft -= 12;
                const x = Math.max(bounds.left + 2, Math.min(drag.x, bounds.right - 2));
                const y = Math.max(top + 2, Math.min(drag.y, bottom - 2));
                const cell = document.elementFromPoint(x, y)?.closest('[data-sheet-row][data-column]');
                if (cell && root.contains(cell)) currentRef.current.extendSelection({ id: cell.dataset.sheetRow, column: cell.dataset.column });
            }
        };
        const tick = () => { updateFromPoint(); if (dragRef.current) frame = requestAnimationFrame(tick); };
        const move = event => {
            if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
            dragRef.current.x = event.clientX; dragRef.current.y = event.clientY;
            if (!frame) frame = requestAnimationFrame(tick);
        };
        const stop = () => { dragRef.current = null; cancelAnimationFrame(frame); frame = null; };
        const closeMenu = event => { if (!event.target.closest('.nc-sheet-menu')) setContextMenu(null); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
        window.addEventListener('blur', stop); window.addEventListener('pointerdown', closeMenu);
        return () => {
            stop(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop); window.removeEventListener('pointerdown', closeMenu);
        };
    }, []);

    const startEdit = (clip, column, initialValue) => {
        if (disabled || !['name', 'groupName'].includes(column)) return;
        if (!selectedCells.has(sheetKey(clip.id, column))) selectCells(new Set([sheetKey(clip.id, column)]), { id: clip.id, column });
        const draft = { id: clip.id, column, value: initialValue ?? clip[column] };
        editingRef.current = draft; setEditing(draft); setContextMenu(null); dragRef.current = null;
    };
    const closeEdit = () => { editingRef.current = null; setEditing(null); focusGrid(); };
    const commitName = advance => {
        const draft = editingRef.current;
        if (!draft) return;
        onApplyEdits({ [draft.id]: { name: draft.value } });
        closeEdit();
        if (advance) {
            const index = clips.findIndex(clip => clip.id === draft.id) + advance;
            if (clips[index]) { anchorRef.current = { id: clips[index].id, column: 'name' }; startEdit(clips[index], 'name'); }
        }
    };
    const applyGroup = name => {
        if (disabled) return;
        onApplyEdits(Object.fromEntries(selectedIds.map(id => [id, { groupName: name }])));
        closeEdit(); setContextMenu(null);
    };
    const cellValue = (clip, column) => {
        if (column === 'fileName') return clip.file.name;
        if (column === 'duration') return `${formatTime(clip.start)} – ${formatTime(clip.end)}`;
        if (column === 'nc') {
            const result = resultById.get(clip.id);
            return result && !result.isUpdating ? `NC-${formatNC(result.nc.overall)}` : pendingIds.includes(clip.id) || calibrationPending ? '更新中…' : '解析待ち';
        }
        return clip[column];
    };
    const selectedBounds = () => {
        const cells = [...selectedCells].map(key => JSON.parse(key)).map(([id, column]) => ({ r: clips.findIndex(clip => clip.id === id), c: ANALYSIS_COLUMNS.findIndex(item => item.key === column) })).filter(cell => cell.r >= 0 && cell.c >= 0);
        return cells.length ? { minR: Math.min(...cells.map(cell => cell.r)), maxR: Math.max(...cells.map(cell => cell.r)), minC: Math.min(...cells.map(cell => cell.c)), maxC: Math.max(...cells.map(cell => cell.c)) } : null;
    };
    const handleCopy = event => {
        if (editing || event.target.closest('input,select') || !selectedCells.size) return;
        const bounds = selectedBounds(); if (!bounds) return;
        const rows = [];
        for (let r = bounds.minR; r <= bounds.maxR; r++) {
            const row = [];
            for (let c = bounds.minC; c <= bounds.maxC; c++) row.push(selectedCells.has(sheetKey(clips[r].id, ANALYSIS_COLUMNS[c].key)) ? String(cellValue(clips[r], ANALYSIS_COLUMNS[c].key)).replace(/[\t\r\n]/g, ' ') : '');
            rows.push(row.join('\t'));
        }
        event.preventDefault(); event.clipboardData.setData('text/plain', rows.join('\n'));
    };
    const handlePaste = event => {
        if (disabled || editing || event.target.closest('input,select')) return;
        const bounds = selectedBounds(); if (!bounds) return;
        const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n').replace(/\n$/, '');
        if (!text) return;
        event.preventDefault();
        const rows = text.split('\n').map(row => row.split('\t')), updates = {};
        const write = (id, column, value) => {
            if (!['name', 'groupName'].includes(column)) return;
            const next = column === 'groupName' ? value.trim() || groups[0] : value;
            updates[id] = { ...(updates[id] || {}), [column]: next };
        };
        if (rows.length === 1 && rows[0].length === 1) {
            selectedCells.forEach(key => { const [id, column] = JSON.parse(key); if (clips.some(clip => clip.id === id)) write(id, column, rows[0][0]); });
        } else rows.forEach((row, r) => row.forEach((value, c) => {
            if (clips[bounds.minR + r] && ANALYSIS_COLUMNS[bounds.minC + c]) write(clips[bounds.minR + r].id, ANALYSIS_COLUMNS[bounds.minC + c].key, value);
        }));
        onApplyEdits(updates);
    };
    const handleKeyDown = event => {
        if (disabled || editing || event.target.closest('input,select,button')) return;
        const command = event.ctrlKey || event.metaKey;
        if (command && event.key.toLowerCase() === 'a') {
            event.preventDefault(); selectCells(new Set(clips.flatMap(clip => ANALYSIS_COLUMNS.map(column => sheetKey(clip.id, column.key))))); return;
        }
        if (event.key === 'Escape') { setContextMenu(null); selectCells(new Set(), null); return; }
        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault(); const edits = {};
            selectedCells.forEach(key => { const [id, column] = JSON.parse(key);
                if (column === 'name' || column === 'groupName') edits[id] = { ...(edits[id] || {}), [column]: column === 'groupName' ? groups[0] : '' }; });
            onApplyEdits(edits); return;
        }
        if (!activeCell) return;
        const clip = clips.find(item => item.id === activeCell.id); if (!clip) return;
        if (event.key === 'F2' || event.key === 'Enter' || (!command && !event.altKey && !event.isComposing && event.key.length === 1)) {
            event.preventDefault(); startEdit(clip, activeCell.column, event.key.length === 1 && activeCell.column === 'name' ? event.key : undefined); return;
        }
        const r = clips.findIndex(item => item.id === activeCell.id), c = ANALYSIS_COLUMNS.findIndex(column => column.key === activeCell.column);
        const movement = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, event.shiftKey ? -1 : 1] }[event.key];
        if (movement) {
            if (event.key === 'Tab' && (c + movement[1] < 0 || c + movement[1] >= ANALYSIS_COLUMNS.length)) return;
            event.preventDefault(); const next = { id: clips[Math.max(0, Math.min(clips.length - 1, r + movement[0]))].id, column: ANALYSIS_COLUMNS[Math.max(0, Math.min(ANALYSIS_COLUMNS.length - 1, c + movement[1]))].key };
            const anchor = event.shiftKey && event.key !== 'Tab' ? anchorRef.current || activeCell : next;
            anchorRef.current = anchor; selectCells(rectangle(anchor, next), next);
        }
    };
    const selectRow = (event, clip) => {
        if (disabled || event.target.closest('button')) return;
        event.preventDefault(); focusGrid();
        const next = event.ctrlKey || event.metaKey ? new Set(selectedCells) : new Set();
        const anchor = event.shiftKey && anchorRef.current && clips.some(item => item.id === anchorRef.current.id) ? { id: anchorRef.current.id, column: ANALYSIS_COLUMNS[0].key } : { id: clip.id, column: ANALYSIS_COLUMNS[0].key };
        anchorRef.current = anchor;
        const end = { id: clip.id, column: ANALYSIS_COLUMNS.at(-1).key };
        selectCells(new Set([...next, ...rectangle(anchor, end)]), end);
        dragRef.current = { pointerId: event.pointerId, anchor, base: next, last: '', x: event.clientX, y: event.clientY, wholeRow: true };
    };

    return <div ref={rootRef} className="nc-sheet" tabIndex={0} aria-label="ファイル表のセル操作" onKeyDown={handleKeyDown} onCopy={handleCopy} onPaste={handlePaste}>
        <div className="nc-table-scroll"><table className="nc-table nc-sheet-table" role="grid" aria-label="解析ファイル表" aria-multiselectable="true" aria-rowcount={clips.length + 1} aria-colcount={ANALYSIS_COLUMNS.length + 5}>
            <thead><tr><th>#</th><th>選択</th><th>表示</th><th>暗騒音</th>{ANALYSIS_COLUMNS.map(column => <th key={column.key}>{onSort(column.key, column.label)}</th>)}<th>操作</th></tr></thead>
            <tbody>{clips.map((clip, index) => <tr key={clip.id} data-clip-id={clip.id} aria-rowindex={index + 2} {...rowDragProps(clip.id)}>
                <th scope="row" data-sheet-row={clip.id} data-column={ANALYSIS_COLUMNS.at(-1).key} className={`nc-sheet-row-header ${selectedIds.includes(clip.id) ? 'nc-selected' : ''}`} onPointerDown={event => selectRow(event, clip)}>
                    <div className="nc-row" style={{ flexWrap: 'nowrap', gap: 2 }}>{dragHandle(clip)}<span>{index + 1}</span></div>
                </th>
                <td className="nc-sheet-utility"><input type="checkbox" aria-label={`${clip.name} を選択`} checked={selectedIds.includes(clip.id)} disabled={disabled} onChange={event => setSelectedIds(current => event.target.checked ? [...new Set([...current, clip.id])] : current.filter(id => id !== clip.id))} /></td>
                <td className="nc-sheet-utility"><input type="checkbox" aria-label={`${clip.name} のグラフを表示`} checked={clip.isVisible} disabled={disabled} onChange={event => {
                    const ids = selectedIds.includes(clip.id) ? selectedIds : [clip.id]; onApplyEdits(Object.fromEntries(ids.map(id => [id, { isVisible: event.target.checked }])));
                }} /></td>
                <td className="nc-sheet-utility"><input type="checkbox" aria-label={`${clip.name} を暗騒音に指定`} checked={isBackground(clip)} disabled={disabled} onChange={event => onBackgroundChange(clip, event.target.checked)} /></td>
                {ANALYSIS_COLUMNS.map(column => {
                    const selected = selectedCells.has(sheetKey(clip.id, column.key));
                    const isEditing = editing?.id === clip.id && editing.column === column.key;
                    const cell = { id: clip.id, column: column.key };
                    return <td key={column.key} role="gridcell" data-sheet-row={clip.id} data-column={column.key} aria-selected={selected} aria-readonly={Boolean(column.readOnly)}
                        aria-label={column.key === 'name' ? `${clip.file.name} の表示名セル` : column.key === 'groupName' ? `${clip.name} のグループセル` : undefined}
                        className={`nc-sheet-cell ${selected ? 'nc-cell-selected' : ''} ${activeCell?.id === clip.id && activeCell.column === column.key ? 'nc-cell-active' : ''} ${isEditing ? 'nc-cell-editing' : ''} ${!clip.isVisible ? 'nc-cell-hidden' : ''}`}
                        onPointerDown={event => beginSelection(event, clip, column.key)} onPointerEnter={() => {
                            const drag = dragRef.current;
                            if (drag?.wholeRow) extendSelection({ id: clip.id, column: ANALYSIS_COLUMNS.at(-1).key }); else extendSelection(cell);
                        }}
                        onDoubleClick={() => startEdit(clip, column.key)} onContextMenu={event => {
                            if (disabled) return; event.preventDefault(); dragRef.current = null;
                            if (!selectedIds.includes(clip.id)) { selectCells(new Set([sheetKey(clip.id, column.key)]), cell); anchorRef.current = cell; }
                            setContextMenu({ x: Math.max(4, Math.min(event.clientX, window.innerWidth - 240)), y: Math.max(4, Math.min(event.clientY, window.innerHeight - 260)) });
                        }} title={column.readOnly ? cellValue(clip, column.key) : 'ダブルクリックで編集 / ドラッグで範囲選択'}>
                        {isEditing && column.key === 'name' ? <input type="text" autoFocus aria-label={`${clip.file.name} の表示名`} value={editing.value}
                            onFocus={event => event.target.select()} onChange={event => { const draft = { ...editing, value: event.target.value }; editingRef.current = draft; setEditing(draft); }}
                            onBlur={() => commitName()} onKeyDown={event => {
                                if (event.isComposing || event.nativeEvent.isComposing) return;
                                if (event.key === 'Escape') { event.preventDefault(); closeEdit(); }
                                else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); commitName(event.shiftKey ? -1 : 1); }
                            }} /> : isEditing && column.key === 'groupName' ? <select autoFocus aria-label={`${clip.name} のグループ`} value={clip.groupName}
                            onChange={event => applyGroup(event.target.value)} onBlur={() => { editingRef.current = null; setEditing(null); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeEdit(); } }}>
                            {groups.map(group => <option key={group}>{group}</option>)}</select> : cellValue(clip, column.key)}
                    </td>;
                })}
                <td className="nc-sheet-utility"><button type="button" className="nc-icon" disabled={disabled} aria-label={`${clip.name} の範囲を複製`} onClick={() => onDuplicate(clip.id)}><Copy /></button>
                    <button type="button" className="nc-icon nc-danger" disabled={disabled} aria-label={`${clip.name} を削除`} onClick={() => onRemove(selectedIds.includes(clip.id) ? selectedIds : [clip.id])}><Trash2 /></button></td>
            </tr>)}</tbody>
        </table></div>
        {contextMenu && <div role="menu" aria-label="選択行のグループを変更" className="nc-sheet-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onKeyDown={event => { if (event.key === 'Escape') { setContextMenu(null); focusGrid(); } }}>
            <p>{selectedIds.length} 行のグループを変更</p>{groups.map(group => <button type="button" role="menuitem" key={group} onClick={() => applyGroup(group)}>{group}</button>)}
        </div>}
    </div>;
};

export default function App() {
    const projectInputRef = useRef(null);
    const dragIdRef = useRef(null);
    const skipDirtyRef = useRef(true);
    const calibrationRef = useRef({ file: null, level: 94, offset: null });
    const analysisJobsRef = useRef(new Map());
    const [calibFile, setCalibFile] = useState(null);
    const [calibLevel, setCalibLevel] = useState(94);
    const [offset, setOffset] = useState(null);
    const [clips, setClips] = useState([]);
    const [rawResults, setRawResults] = useState([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [pendingAnalysisIds, setPendingAnalysisIds] = useState([]);
    const [calibrationPending, setCalibrationPending] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');
    const [groups, setGroups] = useState(['Group 1']);
    const [newGroupName, setNewGroupName] = useState('');
    const [selectedIds, setSelectedIds] = useState([]);
    const [search, setSearch] = useState('');
    const [groupFilter, setGroupFilter] = useState('');
    const [viewMode, setViewMode] = useState('table');
    const [resultView, setResultView] = useState('individual');
    const [backgroundMode, setBackgroundMode] = useState('shared');
    const [sharedBackgroundId, setSharedBackgroundId] = useState(null);
    const [groupBackgroundIds, setGroupBackgroundIds] = useState({});
    const [sortState, setSortState] = useState(null);
    const [useClipNameOnly, setUseClipNameOnly] = useState(false);
    const [allPlaybackGainPercent, setAllPlaybackGainPercent] = useState(100);
    const [allSpectrogramGain, setAllSpectrogramGain] = useState(1);
    const [monitorTarget, setMonitorTarget] = useState('all');
    const [spectrogramZoom, setSpectrogramZoom] = useState(1);
    const [spectrogramHeight, setSpectrogramHeight] = useState(140);
    const [spectrogramFrequencies, setSpectrogramFrequencies] = useState({ min: 100, max: 1000 });
    const [lineWidth, setLineWidth] = useState(2);
    const [pointSize, setPointSize] = useState(3);
    const [yAxisMaxAuto, setYAxisMaxAuto] = useState(true);
    const [yAxisMaxManual, setYAxisMaxManual] = useState(100);
    const [visibleNcCurves, setVisibleNcCurves] = useState([20, 30, 40, 50, 60]);
    const [projectImportMode, setProjectImportMode] = useState('replace');
    const [projectName, setProjectName] = useState('WAV解析');
    const [projectFileHandle, setProjectFileHandle] = useState(null);
    const [projectFileName, setProjectFileName] = useState('NC解析プロジェクト.nca');
    const [saveStatus, setSaveStatus] = useState('');
    const [isDirty, setIsDirty] = useState(false);

    useEffect(() => {
        if (skipDirtyRef.current) { skipDirtyRef.current = false; setIsDirty(false); }
        else setIsDirty(true);
    }, [clips, rawResults, groups, calibFile, calibLevel, offset, useClipNameOnly, allPlaybackGainPercent,
        allSpectrogramGain, spectrogramZoom, spectrogramHeight, spectrogramFrequencies, lineWidth, pointSize, yAxisMaxAuto,
        yAxisMaxManual, visibleNcCurves, projectName, viewMode, resultView, backgroundMode, sharedBackgroundId, groupBackgroundIds]);

    useEffect(() => {
        setSharedBackgroundId(current => clips.some(clip => clip.id === current) ? current : null);
        setGroupBackgroundIds(current => {
            const entries = Object.entries(current).filter(([group, id]) => groups.includes(group) && clips.some(clip => clip.id === id && clip.groupName === group));
            return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
        });
    }, [clips, groups]);

    const backgroundForGroup = group => {
        const id = backgroundMode === 'shared' ? sharedBackgroundId : groupBackgroundIds[group];
        return clips.find(clip => clip.id === id && (backgroundMode === 'shared' || clip.groupName === group)) || null;
    };
    const isBackground = clip => backgroundForGroup(clip.groupName)?.id === clip.id;
    const setBackground = (clip, checked) => {
        if (backgroundMode === 'shared') setSharedBackgroundId(checked ? clip.id : null);
        else setGroupBackgroundIds(current => ({ ...current, [clip.groupName]: checked ? clip.id : null }));
    };
    const changeBackgroundMode = shared => {
        if (!shared && sharedBackgroundId) {
            const clip = clips.find(item => item.id === sharedBackgroundId);
            if (clip) setGroupBackgroundIds(current => ({ ...current, [clip.groupName]: clip.id }));
        }
        setBackgroundMode(shared ? 'shared' : 'group');
    };
    const results = useMemo(() => {
        const byId = new Map(rawResults.map(result => [result.id, result]));
        const stale = (result, clip) => !result || calibrationPending || (calibFile && offset === null) ||
            result.sourceBuffer !== clip.buffer || result.selectedStart !== clip.start || result.selectedEnd !== clip.end || result.offset !== (offset ?? 100);
        return clips.flatMap(clip => {
            const result = byId.get(clip.id);
            if (!result) return [];
            const background = backgroundForGroup(clip.groupName);
            const reference = background && background.id !== clip.id ? byId.get(background.id) : null;
            return [{ ...result, unadjustedLevels: result.levels,
                backgroundId: background?.id || null, backgroundName: reference ? background.name : null,
                isBackground: background?.id === clip.id, sourceFileName: clip.file.name, clipName: clip.name,
                groupName: clip.groupName, color: clip.color, playbackGainPercent: clip.playbackGainPercent, isVisible: clip.isVisible, useClipNameOnly,
                isUpdating: stale(result, clip),
                nc: evaluateNC(result.levels) }];
        });
    }, [clips, rawResults, useClipNameOnly, offset, calibrationPending, calibFile, backgroundMode, sharedBackgroundId, groupBackgroundIds]);
    const resultById = useMemo(() => new Map(results.map(result => [result.id, result])), [results]);
    const chartItemsForGroup = (items, group) => {
        const background = backgroundForGroup(group);
        const reference = background && resultById.get(background.id);
        const series = items.map(item => ({ ...item, isReference: item.id === background?.id }));
        if (reference && !items.some(item => item.id === reference.id)) series.push({ ...reference, isReference: true });
        return series;
    };
    const filteredClips = clips.filter(clip => (!groupFilter || clip.groupName === groupFilter) &&
        `${clip.name} ${clip.file.name} ${clip.groupName}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    const validResults = results.filter(result => !result.isUpdating);
    const isAnalyzing = pendingAnalysisIds.length > 0;
    const canExportResults = validResults.length > 0 && !isAnalyzing && !calibrationPending;
    const canSaveProject = !isAnalyzing && !calibrationPending && (!calibFile || offset !== null);
    const shownResults = results.filter(result => result.isVisible);
    // 比較グループも、ファイル一覧で最初に現れる順に並べる。
    const resultGroups = [...new Set(shownResults.map(result => result.groupName))];
    const monitoringClip = clips.find(clip => clip.id === monitorTarget);
    const selectedCount = selectedIds.filter(id => clips.some(clip => clip.id === id)).length;
    const chartSettings = { visibleNcCurves, lineWidth, pointSize, yAxisMax: yAxisMaxAuto ? null : yAxisMaxManual };

    const invalidateCalibration = (hasFile = Boolean(calibFile)) => {
        setOffset(null); setCalibrationPending(hasFile);
    };
    const handleCalibFiles = files => {
        if (isProcessing || !files.length) return;
        if (files.length !== 1 || !/\.wav$/i.test(files[0].name)) { setErrorMsg('校正音はWAVファイルを1つ選択してください。'); return; }
        setCalibFile(files[0]); invalidateCalibration(true); setErrorMsg('');
    };
    const handleMeasFiles = async files => {
        if (isProcessing || !files.length) return;
        if (files.some(file => !/\.wav$/i.test(file.name))) { setErrorMsg('解析対象にはWAVファイルを選択してください。'); return; }
        setIsProcessing(true); setErrorMsg('');
        try {
            const decoded = [];
            for (const file of files) {
                const buffer = await decodeFile(file);
                decoded.push({ id: newId(), file, buffer, name: file.name.replace(/\.wav$/i, ''),
                    groupName: groups[0], color: SERIES_COLORS[(clips.length + decoded.length) % SERIES_COLORS.length],
                    isVisible: true, start: 0, end: buffer.duration,
                    playbackGainPercent: allPlaybackGainPercent, spectrogramGain: allSpectrogramGain });
            }
            setClips(current => [...current, ...decoded]); setSortState(null);
        } catch (err) { setErrorMsg(`WAVファイルを読み込めませんでした: ${err.message}`); }
        finally { setIsProcessing(false); }
    };
    const updateClip = (id, changes) => {
        setClips(current => current.map(clip => clip.id === id ? { ...clip, ...changes } : clip));
        if ('name' in changes || 'groupName' in changes) setSortState(null);
    };
    const applyTableEdits = updates => {
        const additions = [...new Set(Object.values(updates).map(update => update.groupName).filter(name => name && !groups.includes(name)))];
        if (additions.length) setGroups(current => [...new Set([...current, ...additions])]);
        if (Object.keys(updates).length) {
            setClips(current => current.map(clip => updates[clip.id] ? { ...clip, ...updates[clip.id] } : clip));
            setSortState(null);
        }
    };
    const updateMonitoring = (key, value) => {
        if (monitorTarget === 'all') {
            if (key === 'playbackGainPercent') setAllPlaybackGainPercent(value); else setAllSpectrogramGain(value);
        }
        setClips(current => current.map(clip => monitorTarget === 'all' || monitorTarget === clip.id ? { ...clip, [key]: value } : clip));
    };
    const duplicateClip = id => {
        const original = clips.find(clip => clip.id === id);
        if (!original) return;
        const copy = { ...original, id: newId(), name: `${original.name} (コピー)`, color: SERIES_COLORS[clips.length % SERIES_COLORS.length] };
        setClips(current => { const index = current.findIndex(clip => clip.id === id); return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)]; });
        const result = rawResults.find(item => item.id === id);
        if (result) setRawResults(current => [...current, { ...result, id: copy.id }]);
        setSortState(null);
    };
    const removeClips = ids => {
        setClips(current => current.filter(clip => !ids.includes(clip.id)));
        setRawResults(current => current.filter(result => !ids.includes(result.id)));
        setSelectedIds(current => current.filter(id => !ids.includes(id)));
        if (ids.includes(monitorTarget)) setMonitorTarget('all');
    };
    const toggleSelection = (id, checked) => setSelectedIds(current => checked ? [...new Set([...current, id])] : current.filter(item => item !== id));
    const toggleAll = checked => setSelectedIds(current => checked
        ? [...new Set([...current, ...filteredClips.map(clip => clip.id)])]
        : current.filter(id => !filteredClips.some(clip => clip.id === id)));
    const moveSelected = direction => {
        setClips(current => {
            const next = [...current];
            if (direction === 'up') {
                for (let i = 1; i < next.length; i++) if (selectedIds.includes(next[i].id) && !selectedIds.includes(next[i - 1].id)) [next[i - 1], next[i]] = [next[i], next[i - 1]];
            } else {
                for (let i = next.length - 2; i >= 0; i--) if (selectedIds.includes(next[i].id) && !selectedIds.includes(next[i + 1].id)) [next[i + 1], next[i]] = [next[i], next[i + 1]];
            }
            return next;
        });
        setSortState(null);
    };
    const sortClips = key => {
        const ascending = sortState?.key === key ? !sortState.ascending : true;
        setClips(current => [...current].sort((a, b) => {
            let comparison;
            if (key === 'nc') {
                const first = resultById.get(a.id)?.nc.overall, second = resultById.get(b.id)?.nc.overall;
                if (first === undefined || second === undefined) return first === second ? 0 : first === undefined ? 1 : -1;
                comparison = first - second;
            } else if (key === 'duration') comparison = (a.end - a.start) - (b.end - b.start);
            else comparison = String(key === 'fileName' ? a.file.name : a[key]).localeCompare(String(key === 'fileName' ? b.file.name : b[key]), 'ja', { numeric: true });
            return ascending ? comparison : -comparison;
        }));
        setSortState({ key, ascending });
    };
    const rowDragProps = id => ({
        onDragOver: event => { if (dragIdRef.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } },
        onDrop: event => {
            event.preventDefault(); const dragged = dragIdRef.current; dragIdRef.current = null;
            if (!dragged || dragged === id || isProcessing) return;
            setClips(current => { const source = current.find(clip => clip.id === dragged); if (!source) return current;
                const next = current.filter(clip => clip.id !== dragged); next.splice(next.findIndex(clip => clip.id === id), 0, source); return next; });
            setSortState(null);
        }
    });
    const dragHandle = clip => <button type="button" className="nc-icon nc-grip" aria-label={`${clip.name} をドラッグして並び替え`}
        draggable={!isProcessing} disabled={isProcessing} onDragStart={event => { dragIdRef.current = clip.id; event.dataTransfer.setData('text/plain', clip.id); event.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => { dragIdRef.current = null; }}><GripVertical /></button>;
    const addGroup = event => {
        event.preventDefault(); const name = newGroupName.trim();
        if (!name || groups.includes(name)) { setErrorMsg('空でない、重複しないグループ名を入力してください。'); return; }
        setGroups(current => [...current, name]); setNewGroupName(''); setErrorMsg('');
    };
    const renameGroup = (oldName, name) => {
        if (name === oldName) return;
        if (!name || groups.includes(name)) { setErrorMsg('空でない、重複しないグループ名を入力してください。'); return; }
        setGroupBackgroundIds(current => { const next = { ...current, [name]: current[oldName] }; delete next[oldName]; return next; });
        setGroups(current => current.map(group => group === oldName ? name : group));
        setClips(current => current.map(clip => clip.groupName === oldName ? { ...clip, groupName: name } : clip));
        if (groupFilter === oldName) setGroupFilter(name);
        setErrorMsg('');
    };
    const removeGroup = name => {
        if (groups.length <= 1) return;
        const fallback = groups.find(group => group !== name);
        setGroups(current => current.filter(group => group !== name));
        setClips(current => current.map(clip => clip.groupName === name ? { ...clip, groupName: fallback } : clip));
        if (groupFilter === name) setGroupFilter('');
    };

    // 校正音や基準レベルの変更を自動で反映する。古い復号結果は採用しない。
    useEffect(() => {
        const level = Number(calibLevel);
        if (calibrationRef.current.file === calibFile && calibrationRef.current.level === level &&
            (!calibFile || Number.isFinite(calibrationRef.current.offset))) {
            setOffset(calibrationRef.current.offset);
            setCalibrationPending(false);
            return undefined;
        }
        let cancelled = false;
        if (!calibFile) {
            calibrationRef.current = { file: null, level, offset: null };
            setCalibrationPending(false);
            return undefined;
        }
        setCalibrationPending(true);
        if (calibLevel === '' || !Number.isFinite(level)) {
            setErrorMsg('校正基準レベルを数値で入力してください。');
            setCalibrationPending(false);
            return undefined;
        }
        const timer = window.setTimeout(async () => {
            try {
                const value = await calculateCalibrationOffset(calibFile, level);
                if (cancelled) return;
                if (!Number.isFinite(value)) throw new Error('校正値が不正です。');
                calibrationRef.current = { file: calibFile, level, offset: value };
                setOffset(value); setCalibrationPending(false); setErrorMsg('');
            } catch (err) {
                if (!cancelled) { setCalibrationPending(false); setErrorMsg(`校正に失敗しました: ${err.message}`); }
            }
        }, 40);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [calibFile, calibLevel]);

    useEffect(() => () => {
        analysisJobsRef.current.forEach(job => { job.cancelled = true; window.clearTimeout(job.timer); });
        analysisJobsRef.current.clear();
    }, []);

    // 音源・範囲・校正オフセットが一致する結果と実行中の計算は再利用する。
    // ファイル単位のジョブなので、1件の変更で他のファイルのFFTをやり直さない。
    useEffect(() => {
        const jobs = analysisJobsRef.current;
        const currentOffset = offset ?? 100;
        const calibrationReady = !calibrationPending && (!calibFile || (offset !== null &&
            calibrationRef.current.file === calibFile && calibrationRef.current.level === Number(calibLevel)));
        const matches = (entry, clip) => entry && entry.sourceBuffer === clip.buffer &&
            entry.selectedStart === clip.start && entry.selectedEnd === clip.end && entry.offset === currentOffset;
        const clipsById = new Map(clips.map(clip => [clip.id, clip]));
        for (const [id, job] of jobs) {
            const clip = clipsById.get(id);
            if (!calibrationReady || !clip || !matches(job, clip)) {
                job.cancelled = true; window.clearTimeout(job.timer); jobs.delete(id);
            }
        }
        if (calibrationReady) {
            const byId = new Map(rawResults.map(result => [result.id, result]));
            for (const clip of clips) {
                if (matches(byId.get(clip.id), clip) || jobs.has(clip.id)) continue;
                const job = { sourceBuffer: clip.buffer, selectedStart: clip.start, selectedEnd: clip.end,
                    offset: currentOffset, cancelled: false, timer: null };
                // 連続ドラッグを40msずつまとめる。新しい条件が来たらそのジョブだけ置き換える。
                job.timer = window.setTimeout(async () => {
                    try {
                        const buffer = createSelectedBuffer(clip.buffer, clip.start, clip.end);
                        const levels = await analyzeAudio(buffer, currentOffset, () => job.cancelled);
                        if (job.cancelled) return;
                        setRawResults(current => [...current.filter(item => item.id !== clip.id),
                            { id: clip.id, sourceBuffer: clip.buffer, levels, buffer,
                                selectedStart: clip.start, selectedEnd: clip.end, offset: currentOffset }]);
                        setErrorMsg(current => current.startsWith('自動解析に失敗しました:') ? '' : current);
                    } catch (err) {
                        if (!job.cancelled) setErrorMsg(`自動解析に失敗しました: ${clip.file.name} / ${clip.name}: ${err.message}`);
                    } finally {
                        if (jobs.get(clip.id) === job) {
                            jobs.delete(clip.id);
                            setPendingAnalysisIds([...jobs.keys()]);
                        }
                    }
                }, 40);
                jobs.set(clip.id, job);
            }
        }
        setPendingAnalysisIds([...jobs.keys()]);
        // rawResults の各完了ではジョブを再作成しない。上の入力が変わった時だけ照合する。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clips, offset, calibFile, calibLevel, calibrationPending]);

    const downloadResultWav = result => downloadBlob(createTrimmedWav(result.buffer, 0, result.buffer.duration, result.playbackGainPercent / 100),
        `${getOutputBaseName(result.sourceFileName, result.clipName, result.useClipNameOnly)}.wav`);
    const downloadAllFiles = async () => {
        setIsProcessing(true); setErrorMsg('');
        try {
            const entries = [], paths = new Set();
            validResults.forEach(result => {
                const base = getOutputBaseName(result.sourceFileName, result.clipName, useClipNameOnly);
                entries.push({ name: createUniquePath(`${base}.csv`, paths), data: `\uFEFF${createLpeqCsv(result.levels)}` });
                entries.push({ name: createUniquePath(`${base}.wav`, paths), data: createTrimmedWav(result.buffer, 0, result.buffer.duration, result.playbackGainPercent / 100) });
            });
            downloadBlob(await createZipBlob(entries), 'NC解析結果.zip');
        } catch (err) { setErrorMsg(`一括出力に失敗しました: ${err.message}`); }
        finally { setIsProcessing(false); }
    };
    const exportIndexProject = () => {
        const name = projectName.trim() || 'WAV解析';
        // プロジェクト追加読込ではindex.htmlの全体補正モードが維持される。
        // 暗騒音は比較用のデータとして含め、読込先で差し引きが発生しないようにする。
        const exportItem = (result, group, reference = false, id = result.id) => ({
            id, fileName: getCsvFileName(result.sourceFileName, result.clipName, useClipNameOnly),
            legendName: result.clipName + (reference ? '（暗騒音）' : ''), groupName: group,
            isVisible: reference || result.isVisible, isOriginalThird: false, isBackgroundNoiseReference: reference,
            rawFreqs: [...FREQUENCIES], rawValues: result.levels, rawText: createLpeqCsv(result.levels)
        });
        const exportItems = validResults.map(result => exportItem(result, result.groupName, result.isBackground));
        groups.forEach((group, index) => {
            const clip = backgroundForGroup(group), result = clip && resultById.get(clip.id);
            if (result && !result.isUpdating && !exportItems.some(item => item.id === result.id && item.groupName === group)) {
                exportItems.push(exportItem(result, group, true, `${result.id}-background-${index}`));
            }
        });
        const data = {
            version: '1.4', projects: [name], selectedProject: name, visibleProjects: [name], groups,
            groupProjects: Object.fromEntries(groups.map(group => [group, name])),
            dataItems: exportItems,
            bgNoiseData: {}, addNoiseData: {}, bgNoiseMode: 'overlay', addNoiseMode: 'none', bgCorrectionMethod: 'energy',
            groupOctaveModes: Object.fromEntries(groups.map(group => [group, '1/1'])),
            visibleNcCurves, lineWidth, pointSize, yAxisMaxAuto, yAxisMaxManual
        };
        downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `NC_Project_${sanitizeFileName(name)}.json`);
        setSaveStatus(`index.html 用に解析済みの ${validResults.length} 件を書き出しました。`);
    };

    const buildProjectBlob = async () => {
        const entries = [], paths = new Set(), filePaths = new Map();
        const addAudio = (file, folder) => {
            if (!file) return null;
            if (filePaths.has(file)) return filePaths.get(file);
            const path = createUniquePath(`${folder}/${sanitizeFileName(file.name, 'audio.wav')}`, paths);
            entries.push({ name: path, data: file }); filePaths.set(file, path); return path;
        };
        const savedClips = clips.map(clip => {
            const result = resultById.get(clip.id);
            return { id: clip.id, name: clip.name, groupName: clip.groupName, color: clip.color, isVisible: clip.isVisible,
                start: clip.start, end: clip.end, audioFile: addAudio(clip.file, 'audio'), sourceFileName: clip.file.name,
                playbackGainPercent: clip.playbackGainPercent, spectrogramGain: clip.spectrogramGain,
                result: result && !result.isUpdating ? { levels: result.unadjustedLevels, offset: result.offset } : null };
        });
        entries.push({ name: 'project.json', data: JSON.stringify({
            format: 'nc-analyzer-project', version: 1, createdAt: new Date().toISOString(), name: projectName, groups,
            background: { mode: backgroundMode, sharedId: clips.some(clip => clip.id === sharedBackgroundId) ? sharedBackgroundId : null, groupIds: Object.fromEntries(groups.map(group => [group, clips.find(clip => clip.id === groupBackgroundIds[group] && clip.groupName === group)?.id || null])) },
            output: { useClipNameOnly },
            analysis: { octaveBand: '1/1', frequencies: FREQUENCIES, fftSize: 8192, overlap: 4096 },
            calibration: { referenceLevel: Number(calibLevel), offset, audioFile: addAudio(calibFile, 'calibration'), sourceFileName: calibFile?.name || null },
            display: { allPlaybackGainPercent, allSpectrogramGain, spectrogramZoom, spectrogramHeight, spectrogramFrequencies,
                lineWidth, pointSize, yAxisMaxAuto, yAxisMaxManual, visibleNcCurves, viewMode, resultView },
            clips: savedClips
        }, null, 2) });
        return createZipBlob(entries);
    };
    const saveProject = async mode => {
        if (isProcessing || !canSaveProject) return;
        let handle = mode === 'overwrite' ? projectFileHandle : null;
        setErrorMsg('');
        try {
            // ファイル選択・権限要求はユーザー操作から直接呼び出す。
            if (mode !== 'download' && window.showSaveFilePicker) {
                if (!handle) handle = await window.showSaveFilePicker({ suggestedName: projectFileName,
                    types: [{ description: 'NC解析プロジェクト', accept: { 'application/zip': ['.nca'] } }] });
                if (handle.queryPermission && await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
                    if (!handle.requestPermission || await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('保存先ファイルへの書き込み権限がありません。');
                }
            }
            setIsProcessing(true);
            const blob = await buildProjectBlob();
            if (handle) {
                const writable = await handle.createWritable();
                try { await writable.write(blob); await writable.close(); }
                catch (err) { try { await writable.abort(); } catch (_) { /* already closed */ } throw err; }
                setProjectFileHandle(handle); setProjectFileName(handle.name); setIsDirty(false);
                setSaveStatus(`${mode === 'overwrite' ? '上書き保存しました' : '保存先を設定して保存しました'}: ${handle.name}（${new Date().toLocaleTimeString()}）`);
            } else {
                downloadBlob(blob, projectFileName);
                if (!projectFileHandle) setIsDirty(false);
                setSaveStatus(mode === 'download' ? 'NCAをダウンロードしました。' : 'このブラウザーは直接の上書き保存に非対応です。NCAをダウンロードしました。');
            }
        } catch (err) {
            if (err.name !== 'AbortError') { setErrorMsg(`NCAの保存に失敗しました: ${err.message}`); setSaveStatus('保存できませんでした。内容は画面に残っています。'); }
        } finally { setIsProcessing(false); }
    };
    const loadProject = async (file, handle = null) => {
        if (!file || isProcessing) return;
        setIsProcessing(true); setErrorMsg('');
        try {
            const entries = await readZipEntries(file), json = entries.get('project.json');
            if (!json) throw new Error('project.json が含まれていません。');
            const settings = JSON.parse(new TextDecoder().decode(json));
            if (settings.format !== 'nc-analyzer-project' || settings.version !== 1 || !Array.isArray(settings.clips)) throw new Error('対応していないNCA形式です。');
            const assets = new Map();
            const loadAsset = async (path, sourceFileName) => {
                if (!path || typeof path !== 'string' || !entries.has(path)) throw new Error(`WAVファイルが見つかりません: ${path || '(未設定)'}`);
                if (!assets.has(path)) {
                    assets.set(path, (async () => { const audioFile = new File([entries.get(path)], sourceFileName || path.split('/').pop(), { type: 'audio/wav' });
                        return { file: audioFile, buffer: await decodeFile(audioFile) }; })());
                }
                return assets.get(path);
            };
            const importedGroups = [...new Set([
                ...(Array.isArray(settings.groups) ? settings.groups : []),
                ...settings.clips.map(clip => clip.groupName || 'Group 1')
            ])];
            if (!importedGroups.length) importedGroups.push('Group 1');
            if (importedGroups.some(name => typeof name !== 'string' || !name.trim())) throw new Error('グループ名が不正です。');
            const append = projectImportMode === 'append', nextGroups = append ? [...groups] : [], groupMap = new Map();
            for (const name of importedGroups) {
                let unique = name, index = 2;
                while (nextGroups.includes(unique)) unique = `${name} (${index++})`;
                nextGroups.push(unique); groupMap.set(name, unique);
            }
            const calibration = settings.calibration || {}, display = settings.display || {};
            const reference = Number(calibration.referenceLevel);
            const restoredOffset = calibration.offset != null && Number.isFinite(Number(calibration.offset)) ? Number(calibration.offset) : null;
            const effectiveOffset = (append ? offset : restoredOffset) ?? 100;
            const restoredClips = [], restoredResults = [], restoredIds = new Map();
            for (const [index, saved] of settings.clips.entries()) {
                const asset = await loadAsset(saved.audioFile, saved.sourceFileName);
                const start = Number(saved.start), end = Number(saved.end);
                if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > asset.buffer.duration + 0.001) throw new Error(`解析範囲 ${index + 1} が不正です。`);
                const clip = { id: newId(), ...asset, name: typeof saved.name === 'string' ? saved.name : `切り抜き${index + 1}`,
                    groupName: groupMap.get(saved.groupName || 'Group 1'), start, end: Math.min(end, asset.buffer.duration), isVisible: saved.isVisible !== false,
                    color: /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color : SERIES_COLORS[((append ? clips.length : 0) + index) % SERIES_COLORS.length],
                    playbackGainPercent: append ? allPlaybackGainPercent : clampSetting(saved.playbackGainPercent ?? display.allPlaybackGainPercent, 0, 10000, 100),
                    spectrogramGain: append ? allSpectrogramGain : clampSetting(saved.spectrogramGain ?? display.allSpectrogramGain, 1, 100, 1) };
                if (typeof saved.id === 'string') restoredIds.set(saved.id, clip.id);
                restoredClips.push(clip);
                if (Array.isArray(saved.result?.levels) && saved.result.levels.length === 8 && saved.result.levels.every(Number.isFinite) && saved.result.offset === effectiveOffset) {
                    restoredResults.push({ id: clip.id, sourceBuffer: clip.buffer, levels: saved.result.levels, offset: effectiveOffset,
                        buffer: createSelectedBuffer(clip.buffer, clip.start, clip.end), selectedStart: clip.start, selectedEnd: clip.end });
                }
            }
            const calibrationAsset = !append && calibration.audioFile ? await loadAsset(calibration.audioFile, calibration.sourceFileName) : null;
            const importedBackgrounds = Object.fromEntries(importedGroups.map(group => {
                const id = restoredIds.get(settings.background?.groupIds?.[group]);
                return [groupMap.get(group), restoredClips.find(clip => clip.id === id && clip.groupName === groupMap.get(group))?.id || null];
            }).filter(([, id]) => id));
            // すべての検証と音声の復号が終わるまで、現在のワークスペースを変更しない。
            if (append) {
                setGroupBackgroundIds(current => ({ ...current, ...importedBackgrounds }));
                setClips(current => [...current, ...restoredClips]); setRawResults(current => [...current, ...restoredResults]);
                setGroups(nextGroups); setSaveStatus(`${file.name} から ${restoredClips.length} 件を追加しました。現在の校正・保存先は維持しています。`);
            } else {
                skipDirtyRef.current = true;
                setBackgroundMode(settings.background?.mode === 'group' ? 'group' : 'shared');
                setSharedBackgroundId(restoredIds.get(settings.background?.sharedId) || null);
                setGroupBackgroundIds(importedBackgrounds);
                calibrationRef.current = { file: calibrationAsset?.file || null, level: Number.isFinite(reference) ? reference : 94, offset: restoredOffset };
                setCalibrationPending(false);
                setClips(restoredClips); setRawResults(restoredResults); setGroups(nextGroups); setSelectedIds([]);
                setCalibFile(calibrationAsset?.file || null); setCalibLevel(Number.isFinite(reference) ? reference : 94); setOffset(restoredOffset);
                setUseClipNameOnly(Boolean(settings.output?.useClipNameOnly));
                setProjectName(typeof settings.name === 'string' ? settings.name : file.name.replace(/\.nca$/i, ''));
                setAllPlaybackGainPercent(clampSetting(display.allPlaybackGainPercent, 0, 10000, 100));
                setAllSpectrogramGain(clampSetting(display.allSpectrogramGain, 1, 100, 1));
                setSpectrogramZoom(clampSetting(display.spectrogramZoom, 1, 8, 1)); setSpectrogramHeight(clampSetting(display.spectrogramHeight, 100, 360, 140));
                const frequencyMax = clampSetting(display.spectrogramFrequencies?.max, 2, 24000, 1000);
                setSpectrogramFrequencies({ min: clampSetting(display.spectrogramFrequencies?.min, 1, frequencyMax - 1, Math.min(100, frequencyMax - 1)), max: frequencyMax });
                setLineWidth(clampSetting(display.lineWidth, 1, 8, 2)); setPointSize(clampSetting(display.pointSize, 0, 8, 3));
                setYAxisMaxAuto(display.yAxisMaxAuto !== false); setYAxisMaxManual(clampSetting(display.yAxisMaxManual, 10, 200, 100));
                setVisibleNcCurves(Array.isArray(display.visibleNcCurves) ? [...new Set(display.visibleNcCurves.filter(nc => Number.isInteger(nc) && nc >= 15 && nc <= 70))] : [20, 30, 40, 50, 60]);
                setViewMode(display.viewMode === 'spectrogram' ? 'spectrogram' : 'table'); setResultView(display.resultView === 'group' ? 'group' : 'individual');
                setGroupFilter(''); setSearch(''); setMonitorTarget('all');
                setProjectFileHandle(handle); setProjectFileName(file.name); setIsDirty(false);
                setSaveStatus(handle ? `${file.name} を読み込み、上書き保存先に設定しました。` : `${file.name} を読み込みました。上書きする場合は保存先を指定してください。`);
            }
            setSortState(null);
        } catch (err) { setErrorMsg(`NCAを読み込めませんでした: ${err instanceof SyntaxError ? 'project.json の形式が不正です。' : err.message}`); }
        finally { setIsProcessing(false); }
    };
    const openProject = async () => {
        if (!window.showOpenFilePicker) { projectInputRef.current?.click(); return; }
        try {
            const [handle] = await window.showOpenFilePicker({ types: [{ description: 'NC解析プロジェクト', accept: { 'application/zip': ['.nca'] } }], multiple: false });
            if (handle) await loadProject(await handle.getFile(), projectImportMode === 'replace' ? handle : null);
        } catch (err) { if (err.name !== 'AbortError') setErrorMsg(`NCAを開けませんでした: ${err.message}`); }
    };

    const sortLabel = (key, label) => <button type="button" disabled={isProcessing} onClick={() => sortClips(key)}>{label}{sortState?.key === key ? sortState.ascending ? ' ↑' : ' ↓' : ' ↕'}</button>;
    const groupSelect = clip => <select aria-label={`${clip.name} のグループ`} value={clip.groupName} disabled={isProcessing} onChange={event => updateClip(clip.id, { groupName: event.target.value })}>
        {groups.map(group => <option key={group}>{group}</option>)}</select>;
    const nameInput = clip => <input type="text" aria-label={`${clip.file.name} の表示名`} value={clip.name} disabled={isProcessing} onChange={event => updateClip(clip.id, { name: event.target.value })} />;
    const selectClip = clip => <input type="checkbox" aria-label={`${clip.name} を選択`} checked={selectedIds.includes(clip.id)} disabled={isProcessing} onChange={event => toggleSelection(clip.id, event.target.checked)} />;
    const visibleClip = clip => <input type="checkbox" aria-label={`${clip.name} のグラフを表示`} checked={clip.isVisible} disabled={isProcessing} onChange={event => updateClip(clip.id, { isVisible: event.target.checked })} />;

    return <div className="nc-app">
        <style>{workspaceStyles}</style>
        <header className="nc-header">
            <div className="nc-header-title"><div className="nc-header-logo"><Activity /></div><div>
                <h1>NC値 アナライザー</h1><p className="nc-muted">WAVを読み込み、範囲を選んで、音の特性を比較。</p>
            </div></div>
            <div className="nc-row nc-header-status"><span className="nc-badge">{clips.length} ファイル / 範囲</span><span className="nc-badge nc-count" role="status" aria-label="解析状況">{calibrationPending ? '校正中…' : isAnalyzing ? `${pendingAnalysisIds.length} 件を更新中…` : `${validResults.length} 解析済み`}</span>
                <span className="nc-muted">{isDirty ? '● 未保存の変更' : '変更はありません'}</span></div>
        </header>
        {errorMsg && <div role="alert" className="nc-alert"><AlertCircle /><span style={{ flex: 1 }}>{errorMsg}</span><button type="button" className="nc-icon" aria-label="エラーを閉じる" onClick={() => setErrorMsg('')}>×</button></div>}
        <fieldset disabled={isProcessing} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="nc-grid" aria-busy={isProcessing || isAnalyzing || calibrationPending}>
            <aside className="nc-sidebar nc-column nc-stack" aria-label="読み込み・設定">
                <section className="nc-card"><div className="nc-card-body nc-stack">
                    <h2 className="nc-section-label"><FolderOpen />プロジェクト</h2>
                    <label className="nc-field">プロジェクト名<input value={projectName} onChange={event => setProjectName(event.target.value)} /></label>
                    <fieldset style={{ border: 0, margin: 0, padding: 0 }}><legend className="nc-muted" style={{ marginBottom: 5 }}>NCAの読み込み方法</legend>
                        <div className="nc-row"><label><input type="radio" name="projectImportMode" checked={projectImportMode === 'replace'} onChange={() => setProjectImportMode('replace')} /> 上書き</label>
                            <label><input type="radio" name="projectImportMode" checked={projectImportMode === 'append'} onChange={() => setProjectImportMode('append')} /> 追加</label></div>
                    </fieldset>
                    <button type="button" className="nc-full" onClick={openProject}><FolderOpen />NCAを読み込む</button>
                    <input ref={projectInputRef} type="file" aria-label="NCAファイル" accept=".nca" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) loadProject(file); }} />
                    <p className="nc-muted">{projectImportMode === 'replace' ? '現在のファイル・校正・設定を置き換えます。' : 'ファイルを追加します。現在の校正・保存先は維持します。同名グループは別グループとして追加します。'}</p>
                    <div className="nc-pair"><button type="button" onClick={() => saveProject('download')} disabled={(!clips.length && !calibFile) || !canSaveProject}><Download />NCA出力</button>
                        <button type="button" onClick={() => saveProject('as')} disabled={(!clips.length && !calibFile) || !canSaveProject}>別名で保存</button></div>
                    <button type="button" className="nc-primary nc-full" onClick={() => saveProject('overwrite')} disabled={(!clips.length && !calibFile) || !canSaveProject}><Save />上書き保存</button>
                    <div className="nc-muted" aria-live="polite"><p style={{ overflowWrap: 'anywhere' }}>{projectFileHandle ? `上書き先: ${projectFileName}` : '上書き先: 未設定'}</p>{saveStatus && <p role="status" aria-label="保存状況">{saveStatus}</p>}</div>
                    <p className="nc-muted">NCAには元のWAV・校正音・範囲・解析結果・グループ・表示設定を保存します。</p>
                </div></section>
                <section className="nc-card"><div className="nc-card-body nc-stack">
                    <h2 className="nc-section-label"><Settings2 />1. 校正音の設定</h2>
                    <FileDropZone label="校正音WAVを読み込む" hint="ドロップ / クリックして選択" accept=".wav,audio/wav" disabled={isProcessing} onFiles={handleCalibFiles} />
                    {calibFile && <div className="nc-row nc-between"><span className="nc-file-label">{calibFile.name}</span><button type="button" className="nc-icon" aria-label="校正音を削除" onClick={() => { setCalibFile(null); invalidateCalibration(false); setErrorMsg(''); }}><Trash2 /></button></div>}
                    <label className="nc-field">校正基準レベル (dB)<input type="number" step="0.1" value={calibLevel} onChange={event => { setCalibLevel(event.target.value); invalidateCalibration(); }} /></label>
                    {calibrationPending ? <div className="nc-note"><Activity /><span>校正音を解析中…</span></div> : offset !== null ? <div className="nc-note nc-success"><CheckCircle2 /><span>校正済み / {offset.toFixed(2)} dB</span></div> : <div className="nc-note"><Info /><span>未校正の結果は相対的な参考値です。正確な音圧レベルには校正が必要です。</span></div>}
                </div></section>
                <section className="nc-card"><div className="nc-card-body nc-stack">
                    <h2 className="nc-section-label"><Upload />2. 解析対象の読み込み</h2>
                    <FileDropZone label="解析対象WAVを読み込む" hint="複数ファイルをドロップ / クリックして選択" accept=".wav,audio/wav" multiple disabled={isProcessing} onFiles={handleMeasFiles} />
                    <div className="nc-note" role="status" aria-label="自動解析の状態"><Activity /><span>{isProcessing ? 'ファイルを処理中…' : calibrationPending ? '校正が終わると自動で再解析します。' : isAnalyzing ? `${pendingAnalysisIds.length} 件の解析結果を更新中…` : '自動解析オン / 変更した範囲だけ更新します。'}</span></div>
                    <p className="nc-muted">WAVは「{groups[0]}」にまとめて読み込み、自動解析します。グループは別で作成し、表でセル範囲を選択して後から割り当ててください。</p>
                </div></section>
                <section className="nc-card"><div className="nc-card-body nc-stack">
                    <h2 className="nc-section-label"><List />グループ設定</h2>
                    <form onSubmit={addGroup} className="nc-row"><input aria-label="新規グループ名" placeholder="新規グループ名" value={newGroupName} onChange={event => setNewGroupName(event.target.value)} style={{ flex: 1 }} /><button type="submit" className="nc-icon" aria-label="グループを追加"><Plus /></button></form>
                    {groups.map(group => <div key={group} className="nc-group-entry"><GroupNameField name={group} disabled={isProcessing} onRename={name => renameGroup(group, name)} />
                        <span className="nc-badge">{clips.filter(clip => clip.groupName === group).length}</span><button type="button" className="nc-icon nc-danger" aria-label={`${group} グループを削除`} disabled={groups.length <= 1} onClick={() => removeGroup(group)}><Trash2 /></button></div>)}
                    <p className="nc-muted">グループはここで作成し、表のドラッグ選択・右クリックでファイルを割り当てます。名前はEnterで確定。削除時は先頭のグループへ移動します。</p>
                </div></section>
                <section className="nc-card"><div className="nc-card-body nc-stack">
                    <h2 className="nc-section-label"><Settings2 />暗騒音の参照表示</h2>
                    <label className="nc-row"><input type="checkbox" checked={backgroundMode === 'shared'} onChange={event => changeBackgroundMode(event.target.checked)} />すべてのグループで共通の暗騒音を使用</label>
                    <p className="nc-muted">表の「暗騒音」で指定します。共通使用では全体で1件、個別使用では各グループで1件です。別のファイルを選ぶと置き換えます。選択範囲の未増幅の解析値を、各グループと個別結果のグラフに灰色の破線で重ねて表示します。</p>
                    {groups.map(group => <p key={group} className="nc-muted">{group}: {backgroundForGroup(group)?.name || '未設定'}</p>)}
                    <p className="nc-muted">測定値・NC値から暗騒音を差し引きません。CSV・WAVも暗騒音による補正は行いません。</p>
                    <h2 className="nc-section-label"><AudioLines />再生・スペクトログラム</h2>
                    <label className="nc-field">音量・感度の適用先<select value={monitoringClip ? monitorTarget : 'all'} onChange={event => setMonitorTarget(event.target.value)}><option value="all">全ファイル（新規読み込みの既定値）</option>{clips.map(clip => <option key={clip.id} value={clip.id}>{clip.name}</option>)}</select></label>
                    <label className="nc-field"><span className="nc-row nc-between">再生音量<output>{monitoringClip?.playbackGainPercent ?? allPlaybackGainPercent}%</output></span><input aria-label="再生音量" type="range" min="0" max="10000" step="10" value={monitoringClip?.playbackGainPercent ?? allPlaybackGainPercent} onChange={event => updateMonitoring('playbackGainPercent', Number(event.target.value))} /></label>
                    <label className="nc-field"><span className="nc-row nc-between">スペクトログラム感度<output>{monitoringClip?.spectrogramGain ?? allSpectrogramGain}倍</output></span><input aria-label="スペクトログラム感度" type="range" min="1" max="100" value={monitoringClip?.spectrogramGain ?? allSpectrogramGain} onChange={event => updateMonitoring('spectrogramGain', Number(event.target.value))} /></label>
                    <label className="nc-field"><span className="nc-row nc-between">時間軸の拡大<output>{spectrogramZoom}倍</output></span><input aria-label="時間軸の拡大" type="range" min="1" max="8" step="0.5" value={spectrogramZoom} onChange={event => setSpectrogramZoom(Number(event.target.value))} /></label>
                    <label className="nc-field"><span className="nc-row nc-between">スペクトログラムの高さ<output>{spectrogramHeight}px</output></span><input aria-label="スペクトログラムの高さ" type="range" min="100" max="360" step="10" value={spectrogramHeight} onChange={event => setSpectrogramHeight(Number(event.target.value))} /></label>
                    <div className="nc-pair">
                        <label className="nc-field">最低周波数 (Hz)<input type="number" min="1" max={spectrogramFrequencies.max - 1} value={spectrogramFrequencies.min} onChange={event => setSpectrogramFrequencies(current => ({ ...current, min: clampSetting(event.target.value, 1, current.max - 1, 100) }))} /></label>
                        <label className="nc-field">最高周波数 (Hz)<input type="number" min={spectrogramFrequencies.min + 1} max="24000" value={spectrogramFrequencies.max} onChange={event => setSpectrogramFrequencies(current => ({ ...current, max: clampSetting(event.target.value, current.min + 1, 24000, 1000) }))} /></label>
                    </div>
                    <p className="nc-muted">黄色の端をドラッグして範囲を選択。拡大時は横にスクロールできます。縦軸は設定した周波数の対数軸です（音源のナイキスト周波数まで）。再生音量は100倍（10000%）まで設定でき、切り抜きWAVにも適用します。PCMの上限を超えた波形はクリップされます。NC解析値は変わりません。</p>
                </div></section>
                <section className="nc-card"><div className="nc-card-body nc-stack">
                    <h2 className="nc-section-label"><BarChart3 />グラフ・出力設定</h2>
                    <label className="nc-field"><span className="nc-row nc-between">線の太さ<output>{lineWidth}</output></span><input aria-label="線の太さ" type="range" min="1" max="8" value={lineWidth} onChange={event => setLineWidth(Number(event.target.value))} /></label>
                    <label className="nc-field"><span className="nc-row nc-between">プロットの大きさ<output>{pointSize}</output></span><input aria-label="プロットの大きさ" type="range" min="0" max="8" value={pointSize} onChange={event => setPointSize(Number(event.target.value))} /></label>
                    <label className="nc-row nc-muted"><input type="checkbox" checked={yAxisMaxAuto} onChange={event => setYAxisMaxAuto(event.target.checked)} />Y軸の最大値を自動設定</label>
                    {!yAxisMaxAuto && <label className="nc-field">Y軸の最大値 (dB)<input type="number" min="10" max="200" value={yAxisMaxManual} onChange={event => setYAxisMaxManual(clampSetting(event.target.value, 10, 200, 100))} /></label>}
                    <div><p className="nc-muted" style={{ marginBottom: 6 }}>表示するNC曲線</p><div className="nc-nc-curves">{ncBase.map(({ nc }) => <label key={nc}><input type="checkbox" checked={visibleNcCurves.includes(nc)} onChange={event => setVisibleNcCurves(current => event.target.checked ? [...current, nc].sort((a, b) => a - b) : current.filter(value => value !== nc))} />{nc}</label>)}</div></div>
                    <label className="nc-row nc-muted"><input type="checkbox" checked={useClipNameOnly} onChange={event => setUseClipNameOnly(event.target.checked)} />出力名に表示名だけを使う</label>
                    <button type="button" onClick={exportIndexProject} disabled={!canExportResults}><Download />index.html 用プロジェクト出力</button>
                    <p className="nc-muted">JSONを index.html の「プロジェクト読込」で読み込めます。解析済み {validResults.length} 件が対象です。{clips.length > validResults.length && `更新待ちの ${clips.length - validResults.length} 件は含まれません。`}</p>
                    <button type="button" onClick={downloadAllFiles} disabled={!canExportResults}><Download />CSV＋切り抜きWAVをZIP出力</button>
                </div></section>
            </aside>

            <section className="nc-center nc-column nc-card" tabIndex={-1} aria-label="解析ファイル一覧" onKeyDown={event => {
                if (event.key === 'Escape' && !event.defaultPrevented && !event.target.closest('input,select,textarea')) {
                    setSelectedIds([]);
                }
            }}>
                <div className="nc-sticky-head"><div className="nc-card-head"><h2><List />解析ファイル一覧 <span className="nc-badge nc-count">{clips.length}</span></h2></div>
                    <div className="nc-toolbar">
                        <div className="nc-row nc-between"><div className="nc-segment" role="group" aria-label="ファイル一覧の表示方法"><button type="button" aria-pressed={viewMode === 'table'} onClick={() => setViewMode('table')}><List />表形式</button><button type="button" aria-pressed={viewMode === 'spectrogram'} onClick={() => setViewMode('spectrogram')}><AudioLines />スペクトログラム</button></div></div>
                        <div className="nc-row"><div className="nc-search"><Search /><input aria-label="ファイルを検索" placeholder="ファイル名・表示名で検索" value={search} onChange={event => setSearch(event.target.value)} /></div>
                            <select aria-label="グループで絞り込み" style={{ flex: '0 1 130px' }} value={groupFilter} onChange={event => setGroupFilter(event.target.value)}><option value="">全グループ</option>{groups.map(group => <option key={group}>{group}</option>)}</select></div>
                        <div className="nc-row nc-between"><label className="nc-row nc-muted"><SelectAllCheckbox clips={filteredClips} selectedIds={selectedIds} disabled={isProcessing} onChange={toggleAll} />全選択 <b>{selectedCount}件選択中</b></label>
                            <div className="nc-row"><button type="button" aria-label="選択ファイルを上へ" className="nc-icon" disabled={!selectedCount} onClick={() => moveSelected('up')}><ArrowUp /></button><button type="button" aria-label="選択ファイルを下へ" className="nc-icon" disabled={!selectedCount} onClick={() => moveSelected('down')}><ArrowDown /></button>
                                <button type="button" className="nc-danger" disabled={!selectedCount} onClick={() => { if (window.confirm(`選択した ${selectedCount} 件の解析範囲を削除しますか？`)) removeClips(selectedIds); }}><Trash2 />削除</button></div></div>
                        {viewMode === 'spectrogram' && <div className="nc-row nc-muted"><span>並び替え:</span>{sortLabel('name', '表示名')}{sortLabel('groupName', 'グループ')}{sortLabel('duration', '範囲長')}{sortLabel('nc', 'NC')}</div>}
                    </div>
                </div>
                {!filteredClips.length ? <div className="nc-empty"><AudioLines /><strong>{clips.length ? '該当するファイルがありません' : '解析するWAVを追加'}</strong><p className="nc-muted">{clips.length ? '検索やグループの絞り込みを変更してください。' : '左側にWAVをドロップすると、ここに一覧が表示されます。'}</p></div> : viewMode === 'table' ? <AnalysisTable clips={filteredClips} groups={groups} selectedIds={selectedIds} setSelectedIds={setSelectedIds}
                    resultById={resultById} pendingIds={pendingAnalysisIds} calibrationPending={calibrationPending} disabled={isProcessing}
                    onApplyEdits={applyTableEdits} onRemove={removeClips} onDuplicate={duplicateClip} onSort={sortLabel} dragHandle={dragHandle} rowDragProps={rowDragProps} isBackground={isBackground} onBackgroundChange={setBackground} /> : <div className="nc-editor-list">{filteredClips.map(clip => <article key={clip.id} data-clip-id={clip.id} className={`nc-editor-card ${selectedIds.includes(clip.id) ? 'nc-selected' : ''}`} {...rowDragProps(clip.id)}>
                    <div className="nc-editor-head nc-stack"><div className="nc-row">{dragHandle(clip)}{selectClip(clip)}{nameInput(clip)}
                        <button type="button" className="nc-icon" aria-label={`${clip.name} の範囲を複製`} onClick={() => duplicateClip(clip.id)}><Copy /></button>
                        <button type="button" className="nc-icon nc-danger" aria-label={`${clip.name} を削除`} onClick={() => removeClips([clip.id])}><Trash2 /></button></div>
                        <div className="nc-row nc-between"><span className="nc-file-label">{clip.file.name}</span>{groupSelect(clip)}<label className="nc-row nc-muted">{visibleClip(clip)}グラフ表示</label><label className="nc-row nc-muted"><input type="checkbox" aria-label={`${clip.name} を暗騒音に指定`} checked={isBackground(clip)} onChange={event => setBackground(clip, event.target.checked)} />暗騒音</label></div></div>
                    <SpectrogramEditor clip={clip} disabled={isProcessing} zoom={spectrogramZoom} height={spectrogramHeight} frequencyMin={spectrogramFrequencies.min} frequencyMax={spectrogramFrequencies.max} onChange={changes => updateClip(clip.id, changes)} />
                </article>)}</div>}
                {clips.length > 0 && <div className="nc-card-body nc-muted">セルをドラッグで範囲選択。グループ列をダブルクリック、または右クリックで選択行に一括割り当て。Shiftで範囲拡張、Ctrl / ⌘で追加選択、Ctrl+C / Vで表のコピー・貼り付け。並び順は結果・出力にも共通です。</div>}
            </section>

            <section className="nc-results nc-column nc-stack" aria-label="解析結果">
                <div className="nc-card"><div className="nc-card-head"><h2><BarChart3 />解析結果 <span className="nc-badge nc-count">{shownResults.length}</span></h2>
                    <div className="nc-segment" role="group" aria-label="解析結果の表示方法"><button type="button" aria-pressed={resultView === 'individual'} onClick={() => setResultView('individual')}>個別</button><button type="button" aria-pressed={resultView === 'group'} onClick={() => setResultView('group')}>グループ比較</button></div></div>
                    <div className="nc-card-body nc-muted">{offset === null ? '未校正・参考値 / ' : '校正済み / '}1/1オクターブバンド{resultView === 'group' ? '。同じグループの測定値を重ねて比較します。' : '。一覧の順に表示します。'}{results.length < clips.length && ` 更新待ち: ${clips.length - results.length} 件。`}</div>
                </div>
                {!shownResults.length ? <div className="nc-card nc-empty"><BarChart3 /><strong>{results.length ? 'グラフ表示がオフになっています' : '解析結果をここに表示'}</strong><p className="nc-muted">{results.length ? '一覧の「表示」をオンにしてください。' : isAnalyzing || calibrationPending ? '解析結果を更新中です…' : 'WAVを読み込むと、自動で解析結果を表示します。'}</p></div> : resultView === 'group' ? resultGroups.map(group => {
                    const items = chartItemsForGroup(shownResults.filter(result => result.groupName === group), group);
                    return <article key={group} className="nc-result-card" data-result-group={group}>
                        <div className="nc-result-head"><div><h3>{group}</h3><p className="nc-muted">グループ比較 / {items.length} 件</p></div><span className="nc-badge">重ねて表示</span></div>
                        <ResultChart items={items} title={`${group} のNC比較グラフ`} {...chartSettings} />
                        <ul className="nc-legend" aria-label={`${group} の凡例`}>{items.map(result => <li key={result.id} data-legend-id={result.id}><span className="nc-swatch" style={{ borderColor: result.isReference ? '#64748b' : result.color, borderTopStyle: result.isReference ? 'dashed' : 'solid' }} /><span>{result.clipName}{result.isReference ? '（暗騒音）' : ''}</span><b>{result.isUpdating ? '更新中…' : `NC-${formatNC(result.nc.overall)}`}</b></li>)}</ul>
                    </article>;
                }) : shownResults.map(result => <article key={result.id} data-result-id={result.id} data-analysis-state={result.isUpdating ? 'updating' : 'ready'} className="nc-result-card">
                    <div className="nc-result-head"><div><h3>{result.clipName || '(表示名なし)'}</h3><p className="nc-muted">{result.groupName} / {result.sourceFileName}</p>{result.isBackground && <p className="nc-muted">暗騒音（参照表示）</p>}{result.backgroundName && <p className="nc-muted">暗騒音: {result.backgroundName} / 破線で参照表示（差し引きなし）</p>}<p className="nc-muted">{formatTime(result.selectedStart)} – {formatTime(result.selectedEnd)}</p></div><span className="nc-nc">{result.isUpdating ? '更新中…' : `NC-${formatNC(result.nc.overall)}`}</span></div>
                    <ResultChart items={chartItemsForGroup([result], result.groupName)} title={`${result.clipName} のNCグラフ`} {...chartSettings} />
                    <details className="nc-details"><summary>帯域別の測定値とNC値</summary><table><thead><tr><th>周波数 (Hz)</th><th>測定値 (dB)</th><th>NC</th></tr></thead><tbody>{FREQUENCIES.map((frequency, index) => <tr key={frequency}><td>{frequency}</td><td>{result.levels[index].toFixed(1)}</td><td>{formatNC(result.nc.details[index])}</td></tr>)}</tbody></table></details>
                    <div className="nc-result-actions nc-row"><button type="button" disabled={result.isUpdating} onClick={() => downloadResultCsv(result)}><Download />CSV</button><button type="button" disabled={result.isUpdating} onClick={() => downloadResultWav(result)}><Download />切り抜きWAV</button></div>
                </article>)}
            </section>
        </div>
        </fieldset>
    </div>;
}
