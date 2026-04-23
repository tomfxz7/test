# ReportMemo Native

iPad/iPhone向けネイティブアプリ版 ReportMemo です。
写真を撮影してメモを追加し、レポート作成をサポートします。

---

## すぐに使う方法（Expo Go）

### 1. Expo Go アプリをインストール

- [App Store: Expo Go](https://apps.apple.com/jp/app/expo-go/id982107779)

### 2. 開発サーバーを起動

```bash
# 依存パッケージをインストール
npm install

# 開発サーバーを起動
npx expo start
```

### 3. QRコードをスキャン

ターミナルに表示されるQRコードを **Expo Go アプリ** でスキャンすると、
iPad/iPhone 上でアプリが起動します。

---

## 機能一覧

| 機能 | 説明 |
|------|------|
| プロジェクト管理 | 複数のレポートプロジェクトを作成・管理 |
| カメラ撮影 | iPad/iPhone のカメラで直接撮影 |
| フォトライブラリ | 既存の写真を複数枚選択して追加 |
| 手書きアノテーション | ペン・消しゴム・図形・矢印で画像に書き込み |
| メモ入力 | 各ページにテキストメモを記録 |
| AI-OCR | Gemini AI で画像内テキストを自動認識 |
| データ保存 | AsyncStorage による端末内永続保存 |
| エクスポート | JSON形式でバックアップ・共有 |

---

## 必要な環境

- Node.js 18 以上
- npm または yarn
- Expo Go アプリ（iPhone/iPad）

---

## Gemini API キーの設定

AI-OCR機能を使用するには Gemini API キーが必要です。

1. [Google AI Studio](https://aistudio.google.com/) でAPIキーを取得
2. アプリのホーム画面右上の「設定」アイコンをタップ
3. APIキーを入力して「保存」

---

## ビルド（App Store配布）

```bash
# EAS CLIをインストール
npm install -g eas-cli

# EASにログイン
eas login

# ビルド設定を初期化
eas build:configure

# iOSビルド
eas build --platform ios
```

Apple Developer Program（年間 $99）への登録が必要です。

---

## 技術スタック

- **Expo** ~52.0.0
- **React Native** 0.76.3
- **expo-router** ~4.0.0（ファイルベースルーティング）
- **expo-camera** / **expo-image-picker**（カメラ・写真）
- **react-native-svg**（SVGアノテーション描画）
- **@react-native-async-storage/async-storage**（データ永続化）
- **expo-sharing** / **expo-file-system**（エクスポート）

---

## ディレクトリ構成

```
reportmemo-native/
├── app/                    # Expo Router ページ
│   ├── _layout.tsx         # ルートレイアウト
│   ├── index.tsx           # ホーム画面（プロジェクト一覧）
│   ├── project/
│   │   └── [id].tsx        # プロジェクト詳細（ページ一覧）
│   └── editor/
│       └── [projectId]/
│           └── [itemId].tsx # エディタ画面（撮影・描画・メモ）
├── src/
│   ├── components/
│   │   └── DrawingCanvas.tsx # 手書き描画キャンバス
│   ├── types/
│   │   └── index.ts         # 型定義
│   └── utils/
│       ├── storage.ts       # AsyncStorage操作
│       ├── gemini.ts        # Gemini API
│       └── pptxExport.ts    # エクスポート機能
├── assets/                 # アイコン・スプラッシュ画像
├── app.json                # Expo設定
├── babel.config.js
└── tsconfig.json
```
