import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Image,
  ScrollView,
  Alert,
  SafeAreaView,
  ActivityIndicator,
  Dimensions,
  Platform,
  Modal,
  KeyboardAvoidingView,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { loadProjects, saveProjects, loadGeminiKey } from '../../../src/utils/storage';
import { ocrImageWithGemini } from '../../../src/utils/gemini';
import { shareImage } from '../../../src/utils/pptxExport';
import { Project, MemoItem, ImageData, Annotation } from '../../../src/types';
import DrawingCanvas from '../../../src/components/DrawingCanvas';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function EditorScreen() {
  const { projectId, itemId } = useLocalSearchParams<{ projectId: string; itemId: string }>();
  const router = useRouter();

  const [project, setProject] = useState<Project | null>(null);
  const [item, setItem] = useState<MemoItem | null>(null);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [memo, setMemo] = useState('');
  const [images, setImages] = useState<ImageData[]>([]);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [isOcrLoading, setIsOcrLoading] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    (async () => {
      const [projects, key] = await Promise.all([loadProjects(), loadGeminiKey()]);
      setAllProjects(projects);
      setApiKey(key);
      const proj = projects.find((p) => p.id === projectId);
      if (proj) {
        setProject(proj);
        const foundItem = proj.items.find((i) => i.id === itemId);
        if (foundItem) {
          setItem(foundItem);
          setMemo(foundItem.memo || '');
          setImages(foundItem.images || []);
        }
      }
      setIsLoading(false);
    })();
  }, [projectId, itemId]);

  const saveItem = useCallback(
    async (updatedMemo?: string, updatedImages?: ImageData[]) => {
      if (!project || !item) return;
      setIsSaving(true);
      try {
        const finalMemo = updatedMemo !== undefined ? updatedMemo : memo;
        const finalImages = updatedImages !== undefined ? updatedImages : images;
        const updatedItem: MemoItem = {
          ...item,
          memo: finalMemo,
          images: finalImages,
          updatedAt: new Date().toISOString(),
        };
        const updatedProject = {
          ...project,
          items: project.items.map((i) => (i.id === item.id ? updatedItem : i)),
        };
        const updatedProjects = allProjects.map((p) =>
          p.id === project.id ? updatedProject : p
        );
        setProject(updatedProject);
        setAllProjects(updatedProjects);
        setItem(updatedItem);
        await saveProjects(updatedProjects);
        setHasChanges(false);
      } catch (e) {
        Alert.alert('保存エラー', String(e));
      } finally {
        setIsSaving(false);
      }
    },
    [project, item, memo, images, allProjects]
  );

  const handleBack = useCallback(async () => {
    if (hasChanges) {
      await saveItem();
    }
    router.back();
  }, [hasChanges, saveItem, router]);

  const pickFromCamera = useCallback(async () => {
    setShowImagePicker(false);
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('カメラの許可が必要です', '設定からカメラへのアクセスを許可してください。');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsEditing: false,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const newImage: ImageData = {
        id: Date.now().toString() + Math.random().toString(36).slice(2, 5),
        uri: asset.uri,
        width: asset.width || 1200,
        height: asset.height || 800,
        annotations: [],
      };
      const updatedImages = [...images, newImage];
      setImages(updatedImages);
      setActiveImageIndex(updatedImages.length - 1);
      setHasChanges(true);
      await saveItem(memo, updatedImages);
    }
  }, [images, memo, saveItem]);

  const pickFromLibrary = useCallback(async () => {
    setShowImagePicker(false);
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('フォトライブラリの許可が必要です', '設定からフォトライブラリへのアクセスを許可してください。');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsMultipleSelection: true,
      selectionLimit: 10,
    });
    if (!result.canceled && result.assets.length > 0) {
      const newImages: ImageData[] = result.assets.map((asset) => ({
        id: Date.now().toString() + Math.random().toString(36).slice(2, 5),
        uri: asset.uri,
        width: asset.width || 1200,
        height: asset.height || 800,
        annotations: [],
      }));
      const updatedImages = [...images, ...newImages];
      setImages(updatedImages);
      setActiveImageIndex(updatedImages.length - 1);
      setHasChanges(true);
      await saveItem(memo, updatedImages);
    }
  }, [images, memo, saveItem]);

  const deleteImage = useCallback(
    (index: number) => {
      Alert.alert('画像を削除', 'この画像を削除しますか？', [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除',
          style: 'destructive',
          onPress: async () => {
            const updatedImages = images.filter((_, i) => i !== index);
            setImages(updatedImages);
            setActiveImageIndex(Math.min(activeImageIndex, updatedImages.length - 1));
            setHasChanges(true);
            await saveItem(memo, updatedImages);
          },
        },
      ]);
    },
    [images, activeImageIndex, memo, saveItem]
  );

  const handleOCR = useCallback(async () => {
    if (!apiKey) {
      Alert.alert('APIキー未設定', 'ホーム画面の設定からGemini APIキーを設定してください。');
      return;
    }
    if (images.length === 0) {
      Alert.alert('画像がありません', 'まず画像を追加してください。');
      return;
    }
    const activeImage = images[activeImageIndex];
    if (!activeImage) return;
    setIsOcrLoading(true);
    try {
      const base64 = await FileSystem.readAsStringAsync(activeImage.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const text = await ocrImageWithGemini(base64, apiKey);
      if (text && text !== 'テキストなし') {
        const newMemo = memo ? `${memo}\n\n${text}` : text;
        setMemo(newMemo);
        setHasChanges(true);
        await saveItem(newMemo, images);
        Alert.alert('OCR完了', 'テキストをメモに追加しました。');
      } else {
        Alert.alert('テキストなし', '画像内にテキストが見つかりませんでした。');
      }
    } catch (e) {
      Alert.alert('OCRエラー', String(e));
    } finally {
      setIsOcrLoading(false);
    }
  }, [apiKey, images, activeImageIndex, memo, saveItem]);

  const updateAnnotations = useCallback(
    async (annotations: Annotation[]) => {
      if (images.length === 0) return;
      const updatedImages = images.map((img, i) =>
        i === activeImageIndex ? { ...img, annotations } : img
      );
      setImages(updatedImages);
      setHasChanges(true);
      await saveItem(memo, updatedImages);
    },
    [images, activeImageIndex, memo, saveItem]
  );

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  if (!project || !item) {
    return (
      <View style={styles.loadingContainer}>
        <Text>アイテムが見つかりません</Text>
      </View>
    );
  }

  const activeImage = images[activeImageIndex];

  return (
    <SafeAreaView style={styles.safeArea}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: project.title,
          headerStyle: { backgroundColor: '#1e40af' },
          headerTintColor: '#fff',
          headerLeft: () => (
            <TouchableOpacity onPress={handleBack} style={{ marginLeft: 4 }}>
              <Ionicons name="chevron-back" size={24} color="#fff" />
            </TouchableOpacity>
          ),
          headerRight: () => (
            <View style={{ flexDirection: 'row', gap: 8, marginRight: 4 }}>
              {isSaving && <ActivityIndicator size="small" color="#fff" />}
              <TouchableOpacity
                onPress={() => saveItem()}
                disabled={isSaving}
              >
                <Ionicons name="save-outline" size={24} color="#fff" />
              </TouchableOpacity>
            </View>
          ),
        }}
      />

      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={88}
      >
        {/* Image Area */}
        <View style={styles.imageArea}>
          {images.length === 0 ? (
            <TouchableOpacity
              style={styles.addImagePlaceholder}
              onPress={() => setShowImagePicker(true)}
            >
              <Ionicons name="camera-outline" size={48} color="#9ca3af" />
              <Text style={styles.addImageText}>タップして写真を追加</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.imageContainer}>
              {isDrawingMode && activeImage ? (
                <DrawingCanvas
                  imageUri={activeImage.uri}
                  imageWidth={activeImage.width}
                  imageHeight={activeImage.height}
                  annotations={activeImage.annotations}
                  onAnnotationsChange={updateAnnotations}
                  onClose={() => setIsDrawingMode(false)}
                />
              ) : (
                <TouchableOpacity
                  style={styles.imageWrapper}
                  onPress={() => setIsDrawingMode(true)}
                  activeOpacity={0.95}
                >
                  <Image
                    source={{ uri: activeImage?.uri }}
                    style={styles.mainImage}
                    resizeMode="contain"
                  />
                  {activeImage && activeImage.annotations.length > 0 && (
                    <View style={styles.annotationBadge}>
                      <Ionicons name="pencil" size={12} color="#fff" />
                      <Text style={styles.annotationBadgeText}>
                        {activeImage.annotations.length}
                      </Text>
                    </View>
                  )}
                  <View style={styles.editHint}>
                    <Ionicons name="pencil-outline" size={14} color="#fff" />
                    <Text style={styles.editHintText}>タップして描画</Text>
                  </View>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Image Toolbar */}
          <View style={styles.imageToolbar}>
            <TouchableOpacity
              style={styles.toolbarBtn}
              onPress={() => setShowImagePicker(true)}
            >
              <Ionicons name="add-circle-outline" size={22} color="#2563eb" />
              <Text style={styles.toolbarBtnText}>追加</Text>
            </TouchableOpacity>

            {images.length > 0 && (
              <>
                <TouchableOpacity
                  style={styles.toolbarBtn}
                  onPress={() => setIsDrawingMode(!isDrawingMode)}
                >
                  <Ionicons
                    name={isDrawingMode ? 'close-circle-outline' : 'pencil-outline'}
                    size={22}
                    color={isDrawingMode ? '#ef4444' : '#2563eb'}
                  />
                  <Text style={[styles.toolbarBtnText, isDrawingMode && { color: '#ef4444' }]}>
                    {isDrawingMode ? '描画終了' : '描画'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.toolbarBtn}
                  onPress={handleOCR}
                  disabled={isOcrLoading}
                >
                  {isOcrLoading ? (
                    <ActivityIndicator size="small" color="#2563eb" />
                  ) : (
                    <Ionicons name="scan-outline" size={22} color="#2563eb" />
                  )}
                  <Text style={styles.toolbarBtnText}>OCR</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.toolbarBtn}
                  onPress={() => activeImage && shareImage(activeImage.uri)}
                >
                  <Ionicons name="share-outline" size={22} color="#2563eb" />
                  <Text style={styles.toolbarBtnText}>共有</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.toolbarBtn}
                  onPress={() => deleteImage(activeImageIndex)}
                >
                  <Ionicons name="trash-outline" size={22} color="#ef4444" />
                  <Text style={[styles.toolbarBtnText, { color: '#ef4444' }]}>削除</Text>
                </TouchableOpacity>
              </>
            )}
          </View>

          {/* Image Thumbnails */}
          {images.length > 1 && (
            <ScrollView
              horizontal
              style={styles.thumbnailStrip}
              contentContainerStyle={styles.thumbnailStripContent}
              showsHorizontalScrollIndicator={false}
            >
              {images.map((img, index) => (
                <TouchableOpacity
                  key={img.id}
                  style={[
                    styles.thumbItem,
                    index === activeImageIndex && styles.thumbItemActive,
                  ]}
                  onPress={() => setActiveImageIndex(index)}
                >
                  <Image source={{ uri: img.uri }} style={styles.thumbImage} resizeMode="cover" />
                  <Text style={styles.thumbNumber}>{index + 1}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>

        {/* Memo Area */}
        <View style={styles.memoArea}>
          <View style={styles.memoHeader}>
            <Ionicons name="document-text-outline" size={18} color="#374151" />
            <Text style={styles.memoLabel}>メモ</Text>
          </View>
          <TextInput
            style={styles.memoInput}
            multiline
            placeholder="メモを入力してください..."
            value={memo}
            onChangeText={(text) => {
              setMemo(text);
              setHasChanges(true);
            }}
            onBlur={() => hasChanges && saveItem()}
            textAlignVertical="top"
            placeholderTextColor="#9ca3af"
          />
        </View>
      </KeyboardAvoidingView>

      {/* Image Source Picker Modal */}
      <Modal
        visible={showImagePicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowImagePicker(false)}
      >
        <TouchableOpacity
          style={styles.pickerOverlay}
          activeOpacity={1}
          onPress={() => setShowImagePicker(false)}
        >
          <View style={styles.pickerSheet}>
            <Text style={styles.pickerTitle}>画像を追加</Text>
            <TouchableOpacity style={styles.pickerOption} onPress={pickFromCamera}>
              <Ionicons name="camera" size={28} color="#2563eb" />
              <Text style={styles.pickerOptionText}>カメラで撮影</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.pickerOption} onPress={pickFromLibrary}>
              <Ionicons name="images" size={28} color="#2563eb" />
              <Text style={styles.pickerOptionText}>フォトライブラリから選択</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.pickerOption, styles.pickerCancel]}
              onPress={() => setShowImagePicker(false)}
            >
              <Text style={styles.pickerCancelText}>キャンセル</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f8fafc' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  container: { flex: 1 },

  imageArea: { flex: 1, backgroundColor: '#1a1a2e' },
  addImagePlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  addImageText: { fontSize: 16, color: '#6b7280' },

  imageContainer: { flex: 1 },
  imageWrapper: { flex: 1, position: 'relative' },
  mainImage: { flex: 1, width: '100%' },
  annotationBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: '#2563eb',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  annotationBadgeText: { fontSize: 12, color: '#fff', fontWeight: '700' },
  editHint: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  editHintText: { fontSize: 12, color: '#fff' },

  imageToolbar: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    gap: 4,
  },
  toolbarBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    gap: 2,
  },
  toolbarBtnText: { fontSize: 11, color: '#2563eb', fontWeight: '500' },

  thumbnailStrip: { maxHeight: 72, backgroundColor: '#f3f4f6' },
  thumbnailStripContent: { padding: 8, gap: 8 },
  thumbItem: {
    width: 56,
    height: 56,
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
    position: 'relative',
  },
  thumbItemActive: { borderColor: '#2563eb' },
  thumbImage: { width: '100%', height: '100%' },
  thumbNumber: {
    position: 'absolute',
    bottom: 1,
    right: 2,
    fontSize: 10,
    color: '#fff',
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },

  memoArea: {
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    maxHeight: 200,
    minHeight: 120,
  },
  memoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  memoLabel: { fontSize: 14, fontWeight: '600', color: '#374151' },
  memoInput: {
    flex: 1,
    padding: 16,
    paddingTop: 8,
    fontSize: 15,
    color: '#111827',
    lineHeight: 22,
  },

  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  pickerTitle: { fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 20, textAlign: 'center' },
  pickerOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  pickerOptionText: { fontSize: 16, color: '#111827', fontWeight: '500' },
  pickerCancel: { borderBottomWidth: 0, justifyContent: 'center', marginTop: 8 },
  pickerCancelText: { fontSize: 16, color: '#ef4444', fontWeight: '600', textAlign: 'center', flex: 1 },
});
