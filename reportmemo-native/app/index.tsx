import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Modal,
  TextInput,
  Alert,
  SafeAreaView,
  StatusBar,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { loadProjects, saveProjects, loadGeminiKey, saveGeminiKey } from '../src/utils/storage';
import { Project } from '../src/types';

export default function HomeScreen() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isNewProjectModal, setIsNewProjectModal] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [isSettingsModal, setIsSettingsModal] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [tempApiKey, setTempApiKey] = useState('');
  const [isRenameModal, setIsRenameModal] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [renameTitle, setRenameTitle] = useState('');

  useEffect(() => {
    (async () => {
      const [loaded, key] = await Promise.all([loadProjects(), loadGeminiKey()]);
      setProjects(loaded);
      setApiKey(key);
      setIsLoaded(true);
    })();
  }, []);

  const createProject = useCallback(async () => {
    const title = newProjectTitle.trim();
    if (!title) return;
    const newProject: Project = {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
      title,
      createdAt: new Date().toISOString(),
      items: [],
    };
    const updated = [newProject, ...projects];
    setProjects(updated);
    await saveProjects(updated);
    setNewProjectTitle('');
    setIsNewProjectModal(false);
    router.push(`/project/${newProject.id}`);
  }, [newProjectTitle, projects, router]);

  const deleteProject = useCallback(
    (project: Project) => {
      Alert.alert(
        'プロジェクトを削除',
        `「${project.title}」を削除しますか？この操作は元に戻せません。`,
        [
          { text: 'キャンセル', style: 'cancel' },
          {
            text: '削除',
            style: 'destructive',
            onPress: async () => {
              const updated = projects.filter((p) => p.id !== project.id);
              setProjects(updated);
              await saveProjects(updated);
            },
          },
        ]
      );
    },
    [projects]
  );

  const startRename = useCallback((project: Project) => {
    setRenameTarget(project);
    setRenameTitle(project.title);
    setIsRenameModal(true);
  }, []);

  const doRename = useCallback(async () => {
    if (!renameTarget || !renameTitle.trim()) return;
    const updated = projects.map((p) =>
      p.id === renameTarget.id ? { ...p, title: renameTitle.trim() } : p
    );
    setProjects(updated);
    await saveProjects(updated);
    setIsRenameModal(false);
    setRenameTarget(null);
  }, [renameTarget, renameTitle, projects]);

  const saveSettings = useCallback(async () => {
    await saveGeminiKey(tempApiKey);
    setApiKey(tempApiKey);
    setIsSettingsModal(false);
  }, [tempApiKey]);

  const formatDate = (date: Date | string) => {
    const d = new Date(date);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  };

  const renderProject = ({ item }: { item: Project }) => (
    <TouchableOpacity
      style={styles.projectCard}
      onPress={() => router.push(`/project/${item.id}`)}
      activeOpacity={0.7}
    >
      <View style={styles.projectCardInner}>
        <View style={styles.projectIconContainer}>
          <Ionicons name="folder" size={32} color="#3b82f6" />
        </View>
        <View style={styles.projectInfo}>
          <Text style={styles.projectTitle} numberOfLines={2}>
            {item.title}
          </Text>
          <Text style={styles.projectMeta}>
            {item.items.length} ページ　{formatDate(item.createdAt)}
          </Text>
        </View>
        <View style={styles.projectActions}>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => startRename(item)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="pencil-outline" size={18} color="#6b7280" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => deleteProject(item)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="trash-outline" size={18} color="#ef4444" />
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  );

  if (!isLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>読み込み中...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#1e40af" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Ionicons name="document-text" size={28} color="#fff" />
          <Text style={styles.headerTitle}>ReportMemo</Text>
        </View>
        <TouchableOpacity
          style={styles.settingsBtn}
          onPress={() => {
            setTempApiKey(apiKey);
            setIsSettingsModal(true);
          }}
        >
          <Ionicons name="settings-outline" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Project List */}
      <FlatList
        data={projects}
        keyExtractor={(item) => item.id}
        renderItem={renderProject}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="folder-open-outline" size={64} color="#d1d5db" />
            <Text style={styles.emptyTitle}>プロジェクトがありません</Text>
            <Text style={styles.emptySubtitle}>
              下の「＋」ボタンからプロジェクトを作成してください
            </Text>
          </View>
        }
      />

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setIsNewProjectModal(true)}
        activeOpacity={0.8}
      >
        <Ionicons name="add" size={32} color="#fff" />
      </TouchableOpacity>

      {/* New Project Modal */}
      <Modal
        visible={isNewProjectModal}
        transparent
        animationType="fade"
        onRequestClose={() => setIsNewProjectModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>新しいプロジェクト</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="プロジェクト名を入力"
              value={newProjectTitle}
              onChangeText={setNewProjectTitle}
              autoFocus
              onSubmitEditing={createProject}
              returnKeyType="done"
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.cancelBtn]}
                onPress={() => {
                  setIsNewProjectModal(false);
                  setNewProjectTitle('');
                }}
              >
                <Text style={styles.cancelBtnText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.confirmBtn, !newProjectTitle.trim() && styles.disabledBtn]}
                onPress={createProject}
                disabled={!newProjectTitle.trim()}
              >
                <Text style={styles.confirmBtnText}>作成</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Rename Modal */}
      <Modal
        visible={isRenameModal}
        transparent
        animationType="fade"
        onRequestClose={() => setIsRenameModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>プロジェクト名を変更</Text>
            <TextInput
              style={styles.modalInput}
              value={renameTitle}
              onChangeText={setRenameTitle}
              autoFocus
              onSubmitEditing={doRename}
              returnKeyType="done"
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.cancelBtn]}
                onPress={() => setIsRenameModal(false)}
              >
                <Text style={styles.cancelBtnText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.confirmBtn]}
                onPress={doRename}
              >
                <Text style={styles.confirmBtnText}>変更</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Settings Modal */}
      <Modal
        visible={isSettingsModal}
        transparent
        animationType="slide"
        onRequestClose={() => setIsSettingsModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, styles.settingsCard]}>
            <Text style={styles.modalTitle}>設定</Text>
            <Text style={styles.settingsLabel}>Gemini API キー</Text>
            <Text style={styles.settingsHint}>
              AI-OCR機能を使用するにはGoogle Gemini APIキーが必要です。
            </Text>
            <TextInput
              style={styles.modalInput}
              placeholder="AIzaSy..."
              value={tempApiKey}
              onChangeText={setTempApiKey}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.cancelBtn]}
                onPress={() => setIsSettingsModal(false)}
              >
                <Text style={styles.cancelBtnText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.confirmBtn]}
                onPress={saveSettings}
              >
                <Text style={styles.confirmBtnText}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#1e40af' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f8fafc' },
  loadingText: { fontSize: 16, color: '#6b7280' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1e40af',
    paddingHorizontal: 20,
    paddingVertical: 16,
    paddingTop: Platform.OS === 'android' ? 16 : 8,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff' },
  settingsBtn: { padding: 4 },

  listContent: { flexGrow: 1, padding: 16, backgroundColor: '#f8fafc' },

  projectCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 3,
  },
  projectCardInner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  projectIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: '#eff6ff',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  projectInfo: { flex: 1 },
  projectTitle: { fontSize: 16, fontWeight: '600', color: '#111827', marginBottom: 4 },
  projectMeta: { fontSize: 13, color: '#6b7280' },
  projectActions: { flexDirection: 'row', gap: 8 },
  actionBtn: { padding: 6 },

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

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 480,
  },
  settingsCard: { maxWidth: 520 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#111827', marginBottom: 16 },
  modalInput: {
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    color: '#111827',
    marginBottom: 20,
    backgroundColor: '#f9fafb',
  },
  modalButtons: { flexDirection: 'row', gap: 12 },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  cancelBtn: { backgroundColor: '#f3f4f6' },
  cancelBtnText: { fontSize: 15, fontWeight: '600', color: '#6b7280' },
  confirmBtn: { backgroundColor: '#2563eb' },
  confirmBtnText: { fontSize: 15, fontWeight: '600', color: '#fff' },
  disabledBtn: { backgroundColor: '#93c5fd' },

  settingsLabel: { fontSize: 14, fontWeight: '600', color: '#374151', marginBottom: 4 },
  settingsHint: { fontSize: 13, color: '#6b7280', marginBottom: 12 },
});
