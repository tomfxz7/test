import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Project, MemoItem } from '../types';

// pptxgenjs はReact Native環境ではブラウザAPIに依存するため、
// ここではJSON形式でのエクスポートとShareシートを使用する代替実装を提供します。
// 完全なPPTX生成にはサーバーサイド処理またはWebViewが必要です。

export interface ExportOptions {
  showPageNumber: boolean;
  selectedItemIds?: string[];
}

/**
 * プロジェクトをJSON形式でエクスポートし、共有する
 */
export const exportProjectAsJSON = async (
  project: Project,
  options: ExportOptions
): Promise<void> => {
  const items = options.selectedItemIds
    ? project.items.filter((item) => options.selectedItemIds!.includes(item.id))
    : project.items;

  const exportData = {
    title: project.title,
    exportedAt: new Date().toISOString(),
    items: items.map((item, index) => ({
      pageNumber: index + 1,
      memo: item.memo,
      imageCount: item.images.length,
      annotationCount: item.images.reduce((sum, img) => sum + img.annotations.length, 0),
    })),
  };

  const fileName = `${project.title.replace(/[^a-zA-Z0-9\u3040-\u9FFF]/g, '_')}_export.json`;
  const filePath = `${FileSystem.documentDirectory}${fileName}`;

  await FileSystem.writeAsStringAsync(filePath, JSON.stringify(exportData, null, 2), {
    encoding: FileSystem.EncodingType.UTF8,
  });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(filePath, {
      mimeType: 'application/json',
      dialogTitle: `${project.title} をエクスポート`,
    });
  }
};

/**
 * プロジェクト全体をバックアップ用JSONとしてエクスポートする
 */
export const exportProjectBackup = async (project: Project): Promise<void> => {
  const fileName = `${project.title.replace(/[^a-zA-Z0-9\u3040-\u9FFF]/g, '_')}_backup.json`;
  const filePath = `${FileSystem.documentDirectory}${fileName}`;

  await FileSystem.writeAsStringAsync(filePath, JSON.stringify(project, null, 2), {
    encoding: FileSystem.EncodingType.UTF8,
  });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(filePath, {
      mimeType: 'application/json',
      dialogTitle: `${project.title} バックアップ`,
    });
  }
};

/**
 * 画像をシェアする
 */
export const shareImage = async (uri: string): Promise<void> => {
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: 'image/jpeg',
    });
  }
};
