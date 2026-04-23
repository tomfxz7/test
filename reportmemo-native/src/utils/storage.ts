import AsyncStorage from '@react-native-async-storage/async-storage';
import { Project } from '../types';

const PROJECTS_KEY = 'eval_report_projects';
const GEMINI_KEY = 'gemini_api_key';

export const loadProjects = async (): Promise<Project[]> => {
  try {
    const raw = await AsyncStorage.getItem(PROJECTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((p: Project) => ({
      ...p,
      id: p.id || Date.now().toString() + Math.random().toString(36).slice(2, 7),
      createdAt: p.createdAt || new Date().toISOString(),
      items: (p.items || []).map((item) => ({
        ...item,
        id: item.id || Date.now().toString() + Math.random().toString(36).slice(2, 7),
        images: item.images || [],
      })),
    }));
  } catch (e) {
    console.error('loadProjects error:', e);
    return [];
  }
};

export const saveProjects = async (projects: Project[]): Promise<void> => {
  try {
    await AsyncStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  } catch (e) {
    console.error('saveProjects error:', e);
  }
};

export const loadGeminiKey = async (): Promise<string> => {
  try {
    return (await AsyncStorage.getItem(GEMINI_KEY)) || '';
  } catch {
    return '';
  }
};

export const saveGeminiKey = async (key: string): Promise<void> => {
  try {
    await AsyncStorage.setItem(GEMINI_KEY, key);
  } catch (e) {
    console.error('saveGeminiKey error:', e);
  }
};
