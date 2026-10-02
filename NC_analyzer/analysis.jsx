import React, { useEffect, useRef, useState } from 'react';
import { Upload, Download, Settings2, BarChart3, AlertCircle, CheckCircle2, Info, Activity, Copy, Play, Square, Trash2 } from 'lucide-react';

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

// 校正: 全体のRMSを計算し、基準レベルとのオフセットを算出
const calculateCalibrationOffset = async (file, refLevel) => {
    const buffer = await decodeFile(file);
    const data = buffer.getChannelData(0);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
        sumSquares += data[i] * data[i];
    }
    const rms = Math.sqrt(sumSquares / data.length);
    const dbfs = 10 * Math.log10(rms * rms || 1e-10);
    return refLevel - dbfs;
};

// 分析: FFTを用いた1/1オクターブバンド分析
const analyzeAudio = (buffer, offset) => {
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
    const minutes = Math.floor(value / 60);
    const secs = Math.floor(value % 60);
    const millis = Math.floor((value - Math.floor(value)) * 1000);
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
};

const createTrimmedWav = (buffer, startTime, endTime) => {
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
            const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]));
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

const requireJSZip = () => {
    if (!window.JSZip) throw new Error('ZIPライブラリを読み込めませんでした。ページを再読み込みしてください。');
    return window.JSZip;
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
const ResultChart = ({ measuredLevels, ncOverall }) => {
    const width = 600, height = 300;
    const margin = { top: 20, right: 30, bottom: 40, left: 50 };
    const chartW = width - margin.left - margin.right;
    const chartH = height - margin.top - margin.bottom;

    const getX = (idx) => margin.left + (idx / 7) * chartW;
    const getY = (val) => margin.top + chartH - (Math.max(0, Math.min(100, val)) / 100) * chartH;

    const generatePath = (data) => data.map((v, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(v)}`).join(' ');

    let ncCurve = null;
    if (ncOverall >= 15 && ncOverall <= 70) {
        ncCurve = NCTable[ncOverall];
    }

    return (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
            {/* Grid */}
            {[0, 20, 40, 60, 80, 100].map(y => (
                <g key={`y-${y}`}>
                    <line x1={margin.left} y1={getY(y)} x2={width - margin.right} y2={getY(y)} stroke="currentColor" className="text-gray-200 dark:text-gray-700" strokeDasharray="4 4" />
                    <text x={margin.left - 10} y={getY(y) + 4} textAnchor="end" fontSize="11" fill="currentColor" className="text-gray-500">{y}</text>
                </g>
            ))}
            {FREQUENCIES.map((f, i) => (
                <g key={`x-${f}`}>
                    <line x1={getX(i)} y1={margin.top} x2={getX(i)} y2={height - margin.bottom} stroke="currentColor" className="text-gray-100 dark:text-gray-800" />
                    <text x={getX(i)} y={height - margin.bottom + 20} textAnchor="middle" fontSize="11" fill="currentColor" className="text-gray-500">
                        {f >= 1000 ? `${f / 1000}k` : f}
                    </text>
                </g>
            ))}

            {/* NC Curve Reference */}
            {ncCurve && (
                <>
                    <path d={generatePath(ncCurve)} fill="none" stroke="#9ca3af" strokeWidth="2" strokeDasharray="6 4" opacity="0.6" />
                    <text x={width - margin.right - 20} y={getY(ncCurve[7]) - 10} fill="#6b7280" fontSize="12" fontWeight="bold">NC-{ncOverall}</text>
                </>
            )}

            {/* Measured Levels */}
            {measuredLevels && (
                <>
                    <path d={generatePath(measuredLevels)} fill="none" stroke="#3b82f6" strokeWidth="3" />
                    {measuredLevels.map((val, i) => (
                        <circle key={`p-${i}`} cx={getX(i)} cy={getY(val)} r="4" fill="#1d4ed8" className="dark:fill-blue-400" />
                    ))}
                </>
            )}
        </svg>
    );
};

const WaveformEditor = ({ clip, disabled, onChange, onDuplicate, onRemove }) => {
    const canvasRef = useRef(null);
    const sourceRef = useRef(null);
    const animationRef = useRef(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [dragTarget, setDragTarget] = useState(null);
    const [playhead, setPlayhead] = useState(clip.start);

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
        setIsPlaying(false);
    };

    useEffect(() => () => {
        if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
        if (sourceRef.current) {
            sourceRef.current.onended = null;
            try { sourceRef.current.stop(); } catch (_) { /* already stopped */ }
            sourceRef.current.disconnect();
        }
    }, []);

    useEffect(() => {
        if (!isPlaying) setPlayhead(current => Math.max(clip.start, Math.min(current, clip.end)));
    }, [clip.start, clip.end, isPlaying]);

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
            ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, width, height);
            ctx.strokeStyle = '#cbd5e1'; ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
            const samples = clip.buffer.getChannelData(0);
            const step = Math.max(1, Math.ceil(samples.length / width));
            ctx.strokeStyle = '#2563eb'; ctx.beginPath();
            for (let x = 0; x < width; x++) {
                let min = 1; let max = -1;
                const from = Math.floor(x * samples.length / width);
                const to = Math.min(samples.length, from + step);
                for (let i = from; i < to; i++) { min = Math.min(min, samples[i]); max = Math.max(max, samples[i]); }
                ctx.moveTo(x + 0.5, height / 2 - max * height * 0.42);
                ctx.lineTo(x + 0.5, height / 2 - min * height * 0.42);
            }
            ctx.stroke();
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
    }, [clip.buffer, clip.start, clip.end]);

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
        if (!dragTarget) return;
        const time = pointerTime(event);
        onChange(dragTarget === 'start' ? { start: Math.min(time, clip.end - 0.001) } : { end: Math.max(time, clip.start + 0.001) });
    };
    const updateNumericBoundary = (key, rawValue) => {
        const value = Number(rawValue);
        if (!Number.isFinite(value)) return;
        onChange(key === 'start'
            ? { start: Math.max(0, Math.min(value, clip.end - 0.001)) }
            : { end: Math.min(clip.buffer.duration, Math.max(value, clip.start + 0.001)) });
    };
    const playSelection = async () => {
        if (isPlaying) { stopPlayback(); return; }
        const ctx = getAudioContext();
        await ctx.resume();
        const source = ctx.createBufferSource();
        source.buffer = clip.buffer;
        source.connect(ctx.destination);
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
            setPlayhead(clip.end);
            setIsPlaying(false);
        };
        sourceRef.current = source;
        setIsPlaying(true);
        source.start(0, clip.start, clip.end - clip.start);
        animationRef.current = requestAnimationFrame(updatePlayhead);
    };

    return (
        <div className="rounded-lg border border-gray-200 dark:border-gray-600 p-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <input value={clip.name} disabled={disabled} onChange={e => onChange({ name: e.target.value })}
                    aria-label="切り抜き名" className="min-w-0 flex-1 p-2 text-sm font-medium border rounded bg-transparent" />
                <button type="button" onClick={onDuplicate} disabled={disabled} title="同じWAVから切り抜きを追加" className="p-2 border rounded hover:bg-gray-50 dark:hover:bg-gray-700"><Copy className="w-4 h-4" /></button>
                <button type="button" onClick={onRemove} disabled={disabled} title="削除" className="p-2 border border-red-200 text-red-600 rounded hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>
            </div>
            <div className="relative h-28">
                <canvas ref={canvasRef} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
                    onPointerUp={() => setDragTarget(null)} onPointerCancel={() => setDragTarget(null)}
                    className="w-full h-28 rounded border cursor-ew-resize touch-none" aria-label={`${clip.name} の波形範囲選択`} />
                <div className="absolute inset-y-0 w-0.5 bg-red-600 pointer-events-none shadow-sm"
                    style={{ left: `${(playhead / clip.buffer.duration) * 100}%` }} aria-hidden="true" />
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
                <label>IN (秒)<input type="number" min="0" max={clip.end} step="0.001" value={clip.start.toFixed(3)} disabled={disabled}
                    onChange={e => updateNumericBoundary('start', e.target.value)} className="mt-1 w-full p-1.5 border rounded bg-transparent" /></label>
                <label>OUT (秒)<input type="number" min={clip.start} max={clip.buffer.duration} step="0.001" value={clip.end.toFixed(3)} disabled={disabled}
                    onChange={e => updateNumericBoundary('end', e.target.value)} className="mt-1 w-full p-1.5 border rounded bg-transparent" /></label>
            </div>
            <div className="flex items-center justify-between text-xs text-gray-500">
                <span><span className="font-mono text-red-600">{formatTime(playhead)}</span> / {formatTime(clip.end)}（選択 {formatTime(clip.end - clip.start)}）</span>
                <button type="button" onClick={playSelection} className="inline-flex items-center gap-1 px-3 py-1.5 border rounded hover:bg-gray-50 dark:hover:bg-gray-700">
                    {isPlaying ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}{isPlaying ? '停止' : '範囲を再生'}
                </button>
            </div>
        </div>
    );
};


// --- メインアプリケーション ---
export default function App() {
    const projectInputRef = useRef(null);
    const [calibFile, setCalibFile] = useState(null);
    const [calibLevel, setCalibLevel] = useState(94.0);
    const [offset, setOffset] = useState(null);
    
    const [clips, setClips] = useState([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [processingProgress, setProcessingProgress] = useState(null);
    const [errorMsg, setErrorMsg] = useState("");
    
    const [results, setResults] = useState([]);
    const [useClipNameOnly, setUseClipNameOnly] = useState(false);

    const handleCalibFile = (e) => setCalibFile(e.target.files[0]);
    const handleProjectFile = async (event) => {
        const projectFile = event.target.files?.[0];
        if (!projectFile) return;
        setIsProcessing(true);
        setErrorMsg('');
        try {
            const JSZip = requireJSZip();
            const zip = await JSZip.loadAsync(projectFile);
            const settingsEntry = zip.file('project.json');
            if (!settingsEntry) throw new Error('project.json が含まれていないため、プロジェクトを読み込めません。');

            const settings = JSON.parse(await settingsEntry.async('string'));
            if (settings.format !== 'nc-analyzer-project' || settings.version !== 1 || !Array.isArray(settings.clips)) {
                throw new Error('対応していないNCAプロジェクト形式です。');
            }

            // 同じWAVを複数範囲で使う場合も、復号は一度だけ行う。
            const audioAssets = new Map();
            const loadAudioAsset = (path) => {
                if (!path || typeof path !== 'string') throw new Error('WAVファイルの参照が設定されていません。');
                if (!audioAssets.has(path)) {
                    audioAssets.set(path, (async () => {
                        const entry = zip.file(path);
                        if (!entry || entry.dir) throw new Error(`プロジェクト内にWAVファイルがありません: ${path}`);
                        const blob = await entry.async('blob');
                        const fileName = path.split('/').pop() || 'audio.wav';
                        const file = new File([blob], fileName, { type: 'audio/wav' });
                        return { file, buffer: await decodeFile(file) };
                    })());
                }
                return audioAssets.get(path);
            };

            const restoredClips = await Promise.all(settings.clips.map(async (savedClip, index) => {
                const asset = await loadAudioAsset(savedClip.audioFile);
                const start = Math.max(0, Math.min(asset.buffer.duration, Number(savedClip.start)));
                const end = Math.max(0, Math.min(asset.buffer.duration, Number(savedClip.end)));
                if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
                    throw new Error(`切り抜き${index + 1}の解析範囲が不正です。`);
                }
                return {
                    id: `${Date.now()}-${index}-${Math.random()}`,
                    file: asset.file,
                    buffer: asset.buffer,
                    name: typeof savedClip.name === 'string' ? savedClip.name : `切り抜き${index + 1}`,
                    start,
                    end
                };
            }));
            if (restoredClips.length === 0) throw new Error('プロジェクトに解析対象のWAVがありません。');

            const savedCalibration = settings.calibration || {};
            const calibrationAsset = savedCalibration.audioFile
                ? await loadAudioAsset(savedCalibration.audioFile)
                : null;
            const referenceLevel = Number(savedCalibration.referenceLevel);
            const savedOffset = Number(savedCalibration.offset);
            setClips(restoredClips);
            setCalibFile(calibrationAsset?.file || null);
            setCalibLevel(Number.isFinite(referenceLevel) ? referenceLevel : 94);
            setOffset(savedCalibration.offset !== null && Number.isFinite(savedOffset) ? savedOffset : null);
            setUseClipNameOnly(Boolean(settings.output?.useClipNameOnly));
            setResults([]);
        } catch (err) {
            console.error(err);
            setErrorMsg(err instanceof SyntaxError
                ? 'project.jsonが正しいJSON形式ではありません。'
                : (err.message || 'NCAプロジェクトの読み込みに失敗しました。'));
        } finally {
            setIsProcessing(false);
            event.target.value = '';
        }
    };
    const handleMeasFile = async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        setIsProcessing(true);
        setErrorMsg('');
        try {
            const decoded = await Promise.all(files.map(async (file, index) => {
                const buffer = await decodeFile(file);
                return { id: `${Date.now()}-${index}-${Math.random()}`, file, buffer, name: '切り抜き1', start: 0, end: buffer.duration };
            }));
            setClips(decoded);
            setResults([]);
        } catch (err) {
            console.error(err);
            setErrorMsg('WAVファイルを読み込めませんでした。ファイル形式を確認してください。');
        } finally {
            setIsProcessing(false);
            e.target.value = '';
        }
    };

    const updateClip = (id, changes) => {
        setClips(current => current.map(clip => clip.id === id ? { ...clip, ...changes } : clip));
        setResults([]);
    };
    const duplicateClip = (id) => {
        setClips(current => {
            const sourceIndex = current.findIndex(clip => clip.id === id);
            if (sourceIndex < 0) return current;
            const source = current[sourceIndex];
            const sameFileCount = current.filter(clip => clip.file === source.file).length;
            const copy = { ...source, id: `${Date.now()}-${Math.random()}`, name: `切り抜き${sameFileCount + 1}` };
            return [...current.slice(0, sourceIndex + 1), copy, ...current.slice(sourceIndex + 1)];
        });
        setResults([]);
    };
    const removeClip = (id) => { setClips(current => current.filter(clip => clip.id !== id)); setResults([]); };

    const runCalibration = async () => {
        if (!calibFile) return;
        setIsProcessing(true);
        setErrorMsg("");
        try {
            const calOffset = await calculateCalibrationOffset(calibFile, parseFloat(calibLevel));
            setOffset(calOffset);
        } catch (err) {
            setErrorMsg("校正に失敗しました。有効なWAVファイルか確認してください。");
            console.error(err);
        }
        setIsProcessing(false);
    };

    const runAnalysis = async () => {
        if (clips.length === 0) return;
        setIsProcessing(true);
        setErrorMsg("");
        const nextResults = [];
        const failedFiles = [];
        // オフセット未設定の場合は仮に100とする（相対評価）
        const currentOffset = offset !== null ? offset : 100;

        for (let index = 0; index < clips.length; index++) {
            const clip = clips[index];
            setProcessingProgress({ current: index + 1, total: clips.length });
            try {
                // 先に選択範囲だけの独立したAudioBufferを作り、その同じbufferを解析・出力する。
                const selectedBuffer = createSelectedBuffer(clip.buffer, clip.start, clip.end);
                const levels = analyzeAudio(selectedBuffer, currentOffset);
                const ncResult = evaluateNC(levels);
                nextResults.push({
                    levels,
                    nc: ncResult,
                    sourceFileName: clip.file.name,
                    clipName: clip.name,
                    useClipNameOnly,
                    buffer: selectedBuffer,
                    selectedStart: clip.start,
                    selectedEnd: clip.end
                });
            } catch (err) {
                failedFiles.push(`${clip.file.name} / ${clip.name}`);
                console.error(err);
            }
        }

        setResults(nextResults);
        if (failedFiles.length > 0) {
            setErrorMsg(`次のWAVファイルを解析できませんでした: ${failedFiles.join(', ')}`);
        }
        setProcessingProgress(null);
        setIsProcessing(false);
    };

    const downloadResultWav = (result) => downloadBlob(
        createTrimmedWav(result.buffer, 0, result.buffer.duration),
        `${getOutputBaseName(result.sourceFileName, result.clipName, result.useClipNameOnly)}.wav`
    );
    const downloadResultFiles = (result) => {
        downloadResultCsv(result);
        window.setTimeout(() => downloadResultWav(result), 150);
    };
    const downloadAllFiles = async () => {
        setIsProcessing(true);
        setErrorMsg('');
        try {
            const JSZip = requireJSZip();
            const zip = new JSZip();
            const usedPaths = new Set();
            results.forEach(result => {
                const baseName = getOutputBaseName(result.sourceFileName, result.clipName, result.useClipNameOnly);
                const csvPath = createUniquePath(`${baseName}.csv`, usedPaths);
                const wavPath = createUniquePath(`${baseName}.wav`, usedPaths);
                zip.file(csvPath, `\uFEFF${createLpeqCsv(result.levels)}`);
                zip.file(wavPath, createTrimmedWav(result.buffer, 0, result.buffer.duration));
            });
            downloadBlob(await zip.generateAsync({ type: 'blob' }), 'NC解析結果.zip');
        } catch (err) {
            console.error(err);
            setErrorMsg(err.message || '一括出力に失敗しました。');
        } finally {
            setIsProcessing(false);
        }
    };

    const exportProject = async () => {
        if (clips.length === 0) return;
        setIsProcessing(true);
        setErrorMsg('');
        try {
            const JSZip = requireJSZip();
            const zip = new JSZip();
            const usedPaths = new Set();
            const filePaths = new Map();
            const addAudioFile = (file, folder) => {
                if (!file) return null;
                if (filePaths.has(file)) return filePaths.get(file);
                const path = createUniquePath(`${folder}/${sanitizeFileName(file.name, 'audio.wav')}`, usedPaths);
                zip.file(path, file);
                filePaths.set(file, path);
                return path;
            };
            const clipSettings = clips.map(clip => ({
                name: clip.name,
                start: clip.start,
                end: clip.end,
                audioFile: addAudioFile(clip.file, 'audio')
            }));
            const calibrationFile = addAudioFile(calibFile, 'calibration');
            zip.file('project.json', JSON.stringify({
                format: 'nc-analyzer-project',
                version: 1,
                createdAt: new Date().toISOString(),
                output: { useClipNameOnly },
                calibration: { referenceLevel: Number(calibLevel), offset, audioFile: calibrationFile },
                clips: clipSettings
            }, null, 2));
            const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            downloadBlob(await zip.generateAsync({ type: 'blob' }), `NC解析プロジェクト_${date}.nca`);
        } catch (err) {
            console.error(err);
            setErrorMsg(err.message || 'プロジェクトの出力に失敗しました。');
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100 p-4 md:p-8 font-sans">
            <div className="max-w-5xl mx-auto space-y-6">
                
                {/* Header */}
                <header className="flex items-center space-x-3 pb-4 border-b border-gray-200 dark:border-gray-700">
                    <Activity className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">NC値 アナライザー</h1>
                        <p className="text-sm text-gray-500 dark:text-gray-400">1/1オクターブバンド分析によるNC(Noise Criteria)値の算出</p>
                    </div>
                </header>

                {errorMsg && (
                    <div className="bg-red-50 dark:bg-red-900/30 border-l-4 border-red-500 p-4 flex items-start">
                        <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 mr-2 flex-shrink-0 mt-0.5" />
                        <span className="text-red-700 dark:text-red-300 text-sm">{errorMsg}</span>
                    </div>
                )}

                <div className="grid md:grid-cols-2 gap-6">
                    {/* Calibration Card */}
                    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                        <div className="flex items-center mb-4">
                            <Settings2 className="w-5 h-5 text-gray-500 mr-2" />
                            <h2 className="text-lg font-semibold">Step 1: 機器校正 (オプション)</h2>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                            正確な音圧レベル(dB SPL)を測定するために、基準となる校正音(例: 1kHz, 94dB)を読み込ませます。
                        </p>
                        
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium mb-1">校正基準レベル (dB)</label>
                                <input 
                                    type="number" 
                                    value={calibLevel} 
                                    onChange={(e) => setCalibLevel(e.target.value)}
                                    className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-1">校正音WAVファイル</label>
                                <input 
                                    type="file" 
                                    accept=".wav,audio/wav" 
                                    onChange={handleCalibFile}
                                    className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-gray-700 dark:file:text-gray-300"
                                />
                            </div>
                            <button 
                                onClick={runCalibration}
                                disabled={!calibFile || isProcessing}
                                className="w-full py-2 bg-gray-800 dark:bg-gray-700 hover:bg-gray-700 dark:hover:bg-gray-600 text-white rounded transition-colors disabled:opacity-50"
                            >
                                校正を実行
                            </button>

                            {offset !== null && (
                                <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 rounded text-sm flex items-center">
                                    <CheckCircle2 className="w-4 h-4 mr-2" />
                                    校正完了 (オフセット: {offset.toFixed(2)} dB)
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Measurement Card */}
                    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                        <div className="flex items-center mb-4">
                            <Upload className="w-5 h-5 text-gray-500 mr-2" />
                            <h2 className="text-lg font-semibold">Step 2: 測定・分析</h2>
                        </div>
                        {offset === null && (
                            <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-300 rounded text-xs flex items-start">
                                <Info className="w-4 h-4 mr-1.5 flex-shrink-0 mt-0.5" />
                                校正が未実施です。分析は可能ですが、算出されるdB値は相対的な参考値となります。
                            </div>
                        )}

                        <div className="space-y-4">
                            <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10 p-3">
                                <input ref={projectInputRef} type="file" accept=".nca,application/zip"
                                    onChange={handleProjectFile} disabled={isProcessing} className="hidden" />
                                <button type="button" onClick={() => projectInputRef.current?.click()} disabled={isProcessing}
                                    className="w-full inline-flex justify-center items-center px-3 py-2 border border-blue-600 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/30 text-sm font-medium rounded disabled:opacity-50">
                                    <Upload className="w-4 h-4 mr-2" />
                                    プロジェクト（.nca）を読み込む
                                </button>
                                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">設定JSONとWAVを含むNCAプロジェクトを復元します。現在の読み込み内容は置き換えられます。</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-1">対象WAVファイル（複数選択可）</label>
                                <input 
                                    type="file" 
                                    accept=".wav,audio/wav" 
                                    multiple
                                    disabled={isProcessing}
                                    onChange={handleMeasFile}
                                    className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-gray-700 dark:file:text-gray-300"
                                />
                                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                                    読み込み後、波形の黄色いハンドルをドラッグして解析範囲を指定できます。
                                </p>
                            </div>

                            {clips.length > 0 && (
                                <div className="space-y-4">
                                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-600 p-3">
                                        <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
                                            <input type="checkbox" checked={useClipNameOnly} disabled={isProcessing}
                                                onChange={e => { setUseClipNameOnly(e.target.checked); setResults([]); }}
                                                className="w-4 h-4 rounded border-gray-300 text-blue-600" />
                                            出力ファイル名を変更名だけにする
                                        </label>
                                        <button type="button" onClick={exportProject} disabled={isProcessing}
                                            className="inline-flex items-center px-3 py-1.5 border border-blue-600 text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-sm font-medium rounded disabled:opacity-50">
                                            <Download className="w-4 h-4 mr-2" />
                                            プロジェクト（.nca）を出力
                                        </button>
                                        <p className="w-full text-xs text-gray-500">オンの場合、「元ファイル名_変更名」ではなく「変更名」をCSV・WAVのファイル名にします。.ncaには設定と読み込んだWAVが保存されます。</p>
                                    </div>
                                    {clips.map(clip => (
                                        <div key={clip.id}>
                                            <p className="mb-1 text-xs font-semibold text-gray-500 break-all">{clip.file.name}</p>
                                            <WaveformEditor clip={clip} disabled={isProcessing}
                                                onChange={changes => updateClip(clip.id, changes)}
                                                onDuplicate={() => duplicateClip(clip.id)}
                                                onRemove={() => removeClip(clip.id)} />
                                        </div>
                                    ))}
                                </div>
                            )}

                            <button 
                                onClick={runAnalysis}
                                disabled={clips.length === 0 || isProcessing}
                                className="w-full py-2 mt-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded shadow-sm transition-colors disabled:opacity-50 flex justify-center items-center"
                            >
                                {isProcessing ? (
                                    <>
                                        <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        処理中... {processingProgress && `(${processingProgress.current}/${processingProgress.total})`}
                                    </>
                                ) : (clips.length > 1 ? `${clips.length}範囲を一括分析` : "選択範囲を分析")}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Results Area */}
                {results.length > 0 && (
                    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                            <div className="flex items-center">
                                <BarChart3 className="w-6 h-6 text-blue-600 dark:text-blue-400 mr-2" />
                                <h2 className="text-xl font-bold">分析結果（{results.length}件）</h2>
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                                <button
                                    onClick={downloadAllFiles}
                                    disabled={isProcessing}
                                    className="inline-flex items-center px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded shadow-sm transition-colors"
                                    title="すべての解析結果と切り抜きWAVをZIPで保存"
                                >
                                    <Download className="w-4 h-4 mr-2" />
                                    CSV＋切り抜きWAVをZIP出力
                                </button>
                            </div>
                        </div>

                        <div className="space-y-8">
                            {results.map((result, resultIndex) => (
                            <section key={`${result.sourceFileName}-${resultIndex}`} className="border-t border-gray-200 dark:border-gray-700 pt-6 first:border-t-0 first:pt-0">
                                <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
                                    <div>
                                        <h3 className="font-semibold break-all">{result.sourceFileName} / {result.clipName}</h3>
                                        <p className="mt-1 text-xs text-gray-500">
                                            解析範囲: {formatTime(result.selectedStart)} — {formatTime(result.selectedEnd)}
                                            （{formatTime(result.buffer.duration)}）
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-3">
                                        <button
                                            onClick={() => downloadResultFiles(result)}
                                            className="inline-flex items-center px-3 py-1.5 border border-green-600 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 text-sm font-medium rounded transition-colors"
                                            title="解析CSVと選択範囲のWAVを保存"
                                        >
                                            <Download className="w-4 h-4 mr-2" />
                                            CSV＋WAVを出力
                                        </button>
                                        <div className="bg-blue-50 dark:bg-blue-900/30 px-6 py-2 rounded-full border border-blue-100 dark:border-blue-800">
                                            <span className="text-sm text-blue-800 dark:text-blue-300 mr-2">判定NC値:</span>
                                            <span className="text-2xl font-bold text-blue-600 dark:text-blue-400">NC-{formatNC(result.nc.overall)}</span>
                                        </div>
                                    </div>
                                </div>
                        <div className="grid lg:grid-cols-3 gap-8">
                            <div className="lg:col-span-2">
                                <h3 className="text-sm font-semibold text-gray-500 mb-3">周波数特性とNC曲線</h3>
                                <ResultChart measuredLevels={result.levels} ncOverall={result.nc.overall} />
                            </div>

                            <div>
                                <h3 className="text-sm font-semibold text-gray-500 mb-3">帯域別詳細</h3>
                                <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
                                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
                                        <thead className="bg-gray-50 dark:bg-gray-900/50">
                                            <tr>
                                                <th className="px-4 py-2 text-left font-medium text-gray-500">周波数</th>
                                                <th className="px-4 py-2 text-right font-medium text-gray-500">測定値 (dB)</th>
                                                <th className="px-4 py-2 text-right font-medium text-gray-500">該当 NC</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-800">
                                            {FREQUENCIES.map((f, i) => {
                                                const isMax = result.nc.details[i] === result.nc.overall;
                                                return (
                                                    <tr key={f} className={isMax ? "bg-blue-50/50 dark:bg-blue-900/10" : ""}>
                                                        <td className="px-4 py-2 text-gray-900 dark:text-gray-300">
                                                            {f >= 1000 ? `${f/1000}k` : f} Hz
                                                        </td>
                                                        <td className="px-4 py-2 text-right font-mono">
                                                            {result.levels[i].toFixed(1)}
                                                        </td>
                                                        <td className={`px-4 py-2 text-right font-medium ${isMax ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'}`}>
                                                            {formatNC(result.nc.details[i])}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                                <p className="text-xs text-gray-400 mt-3 leading-relaxed">
                                    ※ NC値は、各帯域の測定値が下回る最小のNC曲線から判定され、全帯域の中で最も高い値が総合NC値となります。
                                </p>
                            </div>
                        </div>
                            </section>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
