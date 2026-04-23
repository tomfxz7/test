import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Image,
  Alert,
  SafeAreaView,
  ActivityIndicator,
  Share,
  ScrollView,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { loadProjects, saveProjects } from '../../src/utils/storage';
import { exportProjectBackup } from '../../src/utils/pptxExport';
import { Project, MemoItem } from '../../src/types';

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isExporting, setIsExporting] = useState(false);

  const loadData = useCallback(async () => {
    const projects = await loadProjects();
    setAllProjects(projects);
    const found = projects.find((p) => p.id === id);
    setProject(found || null);
    setIsLoading(false);
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // フォーカス時に再読み込み
  useEffect(() => {
    const unsubscribe = router.canGoBack
      ? undefined
      : undefined;
    return unsubscribe;
  }, []);

  const createNewItem = useCallback(async () => {
    if (!project) return;
    const newItem: MemoItem = {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
      memo: '',
      images: [],
      createdAt: new Date().toISOString(),
    };
    const updatedProject = { ...project, items: [...project.items, newItem] };
    const updatedProjects = allProjects.map((p) => (p.id === project.id ? updatedProject : p));
    setProject(updatedProject);
    setAllProjects(updatedProjects);
    await saveProjects(updatedProjects);
    router.push(`/editor/${project.id}/${newItem.id}`);
  }, [project, allProjects, router]);

  const deleteItem = useCallback(
    (item: MemoItem) => {
      if (!project) return;
      Alert.alert('ページを削除', 'このページを削除しますか？', [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除',
          style: 'destructive',
          onPress: async () => {
            const updatedProject = {
              ...project,
              items: project.items.filter((i) => i.id !== item.id),
            };
            const updatedProjects = allProjects.map((p) =>
              p.id === project.id ? updatedProject : p
            );
            setProject(updatedProject);
            setAllProjects(updatedProjects);
            await saveProjects(updatedProjects);
          },
        },
      ]);
    },
    [project, allProjects]
  );

  const handleExport = useCallback(async () => {
    if (!project) return;
    setIsExporting(true);
    try {
      await exportProjectBackup(project);
    } catch (e) {
      Alert.alert('エクスポートエラー', String(e));
    } finally {
      setIsExporting(false);
    }
  }, [project]);

  const formatDate = (date: Date | string) => {
    const d = new Date(date);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const renderItem = ({ item, index }: { item: MemoItem; index: number }) => {
    const firstImage = item.images?.[0];
    return (
      <TouchableOpacity
        style={styles.itemCard}
        onPress={() => router.push(`/editor/${project!.id}/${item.id}`)}
        activeOpacity={0.7}
      >
        <View style={styles.itemCardInner}>
          {/* サムネイル */}
          <View style={styles.thumbnail}>
            {firstImage?.uri ? (
              <Image source={{ uri: firstImage.uri }} style={styles.thumbnailImage} resizeMode="cover" />
            ) : (
              <View style={styles.thumbnailPlaceholder}>
                <Ionicons name="image-outline" size={28} color="#d1d5db" />
              </View>
            )}
            <View style={styles.pageNumberBadge}>
              <Text style={styles.pageNumberText}>{index + 1}</Text>
            </View>
          </View>

          {/* コンテンツ */}
          <View style={styles.itemContent}>
            <Text style={styles.itemMemo} numberOfLines={3}>
              {item.memo || '（メモなし）'}
            </Text>
            <View style={styles.itemMeta}>
              <Ionicons name="images-outline" size={13} color="#9ca3af" />
              <Text style={styles.itemMetaText}>{item.images.length} 枚</Text>
              <Text style={styles.itemMetaText}>　{formatDate(item.createdAt)}</Text>
            </View>
          </View>

          {/* 削除ボタン */}
          <TouchableOpacity
            style={styles.deleteBtn}
            onPress={() => deleteItem(item)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="trash-outline" size={18} color="#ef4444" />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  if (!project) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.errorText}>プロジェクトが見つかりません</Text>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backLink}>戻る</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <Stack.Screen
        options={{
          title: project.title,
          headerStyle: { backgroundColor: '#1e40af' },
          headerTintColor: '#fff',
          headerRight: () => (
            <TouchableOpacity
              onPress={handleExport}
              style={{ marginRight: 4 }}
              disabled={isExporting}
            >
              {isExporting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="share-outline" size={24} color="#fff" />
              )}
            </TouchableOpacity>
          ),
        }}
      />

      {/* Stats Bar */}
      <View style={styles.statsBar}>
        <View style={styles.statItem}>
          <Ionicons name="document-text-outline" size={16} color="#3b82f6" />
          <Text style={styles.statText}>{project.items.length} ページ</Text>
        </View>
        <View style={styles.statItem}>
          <Ionicons name="images-outline" size={16} color="#3b82f6" />
          <Text style={styles.statText}>
            {project.items.reduce((sum, i) => sum + i.images.length, 0)} 枚
          </Text>
        </View>
      </View>

      <FlatList
        data={project.items}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="document-outline" size={64} color="#d1d5db" />
            <Text style={styles.emptyTitle}>ページがありません</Text>
            <Text style={styles.emptySubtitle}>
              下の「＋」ボタンからページを追加してください
            </Text>
          </View>
        }
      />

      {/* FAB */}
      <TouchableOpacity style={styles.fab} onPress={createNewItem} activeOpacity={0.8}>
        <Ionicons name="add" size={32} color="#fff" />
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f8fafc' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorText: { fontSize: 16, color: '#6b7280', marginBottom: 12 },
  backLink: { fontSize: 15, color: '#2563eb' },

  statsBar: {
    flexDirection: 'row',
    gap: 20,
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statText: { fontSize: 14, color: '#374151', fontWeight: '500' },

  listContent: { flexGrow: 1, padding: 16 },

  itemCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 3,
  },
  itemCardInner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  thumbnail: {
    width: 72,
    height: 72,
    borderRadius: 8,
    overflow: 'hidden',
    marginRight: 14,
    position: 'relative',
  },
  thumbnailImage: { width: '100%', height: '100%' },
  thumbnailPlaceholder: {
    width: '100%',
    height: '100%',
    backgroundColor: '#f3f4f6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pageNumberBadge: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  pageNumberText: { fontSize: 10, color: '#fff', fontWeight: '700' },

  itemContent: { flex: 1 },
  itemMemo: { fontSize: 14, color: '#374151', marginBottom: 6, lineHeight: 20 },
  itemMeta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  itemMetaText: { fontSize: 12, color: '#9ca3af' },

  deleteBtn: { padding: 8 },

  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 80 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#9ca3af', marginTop: 16 },
  emptySubtitle: { fontSize: 14, color: '#d1d5db', marginTop: 8, textAlign: 'center', paddingHorizontal: 32 },

  fab: {
    position: 'absolute',
    bottom: 32,
    right: 24,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#2563eb',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#1e40af',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
});
