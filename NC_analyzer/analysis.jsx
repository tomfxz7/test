import React, { useState } from 'react';
import { Upload, Download, Settings2, BarChart3, AlertCircle, CheckCircle2, Info, Activity } from 'lucide-react';

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
const analyzeAudio = async (file, offset) => {
    const buffer = await decodeFile(file);
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

    for (let p = 0; p + N <= data.length; p += overlap) {
        const re = new Float32Array(N);
        const im = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            re[i] = data[p + i] * windowFunc[i];
        }

        fft(re, im);

        // パワースペクトルの計算 (片側)
        totalPower[0] += (re[0] * re[0] + im[0] * im[0]) / (N * N);
        for (let i = 1; i < N / 2; i++) {
            totalPower[i] += 2 * (re[i] * re[i] + im[i] * im[i]) / (N * N);
        }
        totalPower[N / 2] += (re[N / 2] * re[N / 2] + im[N / 2] * im[N / 2]) / (N * N);
        frameCount++;
    }

    // 平均化と窓関数の補正
    for (let i = 0; i <= N / 2; i++) {
        totalPower[i] = (totalPower[i] / frameCount) / windowPower;
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

const getCsvFileName = (wavFileName) => {
    const baseName = wavFileName.replace(/\.wav$/i, '');
    return `${baseName}.csv`;
};

const downloadResultCsv = (result) => {
    // BOMを付けて、表計算ソフトで開いた場合にもUTF-8として認識させる
    const blob = new Blob([`\uFEFF${createLpeqCsv(result.levels)}`], {
        type: 'text/csv;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = getCsvFileName(result.sourceFileName);
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


// --- メインアプリケーション ---
export default function App() {
    const [calibFile, setCalibFile] = useState(null);
    const [calibLevel, setCalibLevel] = useState(94.0);
    const [offset, setOffset] = useState(null);
    
    const [measFiles, setMeasFiles] = useState([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [processingProgress, setProcessingProgress] = useState(null);
    const [errorMsg, setErrorMsg] = useState("");
    
    const [results, setResults] = useState([]);

    const handleCalibFile = (e) => setCalibFile(e.target.files[0]);
    const handleMeasFile = (e) => {
        setMeasFiles(Array.from(e.target.files || []));
        setResults([]);
    };

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
        if (measFiles.length === 0) return;
        setIsProcessing(true);
        setErrorMsg("");
        const nextResults = [];
        const failedFiles = [];
        // オフセット未設定の場合は仮に100とする（相対評価）
        const currentOffset = offset !== null ? offset : 100;

        for (let index = 0; index < measFiles.length; index++) {
            const file = measFiles[index];
            setProcessingProgress({ current: index + 1, total: measFiles.length });
            try {
                const levels = await analyzeAudio(file, currentOffset);
                const ncResult = evaluateNC(levels);
                nextResults.push({ levels, nc: ncResult, sourceFileName: file.name });
            } catch (err) {
                failedFiles.push(file.name);
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

    const downloadAllCsv = () => {
        results.forEach(downloadResultCsv);
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
                                {measFiles.length > 0 && (
                                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 break-all">
                                        選択中（{measFiles.length}件）: {measFiles.map(file => file.name).join(', ')}
                                    </p>
                                )}
                            </div>
                            
                            <button 
                                onClick={runAnalysis}
                                disabled={measFiles.length === 0 || isProcessing}
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
                                ) : (measFiles.length > 1 ? `${measFiles.length}ファイルを一括分析` : "分析を実行")}
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
                                    onClick={downloadAllCsv}
                                    className="inline-flex items-center px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded shadow-sm transition-colors"
                                    title="すべての解析結果をCSVで保存"
                                >
                                    <Download className="w-4 h-4 mr-2" />
                                    CSVを一括出力
                                </button>
                            </div>
                        </div>

                        <div className="space-y-8">
                            {results.map((result, resultIndex) => (
                            <section key={`${result.sourceFileName}-${resultIndex}`} className="border-t border-gray-200 dark:border-gray-700 pt-6 first:border-t-0 first:pt-0">
                                <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
                                    <h3 className="font-semibold break-all">{result.sourceFileName}</h3>
                                    <div className="flex flex-wrap items-center gap-3">
                                        <button
                                            onClick={() => downloadResultCsv(result)}
                                            className="inline-flex items-center px-3 py-1.5 border border-green-600 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 text-sm font-medium rounded transition-colors"
                                            title={`${getCsvFileName(result.sourceFileName)} を保存`}
                                        >
                                            <Download className="w-4 h-4 mr-2" />
                                            CSVを出力
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
