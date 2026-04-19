
import React, { useState, useEffect } from 'react';
import { Plus, Trash2, ChefHat, ShoppingCart, CalendarDays, Loader2, RefreshCw, Youtube, AlertCircle, Utensils, Clock, ExternalLink, Settings, Key, X } from 'lucide-react';

const apiKey = ""; // The execution environment provides the key at runtime.
const APP_VERSION = "1.1.0";

// --- IndexedDB ユーティリティ（大容量保存用） ---
const DB_NAME = 'RecipeMasterDB';
const STORE_NAME = 'settings';

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function setItem(key, value) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getItem(key) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Gemini API呼び出し用関数（指数的バックオフ付きリトライ）
async function fetchGeminiWithRetry(prompt, customApiKey, maxRetries = 5) {
  const activeKey = (customApiKey || apiKey || "").trim();
  
  if (!activeKey) {
    throw new Error("APIキーが設定されていません。設定画面からGemini APIキーを入力してください。");
  }

  const modelName = customApiKey ? "gemini-2.5-flash" : "gemini-2.5-flash-preview-09-2025";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${activeKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }] 
  };

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`APIエラー (${response.status}): ${errText}`);
      }

      const result = await response.json();
      if (result.candidates && result.candidates.length > 0) {
        let text = result.candidates[0].content.parts[0].text;
        
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          text = jsonMatch[0];
        }
        
        return JSON.parse(text); 
      }
      throw new Error("Geminiから有効なレスポンスが返ってきませんでした。");
    } catch (err) {
      if (i === maxRetries - 1) {
        console.error("Gemini API Error:", err);
        throw err;
      }
      const delay = Math.pow(2, i) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export default function App() {
  const [youtubers, setYoutubers] = useState([]);
  const [userApiKey, setUserApiKey] = useState(''); 
  const [isSettingsOpen, setIsSettingsOpen] = useState(false); 
  const [isDbLoaded, setIsDbLoaded] = useState(false);
  const [newYoutuber, setNewYoutuber] = useState('');
  
  const [difficulty, setDifficulty] = useState('normal'); 
  const [menuData, setMenuData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reloadingDay, setReloadingDay] = useState(null); // 個別再取得中の曜日を管理
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('recipes'); 
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    getItem('youtubers')
      .then((data) => {
        if (data && data.length > 0) {
          setYoutubers(data);
        } else {
          setYoutubers([
            { input: 'https://www.youtube.com/@ryuji825', display: '@ryuji825' },
            { input: 'https://www.youtube.com/@KohKentetsuKitchen', display: '@KohKentetsuKitchen' }
          ]);
        }
        setIsDbLoaded(true);
      })
      .catch((err) => {
        console.error('Failed to load from IndexedDB', err);
        setYoutubers([
            { input: 'https://www.youtube.com/@ryuji825', display: '@ryuji825' },
            { input: 'https://www.youtube.com/@KohKentetsuKitchen', display: '@KohKentetsuKitchen' }
        ]);
        setIsDbLoaded(true);
      });
      
    getItem('userApiKey')
      .then((key) => {
        if (key) setUserApiKey(key);
      })
      .catch(err => console.error('Failed to load API key', err));

    getItem('savedMenuData')
      .then((saved) => {
        if (saved && saved.recipes && saved.shoppingList) {
          setMenuData(saved);
        }
      })
      .catch((err) => console.error('Failed to load saved menu data', err));
  }, []);

  useEffect(() => {
    if (isDbLoaded) {
      setItem('youtubers', youtubers).catch(err => console.error('Failed to save to IndexedDB', err));
    }
  }, [youtubers, isDbLoaded]);

  const handleSaveApiKey = (newKey) => {
    setUserApiKey(newKey);
    setItem('userApiKey', newKey).catch(err => console.error('Failed to save API key', err));
  };

  const handleAddYoutuber = (e) => {
    e.preventDefault();
    const inputStr = newYoutuber.trim();
    if (!inputStr) return;

    let displayValue = inputStr;
    try {
      if (inputStr.startsWith('http://') || inputStr.startsWith('https://')) {
        const urlObj = new URL(inputStr);
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.length > 0) {
          if (pathParts[0].startsWith('@')) {
            displayValue = pathParts[0]; 
          } else if (pathParts[0] === 'c' && pathParts[1]) {
            displayValue = pathParts[1]; 
          } else if (pathParts[0] === 'channel') {
             displayValue = "YouTube Channel"; 
          } else {
             displayValue = urlObj.hostname + urlObj.pathname;
          }
        }
      }
    } catch (err) {}

    if (!youtubers.some(yt => yt.input === inputStr)) {
      setYoutubers([...youtubers, { input: inputStr, display: displayValue }]);
      setNewYoutuber('');
    }
  };

  const handleRemoveYoutuber = (index) => {
    setYoutubers(youtubers.filter((_, i) => i !== index));
  };

  // 1週間まるごと生成する処理
  const generateMenu = async () => {
    if (youtubers.length === 0) {
      setError("YouTuberを1人以上登録してください。");
      return;
    }
    if (!userApiKey && !apiKey) {
      setError("APIキーが設定されていません。右上の設定からGemini APIキーを入力してください。");
      setIsSettingsOpen(true);
      return;
    }

    setLoading(true);
    setError('');
    setMenuData(null);

    let difficultyText = "";
    if (difficulty === 'easy') difficultyText = "とにかく簡単（動画時間が短く、工程や洗い物が少ないもの）";
    else if (difficulty === 'normal') difficultyText = "普通（標準的な調理時間と手間のもの）";
    else if (difficulty === 'hard') difficultyText = "本格的（少し動画時間が長く、手間や時間がかかっても美味しいもの）";

    const prompt = `
あなたは優秀な献立プランナーです。

【最重要指示】
必ず「Google Search（ウェブ検索）」機能を使用して、以下の「登録された料理系YouTuber」の実際のYouTube動画を検索し、実在するレシピ動画の情報を取得して献立を作成してください。
AI自身の記憶に頼ったり、架空のレシピを捏造することは絶対に禁止します。検索して見つかった【実際に存在するレシピ動画】のみを使用してください。

※重要※ 出力データが壊れる原因となるため、検索結果の引用マーカー（例: [1], [2]）や、JSON以外の挨拶・説明テキストは絶対に出力しないでください。必ず有効なJSONのみを出力してください。

登録されたYouTuber (チャンネルURLまたは名前): ${youtubers.map(yt => yt.input).join(', ')}
希望する料理の簡単さ: ${difficultyText}

【厳守する条件】
1. 検索に基づく実在確認: 検索機能を使って指定したYouTuberの実際の動画を探し、正確な動画タイトル、実際の動画URL、使用されている食材を特定した上で選出してください。
2. フラットな選出: バズった有名なレシピ（数百万再生など）に偏らず、マイナーなレシピも含めて彼らの動画の中から同じ土俵で幅広く選出してください。
3. 簡単さの反映: 「希望する料理の簡単さ」にしっかりと応じたレシピを選んでください。
4. 食材の使い回し: 週末にまとめ買いできるよう、1週間を通して使う主菜・副菜の食材の種類を絞り、共通の食材を使い回せるようにしてください。
5. ジャンルの分散: 食材は同じでも、飽きが来ないようにジャンルはできるだけバラバラにしてください。
6. 出力するYouTuber名: 一般的なチャンネル名や人物名（例：「@ryuji825」なら「リュウジ」など）を記載してください。
7. 正確なURL: \`videoUrl\` フィールドには、検索して見つけた実際のYouTube動画のURL（https://www.youtube.com/watch?v=...）を必ず正確に記載してください。

以下のJSONスキーマに従って出力してください。
{
  "type": "object",
  "properties": {
    "recipes": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "day": { "type": "string", "description": "曜日 (例: 月曜日)" },
          "title": { "type": "string", "description": "料理名（実際の動画タイトルに近いもの）" },
          "youtuber": { "type": "string", "description": "参考にしたYouTuber名" },
          "genre": { "type": "string", "description": "ジャンル (例: 和食, 中華など)" },
          "videoUrl": { "type": "string", "description": "このレシピの実際のYouTube動画URL（例: https://www.youtube.com/watch?v=...）。必ず実在するURLを指定してください。" },
          "searchQuery": { "type": "string", "description": "この動画を探すためのYouTube検索キーワード" },
          "ingredients": {
            "type": "array",
            "items": { "type": "string" },
            "description": "1食分に必要な材料と大まかな分量"
          }
        },
        "required": ["day", "title", "youtuber", "genre", "videoUrl", "searchQuery", "ingredients"]
      }
    },
    "shoppingList": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "category": { "type": "string", "description": "カテゴリ" },
          "items": {
            "type": "array",
            "items": { "type": "string" },
            "description": "1週間分まとめ買いする品目と総量"
          }
        },
        "required": ["category", "items"]
      }
    }
  },
  "required": ["recipes", "shoppingList"]
}
`;

    try {
      const data = await fetchGeminiWithRetry(prompt, userApiKey);
      setMenuData(data);
      setActiveTab('recipes');
    } catch (err) {
      console.error(err);
      setError(`エラーが発生しました: ${err.message || "予期せぬエラー"}`);
    } finally {
      setLoading(false);
    }
  };

  // 特定の曜日だけ再生成する処理
  const regenerateSingleRecipe = async (targetDay) => {
    if (!userApiKey && !apiKey) {
      setError("APIキーが設定されていません。右上の設定からGemini APIキーを入力してください。");
      setIsSettingsOpen(true);
      return;
    }

    setReloadingDay(targetDay);
    setError('');

    let difficultyText = "";
    if (difficulty === 'easy') difficultyText = "とにかく簡単（動画時間が短く、工程や洗い物が少ないもの）";
    else if (difficulty === 'normal') difficultyText = "普通（標準的な調理時間と手間のもの）";
    else if (difficulty === 'hard') difficultyText = "本格的（少し動画時間が長く、手間や時間がかかっても美味しいもの）";

    const prompt = `
あなたは優秀な献立プランナーです。

現在、以下の1週間分の献立データがあります。
${JSON.stringify(menuData.recipes, null, 2)}

【最重要指示】
この献立データの「${targetDay}」のレシピだけを、現在とは【全く別のレシピ】に変更してください。
残りの曜日のレシピは変更せず、そのまま維持してください。
また、買い物リスト（shoppingList）も、変更後の1週間の献立に合わせて再計算・更新してください。

必ず「Google Search（ウェブ検索）」機能を使用して、以下の「登録された料理系YouTuber」の実際のYouTube動画を検索し、実在するレシピ動画の情報を取得して変更部分に当てはめてください。

※重要※ 出力データが壊れる原因となるため、検索結果の引用マーカー（例: [1], [2]）や、JSON以外の挨拶・説明テキストは絶対に出力しないでください。必ず有効なJSONのみを出力してください。

登録されたYouTuber: ${youtubers.map(yt => yt.input).join(', ')}
希望する料理の簡単さ: ${difficultyText}

【厳守する条件】
1. 「${targetDay}」以外の曜日のレシピは変更しないこと。
2. 変更するレシピは、他の日で使う食材をなるべく使い回せるようにすること。
3. 変更するレシピには必ず正確な \`videoUrl\` を含めること。

以下のJSONスキーマに従って、【変更後の1週間分すべてのデータ（recipesとshoppingList）】を出力してください。
{
  "type": "object",
  "properties": {
    "recipes": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "day": { "type": "string" },
          "title": { "type": "string" },
          "youtuber": { "type": "string" },
          "genre": { "type": "string" },
          "videoUrl": { "type": "string" },
          "searchQuery": { "type": "string" },
          "ingredients": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["day", "title", "youtuber", "genre", "videoUrl", "searchQuery", "ingredients"]
      }
    },
    "shoppingList": { ... (省略: 更新された買い物リスト) ... }
  }
}
（※前回と同じ形式で出力してください）
`;

    try {
      const data = await fetchGeminiWithRetry(prompt, userApiKey);
      // 部分更新ではなく全体を上書き（買い物リストの整合性も保たれる）
      setMenuData(data); 
    } catch (err) {
      console.error(err);
      setError(`「${targetDay}」の再取得中にエラーが発生しました: ${err.message || "予期せぬエラー"}`);
    } finally {
      setReloadingDay(null);
    }
  };

  const dayColors = {
    '月曜日': 'bg-blue-100 text-blue-800 border-blue-200',
    '火曜日': 'bg-pink-100 text-pink-800 border-pink-200',
    '水曜日': 'bg-indigo-100 text-indigo-800 border-indigo-200',
    '木曜日': 'bg-green-100 text-green-800 border-green-200',
    '金曜日': 'bg-yellow-100 text-yellow-800 border-yellow-200',
    '土曜日': 'bg-orange-100 text-orange-800 border-orange-200',
    '日曜日': 'bg-red-100 text-red-800 border-red-200',
  };

  const openExternalLink = (url) => {
    if (!url) return;
    const safeUrl = String(url).trim();
    if (!safeUrl.startsWith('http')) return;

    const newWindow = window.open(safeUrl, '_blank', 'noopener,noreferrer');
    if (newWindow) {
      newWindow.opener = null;
      return;
    }
    window.location.assign(safeUrl);
  };

  const handleSaveCurrentMenu = async () => {
    if (!menuData) return;
    try {
      await setItem('savedMenuData', menuData);
      const savedTime = new Date().toLocaleString('ja-JP');
      await setItem('savedMenuUpdatedAt', savedTime);
      setSaveMessage(`保存しました（${savedTime}）`);
    } catch (err) {
      console.error('Failed to save menu data', err);
      setSaveMessage('保存に失敗しました');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800 font-sans pb-12">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-orange-500 p-2 rounded-xl">
              <ChefHat className="text-white w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold text-gray-900 tracking-tight">スマート献立マスター</h1>
          </div>
          <button 
            onClick={() => setIsSettingsOpen(true)}
            className="p-2 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-full transition-colors"
            aria-label="設定"
          >
            <Settings className="w-6 h-6" />
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 mt-6 space-y-8">
        
        {/* YouTuber Registration Section */}
        <section className="bg-white rounded-2xl shadow-sm p-6 border border-gray-100">
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-4 text-gray-800">
            <Youtube className="w-5 h-5 text-red-500" />
            参考にするYouTuber
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            お気に入りの料理系チャンネルのURL（リンク）を登録してください。彼らの動画に出そうなレシピで献立を組みます。
          </p>
          
          <form onSubmit={handleAddYoutuber} className="flex gap-2 mb-4">
            <input
              type="text"
              value={newYoutuber}
              onChange={(e) => setNewYoutuber(e.target.value)}
              placeholder="例: https://www.youtube.com/@ryuji825"
              className="flex-1 px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white transition-all"
            />
            <button
              type="submit"
              disabled={!newYoutuber.trim()}
              className="px-4 py-2 bg-gray-800 text-white rounded-xl hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 transition-colors"
            >
              <Plus className="w-5 h-5" />
              <span className="hidden sm:inline">追加</span>
            </button>
          </form>

          <div className="flex flex-wrap gap-2">
            {youtubers.map((yt, index) => (
              <span 
                key={index} 
                title={yt.input}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-orange-50 text-orange-700 border border-orange-100 rounded-lg text-sm font-medium"
              >
                {yt.display}
                <button
                  onClick={() => handleRemoveYoutuber(index)}
                  className="p-0.5 hover:bg-orange-200 rounded-md transition-colors"
                  aria-label="削除"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </span>
            ))}
            {youtubers.length === 0 && (
              <span className="text-sm text-gray-400 italic">YouTuberが登録されていません</span>
            )}
          </div>
          
          <div className="mt-6 pt-6 border-t border-gray-100">
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3 text-gray-700">
              <Clock className="w-4 h-4 text-orange-500" />
              料理の簡単さ（動画時間の長さ目安）
            </h3>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="radio" 
                  name="difficulty" 
                  value="easy" 
                  checked={difficulty === 'easy'} 
                  onChange={(e) => setDifficulty(e.target.value)}
                  className="text-orange-500 focus:ring-orange-500"
                />
                <span className="text-sm text-gray-700">とにかく簡単 (短時間・ズボラ)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="radio" 
                  name="difficulty" 
                  value="normal" 
                  checked={difficulty === 'normal'} 
                  onChange={(e) => setDifficulty(e.target.value)}
                  className="text-orange-500 focus:ring-orange-500"
                />
                <span className="text-sm text-gray-700">普通</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="radio" 
                  name="difficulty" 
                  value="hard" 
                  checked={difficulty === 'hard'} 
                  onChange={(e) => setDifficulty(e.target.value)}
                  className="text-orange-500 focus:ring-orange-500"
                />
                <span className="text-sm text-gray-700">本格的 (手間OK)</span>
              </label>
            </div>
          </div>
        </section>

        {/* Generate Button */}
        <div className="flex justify-center">
          <button
            onClick={generateMenu}
            disabled={loading || reloadingDay !== null || youtubers.length === 0}
            className="w-full sm:w-auto px-8 py-4 bg-orange-500 text-white rounded-2xl font-bold text-lg shadow-lg shadow-orange-200 hover:bg-orange-600 hover:-translate-y-0.5 active:translate-y-0 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-6 h-6 animate-spin" />
                AIが献立を考案中...
              </>
            ) : (
              <>
                <RefreshCw className="w-5 h-5" />
                1週間分の献立を生成する
              </>
            )}
          </button>
        </div>

        {error && (
          <div className="p-4 bg-red-50 text-red-700 rounded-xl flex items-start gap-3 border border-red-100">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {/* Results Section */}
        {menuData && !loading && (
          <section className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-4 sm:px-6 pt-4">
              <div className="flex items-center justify-end gap-3">
                {saveMessage && <span className="text-xs text-gray-500">{saveMessage}</span>}
                <button
                  type="button"
                  onClick={handleSaveCurrentMenu}
                  className="px-3 py-2 text-sm font-semibold text-orange-700 bg-orange-50 hover:bg-orange-100 rounded-lg border border-orange-100 transition-colors"
                >
                  この献立を保存
                </button>
              </div>
            </div>
            
            {/* Tabs */}
            <div className="flex border-b border-gray-100">
              <button
                onClick={() => setActiveTab('recipes')}
                className={`flex-1 py-4 text-sm font-semibold flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'recipes' 
                    ? 'text-orange-600 border-b-2 border-orange-500 bg-orange-50/30' 
                    : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                <CalendarDays className="w-4 h-4" />
                1週間のレシピ
              </button>
              <button
                onClick={() => setActiveTab('shopping')}
                className={`flex-1 py-4 text-sm font-semibold flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'shopping' 
                    ? 'text-orange-600 border-b-2 border-orange-500 bg-orange-50/30' 
                    : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                <ShoppingCart className="w-4 h-4" />
                まとめ買いリスト
              </button>
            </div>

            {/* Tab Content: Recipes */}
            {activeTab === 'recipes' && (
              <div className="p-4 sm:p-6 space-y-4">
                <div className="mb-4 p-3 bg-blue-50 text-blue-800 rounded-xl text-sm border border-blue-100">
                  <span className="font-bold">💡 AIの工夫:</span> 買い物リストの食材を使い回しつつ、指定された簡単さに合わせて、YouTuberの実際の動画から幅広くレシピを組み合わせました！
                  <span className="text-xs text-blue-600 mt-1 block">※各レシピの「YouTubeで検索」ボタンから動画を探せます。気に入らない日は右上の「別のレシピにする」を押してください。</span>
                </div>
                
                {menuData.recipes.map((recipe, index) => (
                  <div 
                    key={index} 
                    className={`border border-gray-100 rounded-xl p-4 transition-all bg-white flex flex-col sm:flex-row gap-4 relative ${reloadingDay === recipe.day ? 'opacity-50 pointer-events-none' : 'hover:shadow-md'}`}
                  >
                    {/* 個別再取得ボタン */}
                    <button
                      onClick={() => regenerateSingleRecipe(recipe.day)}
                      disabled={reloadingDay !== null}
                      className="absolute top-4 right-4 text-xs font-semibold flex items-center gap-1.5 text-gray-500 hover:text-orange-500 transition-colors bg-gray-50 hover:bg-orange-50 px-2 py-1 rounded-md border border-gray-100 z-10 cursor-pointer"
                    >
                      {reloadingDay === recipe.day ? (
                         <Loader2 className="w-3.5 h-3.5 animate-spin text-orange-500" />
                      ) : (
                         <RefreshCw className="w-3.5 h-3.5" />
                      )}
                      <span className="hidden sm:inline">別のレシピにする</span>
                    </button>

                    <div className="flex-1 pr-0 sm:pr-28">
                      <div className="flex flex-wrap items-center gap-2 mb-3">
                        <span className={`px-2.5 py-1 rounded-md text-xs font-bold border ${dayColors[recipe.day] || 'bg-gray-100 text-gray-800'}`}>
                          {recipe.day}
                        </span>
                        <span className="text-xs font-medium px-2 py-1 bg-gray-100 text-gray-600 rounded-md">
                          {recipe.genre}
                        </span>
                        <span className="text-xs text-gray-500 flex items-center gap-1 bg-gray-50 px-2 py-1 rounded-md">
                          <Utensils className="w-3 h-3" />
                          {recipe.youtuber}
                        </span>
                      </div>
                      
                      <h3 className="text-lg font-bold text-gray-900 mb-3">{recipe.title}</h3>
                      
                      <div className="mb-4 sm:mb-0">
                        <p className="text-xs font-semibold text-gray-500 mb-1">使用する材料:</p>
                        <ul className="flex flex-wrap gap-1.5">
                          {recipe.ingredients.map((item, i) => (
                            <li key={i} className="text-sm bg-orange-50 text-orange-800 px-2 py-1 rounded">
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                    
                    <div className="sm:w-40 flex flex-col justify-end gap-2 shrink-0 border-t sm:border-t-0 sm:border-l border-gray-100 pt-3 sm:pt-0 sm:pl-4 relative z-10">
                      {recipe.videoUrl && recipe.videoUrl.startsWith('http') && (
                        <button
                          type="button"
                          onClick={() => openExternalLink(recipe.videoUrl)}
                          className="flex items-center justify-center gap-1.5 w-full py-2.5 px-3 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition-colors shadow-sm cursor-pointer"
                        >
                          <Youtube className="w-4 h-4 inline-block -mt-0.5" />
                          直接動画へ
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openExternalLink(`https://www.youtube.com/results?search_query=${encodeURIComponent(recipe.searchQuery)}`)}
                        className="flex items-center justify-center gap-1.5 w-full py-2.5 px-3 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-sm font-semibold transition-colors cursor-pointer"
                      >
                        <ExternalLink className="w-4 h-4 inline-block -mt-0.5" />
                        検索して探す
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Tab Content: Shopping List */}
            {activeTab === 'shopping' && (
              <div className="p-4 sm:p-6">
                <p className="text-sm text-gray-500 mb-6 text-center">
                  これだけ買えば1週間（夕食分）回せます！冷蔵庫もスッキリ。
                </p>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {menuData.shoppingList.map((category, index) => (
                    <div key={index} className="bg-gray-50 rounded-xl p-4 border border-gray-100">
                      <h4 className="font-bold text-gray-800 mb-3 flex items-center gap-2 border-b border-gray-200 pb-2">
                        {category.category}
                      </h4>
                      <ul className="space-y-2">
                        {category.items.map((item, i) => (
                          <li key={i} className="flex items-start gap-2 text-gray-700">
                            <input 
                              type="checkbox" 
                              className="mt-1 w-4 h-4 text-orange-500 rounded border-gray-300 focus:ring-orange-500" 
                            />
                            <span className="text-sm">{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                <Settings className="w-5 h-5 text-gray-500" />
                設定
              </h2>
              <button 
                onClick={() => setIsSettingsOpen(false)}
                className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                  <Key className="w-4 h-4 text-orange-500" />
                  Gemini APIキー
                </label>
                <input
                  type="password"
                  value={userApiKey}
                  onChange={(e) => handleSaveApiKey(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white transition-all text-sm"
                />
                <p className="text-xs text-gray-500 mt-2 leading-relaxed">
                  献立を生成するためにGoogle GeminiのAPIキーが必要です。入力したキーはあなたのブラウザ内（IndexedDB）にのみ保存され、外部のサーバーには送信されません。
                </p>
              </div>
              <div className="pt-3 border-t border-gray-100">
                <p className="text-xs text-gray-500">アプリバージョン: <span className="font-semibold text-gray-700">{APP_VERSION}</span></p>
              </div>
            </div>

            <div className="px-6 py-4 bg-gray-50 flex justify-end">
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="px-6 py-2 bg-gray-800 text-white font-medium rounded-xl hover:bg-gray-700 transition-colors"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
