# ReportmemoBackupApp (iPhoneネイティブ版サンプル)

このフォルダは、`reportmemoapp.jsx` のデータ構造に近いJSONを **iPhoneアプリ内で自動保存** するための最小SwiftUIサンプルです。

## できること
- プロジェクト一覧の追加/削除
- `Documents/reportmemo_data.json` への保存
- 自動保存タイマー（1〜60分）
- JSONファイルの共有（Share Sheet）

## 構成ファイル
- `ReportmemoBackupApp.swift`: エントリポイント
- `ContentView.swift`: 画面UI
- `Models.swift`: Codableモデル
- `ProjectStore.swift`: 永続化・自動保存ロジック

## 使い方（Xcode）
1. Xcodeで iOS App プロジェクトを新規作成（SwiftUI）
2. このフォルダの `.swift` ファイルを追加
3. 実機（iPhone）で起動
4. 「JSONを共有」でファイルアプリやクラウドへ保存

## 補足
- ネイティブアプリ化すると、Webブラウザ制約（`showSaveFilePicker` 非対応など）を回避しやすくなります。
- ただし、最終的な配布には署名・証明書・App Store配布フローが必要です。
