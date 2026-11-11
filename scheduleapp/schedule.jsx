import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Clock,
  Plus,
  AlertCircle,
  Calendar,
  Settings,
  Layout,
  GripVertical,
  X,
  Trash2,
  ArrowLeft,
  CalendarDays,
  Pencil,
  CheckSquare,
  Link as LinkIcon,
  Download,
  Upload,
  Loader2,
  List,
  Search,
  Image as ImageIcon,
  ChevronDown,
  ChevronRight,
  Bell,
  FileSpreadsheet,
  MonitorPlay,
  FileText,
  Repeat,
  Table2,
  Minus,
  Home,
  MessageSquare,
  Filter
} from 'lucide-react';

// --- IndexedDB Configuration & Utils ---
const DB_NAME = 'TaskMatrixAppDB';
const DB_VERSION = 1;
const STORE_NAME = 'appData';

const initDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const saveToDB = async (key, data) => {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(data, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error("IndexedDB save error", e);
  }
};

const loadFromDB = async (key) => {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error("IndexedDB load error", e);
    return null;
  }
};

// File handles are kept separately from exported data. Only an explicit picker
// selection connects a file; importing data never changes the connected handle.
const FILE_BACKUP_KEY = 'fileBackupSettings';
const storeFileBackupSettings = async (settings) => {
  const db = await initDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(settings, FILE_BACKUP_KEY);
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('保存先を記憶できませんでした'));
    });
  } finally { db.close(); }
};

function useFileBackup(data, isDBReady) {
  const content = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const contentRef = useRef(content);
  contentRef.current = content;
  const settingsRef = useRef({ handle: null, enabled: true, lastSavedAt: null });
  const settingsQueue = useRef(Promise.resolve());
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  const observedContent = useRef(null);
  const [status, setStatus] = useState('unconnected');
  const [message, setMessage] = useState('');
  const [settingsWarning, setSettingsWarning] = useState('');
  const [settings, setSettings] = useState({ name: '', enabled: true, lastSavedAt: null });
  const [ready, setReady] = useState(false);
  const supported = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

  const persistSettings = () => {
    const snapshot = { ...settingsRef.current };
    settingsQueue.current = settingsQueue.current.catch(() => {}).then(() => storeFileBackupSettings(snapshot));
    settingsQueue.current.then(() => setSettingsWarning(''), () => setSettingsWarning('保存先を記憶できませんでした。次回は保存先を選び直してください。'));
  };
  const refreshSettings = () => setSettings({ name: settingsRef.current.handle?.name || '', enabled: settingsRef.current.enabled, lastSavedAt: settingsRef.current.lastSavedAt });

  useEffect(() => {
    let cancelled = false;
    loadFromDB(FILE_BACKUP_KEY).then(saved => {
      if (cancelled) return;
      if (saved) {
        const handle = typeof saved.handle?.createWritable === 'function' ? saved.handle : null;
        settingsRef.current = { handle, enabled: saved.enabled !== false, lastSavedAt: handle ? saved.lastSavedAt || null : null };
        refreshSettings();
        if (handle) {
          setStatus('ready');
          setMessage('保存先を復元しました。必要な場合は「今すぐ保存」で書き込みを許可してください。');
        }
      }
      setReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  const writeNow = async (requestPermission = false) => {
    const handle = settingsRef.current.handle;
    if (!handle || busyRef.current || !isDBReady) return;
    busyRef.current = true;
    dirtyRef.current = true;
    setStatus('saving');
    setMessage('');
    try {
      let permission = handle.queryPermission ? await handle.queryPermission({ mode: 'readwrite' }) : 'granted';
      if (permission !== 'granted' && requestPermission && handle.requestPermission) permission = await handle.requestPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        setStatus('permission');
        setMessage('書き込みの許可が必要です。「今すぐ保存」を押して許可してください。');
        return;
      }
      // Serialize writes, including changes made while an earlier write is in
      // flight. Never allow an old snapshot to finish after a newer snapshot.
      do {
        const snapshot = contentRef.current;
        const writable = await handle.createWritable();
        try {
          await writable.write(snapshot);
          await writable.close();
        } catch (error) {
          try { await writable.abort(); } catch { /* Preserve the original error. */ }
          throw error;
        }
        settingsRef.current.lastSavedAt = new Date().toISOString();
        dirtyRef.current = snapshot !== contentRef.current;
        refreshSettings();
        persistSettings();
      } while (dirtyRef.current && settingsRef.current.enabled);
      setStatus(dirtyRef.current ? 'pending' : 'saved');
    } catch (error) {
      setStatus(error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'permission' : 'error');
      setMessage(error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
        ? 'ファイルに書き込めません。「今すぐ保存」で許可するか、保存先を選び直してください。'
        : 'ファイルへの保存に失敗しました。保存先を確認して再試行してください。');
    } finally { busyRef.current = false; }
  };

  useEffect(() => {
    if (!ready || !isDBReady) return;
    if (observedContent.current === null) { observedContent.current = content; return; }
    if (observedContent.current !== content) {
      observedContent.current = content;
      if (settingsRef.current.handle) {
        dirtyRef.current = true;
        if (!busyRef.current) setStatus('pending');
      }
    }
    if (!settingsRef.current.handle || !settings.enabled || !dirtyRef.current) return;
    const timer = setTimeout(() => writeNow(), 1000);
    return () => clearTimeout(timer);
  }, [content, ready, isDBReady, settings.enabled]);

  useEffect(() => {
    const beforeUnload = event => {
      if (!settingsRef.current.handle || (!dirtyRef.current && !busyRef.current)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  const chooseDestination = async () => {
    if (!supported || !ready || busyRef.current) return;
    busyRef.current = true;
    const previousStatus = status;
    setStatus('choosing');
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: `taskmatrix_backup_${formatDate(new Date())}.json`,
        types: [{ description: 'TaskMatrix バックアップ（JSON）', accept: { 'application/json': ['.json'] } }]
      });
      settingsRef.current = { handle, enabled: settingsRef.current.enabled, lastSavedAt: null };
      dirtyRef.current = true;
      refreshSettings();
      persistSettings();
      busyRef.current = false;
      await writeNow(true);
    } catch (error) {
      if (error?.name === 'AbortError') setStatus(previousStatus);
      else { setStatus('error'); setMessage('保存先を選択できませんでした。別のファイルを選んで再試行してください。'); }
    } finally { busyRef.current = false; }
  };
  const setEnabled = enabled => {
    settingsRef.current.enabled = enabled;
    refreshSettings();
    persistSettings();
  };
  const disconnect = () => {
    if (busyRef.current) return;
    settingsRef.current = { handle: null, enabled: settingsRef.current.enabled, lastSavedAt: null };
    dirtyRef.current = false;
    refreshSettings();
    persistSettings();
    setStatus('unconnected');
    setMessage('保存先の接続を解除しました。保存済みのファイルは残ります。');
  };
  return { ...settings, ready, supported, status, message, settingsWarning, chooseDestination, writeNow, setEnabled, disconnect };
}

// --- Utility Functions ---

const getLocalDate = (val) => {
  if (typeof val === 'string' && val.includes('-')) {
    const [y, m, d] = val.split('-');
    return new Date(y, m - 1, d);
  }
  return new Date(val);
};

const formatDate = (date) => {
  const d = getLocalDate(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const TODAY_STR = formatDate(new Date());

const getMonday = (date) => {
  const dt = getLocalDate(date);
  const day = dt.getDay();
  const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(dt.setDate(diff));
};

const addDays = (date, days) => {
  const result = getLocalDate(date);
  result.setDate(result.getDate() + days);
  return result;
};

const getWeekNumber = (dateVal) => {
  const date = getLocalDate(dateVal);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  const week1 = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
};


const addMonths = (date, months) => {
  const src = getLocalDate(date);
  const result = new Date(src);
  const targetMonth = result.getMonth() + months;
  const originalDate = result.getDate();
  result.setDate(1);
  result.setMonth(targetMonth);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(originalDate, lastDay));
  return result;
};

const getRecurringStepDate = (date, frequency, interval = 1) => {
  const safeInterval = Math.max(1, Number(interval) || 1);
  if (frequency === 'daily') return addDays(date, safeInterval);
  if (frequency === 'monthly') return addMonths(date, safeInterval);
  return addDays(date, safeInterval * 7);
};

const WEEKDAY_OPTIONS = [
  { value: 1, label: '月曜日' },
  { value: 2, label: '火曜日' },
  { value: 3, label: '水曜日' },
  { value: 4, label: '木曜日' },
  { value: 5, label: '金曜日' },
  { value: 6, label: '土曜日' },
  { value: 0, label: '日曜日' }
];

const getWeekdayOffsetFromMonday = (dayOfWeek) => dayOfWeek === 0 ? 6 : dayOfWeek - 1;

const getSafeMonthDay = (year, monthIndex, dayOfMonth) => {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return Math.min(Math.max(1, Number(dayOfMonth) || 1), lastDay);
};

const getScheduleWeekday = (schedule) => (
  schedule.dayOfWeek !== undefined && schedule.dayOfWeek !== ''
    ? Number(schedule.dayOfWeek)
    : getLocalDate(schedule.startDate).getDay()
);

const getScheduleMonthDay = (schedule) => (
  schedule.dayOfMonth !== undefined && schedule.dayOfMonth !== ''
    ? Number(schedule.dayOfMonth)
    : getLocalDate(schedule.startDate).getDate()
);

const getRecurringFirstOccurrenceDate = (schedule) => {
  const startDate = getLocalDate(schedule.startDate);

  if (schedule.frequency === 'weekly') {
    const weekStart = getMonday(startDate);
    const first = addDays(weekStart, getWeekdayOffsetFromMonday(getScheduleWeekday(schedule)));
    return first < startDate ? addDays(first, 7) : first;
  }

  if (schedule.frequency === 'monthly') {
    const dayOfMonth = getScheduleMonthDay(schedule);
    const first = new Date(
      startDate.getFullYear(),
      startDate.getMonth(),
      getSafeMonthDay(startDate.getFullYear(), startDate.getMonth(), dayOfMonth)
    );
    return first < startDate ? getRecurringNextOccurrenceDate(schedule, first, 1) : first;
  }

  return startDate;
};

const getRecurringNextOccurrenceDate = (schedule, date, steps = 1) => {
  const next = getRecurringStepDate(date, schedule.frequency, (schedule.interval || 1) * steps);

  if (schedule.frequency === 'monthly') {
    return new Date(
      next.getFullYear(),
      next.getMonth(),
      getSafeMonthDay(next.getFullYear(), next.getMonth(), getScheduleMonthDay(schedule))
    );
  }

  return next;
};

const getFrequencyLabel = (frequency, interval = 1) => {
  const safeInterval = Math.max(1, Number(interval) || 1);
  const unit = frequency === 'daily' ? '日' : frequency === 'monthly' ? 'か月' : '週';
  return safeInterval === 1 ? `毎${unit}` : `${safeInterval}${unit}ごと`;
};

const buildRecurringOccurrenceId = (scheduleId, date) => `rec_${scheduleId}_${date}`;

// Progress shares the canonical task/subtask records with the calendar and backups.
const progressEntryIsNote = entry => !!(entry?.plainComment || entry?.assumptionMemo);
const createProgressId = () => globalThis.crypto?.randomUUID?.() || `progress_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const getProgressSmallTasks = (subtask) => (subtask?.smallTasks || []).map((small, index) => ({
  ...small, id: small.id || `${subtask.id}-small-${index}`
}));
const getProgressSubtasks = (task) => (task.subtasks || []).map((subtask, index) => {
  const normalized = { ...subtask, id: subtask.id || `${task.id}-sub-${index}`, dueDate: subtask.dueDate || task.dueDate };
  return subtask.smallTasks ? { ...normalized, smallTasks: getProgressSmallTasks(normalized) } : normalized;
});
const progressTodoOriginText = (title, dueDate) => `${dueDate || '期限未設定'}までに【${title}】`;
const progressEntrySubtaskTitles = (task, entry) => entry.subtaskIds?.length
  ? entry.subtaskIds.map((id, index) => getProgressSubtasks(task).find(st => st.id === id)?.title || entry.subtaskTitles?.[index] || '名称未記録')
  : entry.subtaskTitles || [];
const removeProgressSmallTask = (task, id) => ({
  ...task,
  deletedProgressSmallTaskIds: [...new Set([...(task.deletedProgressSmallTaskIds || []), id])],
  subtasks: getProgressSubtasks(task).map(st => {
    const smallTasks = getProgressSmallTasks(st);
    return smallTasks.some(small => small.id === id)
      ? { ...st, smallTasks: smallTasks.filter(small => small.id !== id) } : st;
  })
});
const syncRemovedProgressTodos = (previous, next) => {
  if (!previous) return next;
  const retained = new Set(getProgressSubtasks(next).map(parent => parent.id));
  const removed = new Set(getProgressSubtasks(previous).filter(parent => !retained.has(parent.id)).map(parent => parent.id));
  if (!removed.size) return next;
  const history = next.progressHistory || [];
  const removedOrigin = entry => entry.addedSubtask && !entry.smallTaskId && (entry.subtaskIds || []).some(id => removed.has(id));
  // Converting a todo rewrites its creation comment into a small-task origin.
  // Keep such rewritten records; tombstone only deleted creation comments.
  const deleted = new Set([...history.filter(removedOrigin).map(entry => entry.id), ...(previous.progressHistory || []).filter(entry => removedOrigin(entry) && !history.some(current => current.id === entry.id)).map(entry => entry.id)]);
  return { ...next, deletedProgressSubtaskIds: [...new Set([...(next.deletedProgressSubtaskIds || []), ...removed])],
    deletedProgressEntryIds: [...new Set([...(next.deletedProgressEntryIds || []), ...deleted])],
    progressHistory: history.filter(entry => !deleted.has(entry.id)) };
};
const removeProgressTodo = (task, id) => syncRemovedProgressTodos(task, { ...task, subtasks: getProgressSubtasks(task).filter(parent => parent.id !== id) });
const addProgressTodoDependency = (parents, source, added) => {
  if (!source || source.id === added.id) return parents;
  const reference = { kind: 'subtask', id: added.id, title: added.title };
  const link = node => ({ ...node, dependencies: [...(node.dependencies || []), reference].filter((ref, index, refs) => refs.findIndex(item => progressDependencyKey(item) === progressDependencyKey(ref)) === index) });
  return parents.map(parent => source.kind === 'subtask' ? parent.id === source.id ? link(parent) : parent
    : parent.id === source.parentId ? { ...parent, smallTasks: getProgressSmallTasks(parent).map(small => small.id === source.id ? link(small) : small) } : parent);
};
// Explicit completion state wins over older completed comments after reopening.
const getCompletedProgressSmallIds = task => {
  const managed = new Map(getProgressSubtasks(task).flatMap(st => getProgressSmallTasks(st))
    .filter(small => small.completionManaged).map(small => [small.id, small.completed]));
  const ids = [
    ...(task.completedSmallTaskIds || []),
    ...getProgressSubtasks(task).flatMap(st => getProgressSmallTasks(st).filter(small => small.completed).map(small => small.id)),
    ...(task.progressHistory || []).filter(entry => entry.kind === 'comment' && (entry.completedSmallTaskId || (!Array.isArray(entry.completedSubtaskIds) && entry.smallTaskId))
      && entry.status === 'completed' && !progressEntryIsNote(entry)
      && (entry.completedSmallTaskId || !entry.addedSmallTask || !entry.quote || entry.quote.smallTaskId === entry.smallTaskId)).map(entry => entry.completedSmallTaskId || entry.smallTaskId)
  ];
  return new Set(ids.filter(id => !managed.has(id) || managed.get(id)));
};
const latestProgressCompletion = (task, id) => (task.progressHistory || []).filter(entry => entry.kind === 'comment'
  && (entry.completedSmallTaskId || (!Array.isArray(entry.completedSubtaskIds) && entry.smallTaskId)) === id && entry.status === 'completed' && !progressEntryIsNote(entry)
  && (entry.completedSmallTaskId || !entry.addedSmallTask || !entry.quote || entry.quote.smallTaskId === id))
  .reduce((latest, entry) => !latest || (Date.parse(entry.editedAt || entry.createdAt) || 0) >= (Date.parse(latest.editedAt || latest.createdAt) || 0) ? entry : latest, null);
const completeProgressSmallTask = (task, id, conclusion) => ({
  ...task, completedSmallTaskIds: [...new Set([...(task.completedSmallTaskIds || []), id])],
  subtasks: getProgressSubtasks(task).map(st => getProgressSmallTasks(st).some(small => small.id === id)
    ? { ...st, smallTasks: getProgressSmallTasks(st).map(small => small.id === id ? {
      ...small, completed: true, waiting: false, completionManaged: !!conclusion || !!small.completionManaged,
      ...(conclusion ? { completionEntryId: conclusion.id, completionConclusion: { ...conclusion } } : {})
    } : small) } : st)
});
const reopenProgressSmallTask = (task, id, waiting = false) => {
  const updated = { ...task, completed: false, completedSmallTaskIds: (task.completedSmallTaskIds || []).filter(value => value !== id),
    subtasks: getProgressSubtasks(task).map(st => {
      if (!getProgressSmallTasks(st).some(small => small.id === id)) return st;
      const parent = { ...st, completed: false, completionManaged: true, smallTasks: getProgressSmallTasks(st).map(small => {
        if (small.id !== id) return small;
        const reopened = { ...small, completed: false, waiting, completionManaged: true };
        delete reopened.completionEntryId; delete reopened.completionConclusion; delete reopened.completedAt;
        return reopened;
      }) };
      delete parent.completedAt; return parent;
    }) };
  delete updated.completedAt; return updated;
};
const restoreProgressTalks = task => {
  const source = task.progressHistory || [], deleted = new Set(task.deletedProgressEntryIds || []);
  const byId = new Map(source.map(entry => [entry.id, entry])), restored = [], resolved = new Map();
  const recover = (quote, reply) => {
    if (!quote) return;
    recover(quote.quote, quote);
    if (!quote.id || deleted.has(quote.id)) return;
    const currentReply = byId.get(reply.id) || reply;
    if (quote.status === 'waiting' && !deleted.has(reply.id) && !progressEntryIsNote(quote) && !progressEntryIsNote(currentReply)
      && currentReply.quote?.id === quote.id) resolved.set(quote.id, reply.id);
    if (!byId.has(quote.id) && (quote.addedSmallTask || (quote.status === 'waiting' && !progressEntryIsNote(quote)))) {
      const entry = { ...quote, kind: 'comment' }; byId.set(entry.id, entry); restored.push(entry);
    }
  };
  source.forEach(entry => recover(entry.quote, entry));
  if (!restored.length && ![...resolved.keys()].some(id => byId.has(id) && !byId.get(id).resolvedByReplyId)) return task;
  const history = [...restored, ...source].map(entry => resolved.has(entry.id) && !entry.resolvedByReplyId
    ? { ...entry, resolvedByReplyId: resolved.get(entry.id) } : entry);
  // Stable order for records with no timestamp; never invent a historical date.
  history.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
  return { ...task, progressHistory: history };
};
const progressWaitingScope = (task, entry) => {
  const source = (entry.addedSmallTask || entry.addedSubtask) && entry.quote ? entry.quote : entry;
  const parent = getProgressSubtasks(task).find(st => source.subtaskIds?.includes(st.id));
  if (source.smallTaskId && getProgressSmallTasks(parent).some(small => small.id === source.smallTaskId)) return `small:${source.smallTaskId}`;
  return parent ? `subtask:${parent.id}` : !source.subtaskIds?.length ? 'task' : null;
};
const syncProgressWaiting = task => {
  const pending = new Set((task.progressHistory || []).filter(entry => entry.kind === 'comment' && entry.status === 'waiting' && !progressEntryIsNote(entry) && !entry.resolvedByReplyId).map(entry => progressWaitingScope(task, entry)));
  const sync = (node, key) => node.completed ? node : pending.has(key) ? { ...node, waiting: true, waitingManaged: true } : node.waitingManaged ? { ...node, waiting: false } : node;
  return { ...sync(task, 'task'), subtasks: getProgressSubtasks(task).map(st => ({ ...sync(st, `subtask:${st.id}`), ...(st.smallTasks ? { smallTasks: getProgressSmallTasks(st).map(small => sync(small, `small:${small.id}`)) } : {}) })) };
};
const normalizeProgressTask = task => {
  // Older builds marked ordinary progress as a reply and closed unrelated waits.
  // Repair only verifiable cases; keep real replies and explicit manual clears.
  const waitingClosers = new Map((task.progressHistory || []).map(entry => [entry.id, entry]));
  task = { ...task, ...(task.progressHistory ? { progressHistory: task.progressHistory.map(entry => {
    const closer = waitingClosers.get(entry.resolvedByReplyId);
    if (entry.status !== 'waiting' || progressEntryIsNote(entry) || !closer || closer.kind !== 'comment'
      || closer.status !== 'active' || progressEntryIsNote(closer) || closer.quote) return entry;
    const reopened = { ...entry }; delete reopened.resolvedByReplyId; return reopened;
  }) } : {}) };
  let normalized = restoreProgressTalks({ ...task, ...(task.subtasks ? { subtasks: getProgressSubtasks(task) } : {}) });
  const liveHistory = normalized.progressHistory || [];
  const byId = new Map(liveHistory.map(entry => [entry.id, entry]));
  const missingCompletion = node => node.completionEntryId && (!byId.has(node.completionEntryId)
    || byId.get(node.completionEntryId).status !== 'completed' || progressEntryIsNote(byId.get(node.completionEntryId)));
  // Repair older saved data where a completion comment was undone/deleted but
  // its canonical flag and ledger were left behind. Preserve manual legacy flags.
  getProgressSubtasks(normalized).forEach(st => {
    if (st.completed && st.completionManaged && st.completionSource !== 'manual' && missingCompletion(st)) normalized = retractProgressCompletion(normalized, { completedSubtaskIds: [st.id] });
    getProgressSmallTasks(st).forEach(small => {
      if (small.completed && small.completionManaged && small.completionSource !== 'manual' && (missingCompletion(small)
        || (!latestProgressCompletion(normalized, small.id) && liveHistory.some(entry => entry.smallTaskId === small.id || entry.completedSmallTaskId === small.id)))) {
        normalized = reopenProgressSmallTask(normalized, small.id);
      }
    });
  });
  const records = [];
  const collect = entry => { if (!entry) return; records.push(entry); collect(entry.quote); };
  (normalized.progressHistory || []).forEach(collect);
  const completedIds = getCompletedProgressSmallIds(normalized);
  const missingIds = new Set([...completedIds, ...records.filter(entry => entry.smallTaskTitle || entry.addedSmallTask).map(entry => entry.smallTaskId).filter(Boolean)]);
  missingIds.forEach(id => {
    if (getProgressSubtasks(normalized).some(st => getProgressSmallTasks(st).some(small => small.id === id))
      || (normalized.deletedProgressSmallTaskIds || []).includes(id) || (normalized.deletedSmallTaskOriginIds || []).includes(id)) return;
    const info = records.find(entry => entry.smallTaskId === id && entry.subtaskIds?.some(parentId => getProgressSubtasks(normalized).some(st => st.id === parentId)));
    const parentId = info?.subtaskIds.find(parentId => getProgressSubtasks(normalized).some(st => st.id === parentId));
    if (!parentId) return;
    const latest = (normalized.progressHistory || []).filter(entry => entry.smallTaskId === id && !progressEntryIsNote(entry)).at(-1);
    const recovered = { id, title: info.smallTaskTitle || info.text || '小さいタスク', completed: completedIds.has(id),
      waiting: !completedIds.has(id) && latest?.status === 'waiting' && !latest.resolvedByReplyId };
    normalized = { ...normalized, subtasks: getProgressSubtasks(normalized).map(st => st.id === parentId ? { ...st, smallTasks: [...getProgressSmallTasks(st), recovered] } : st) };
  });
  getCompletedProgressSmallIds(normalized).forEach(id => {
    const small = getProgressSubtasks(normalized).flatMap(getProgressSmallTasks).find(item => item.id === id);
    const conclusion = small?.completionSource === 'manual' ? undefined : (normalized.progressHistory || []).find(entry => entry.id === small?.completionEntryId)
      || small?.completionConclusion || latestProgressCompletion(normalized, id);
    normalized = completeProgressSmallTask(normalized, id, conclusion);
  });
  return syncProgressWaiting(normalized);
};
// A reply may finish one small task while creating the next piece of work.
const progressCompletionSmallId = (task, entry) => entry?.completedSmallTaskId
  || getProgressSubtasks(task).flatMap(getProgressSmallTasks).find(small => small.completionEntryId === entry?.id)?.id
  || (Array.isArray(entry?.completedSubtaskIds) ? null
    : entry?.status === 'completed' && (entry.addedSmallTask || entry.addedSubtask) && entry.quote ? entry.quote.smallTaskId : entry?.smallTaskId);
const progressCompletionSubtaskIds = (task, entry) => {
  if (!entry || progressCompletionSmallId(task, entry)) return [];
  if (Array.isArray(entry.completedSubtaskIds)) return entry.completedSubtaskIds;
  if (entry.status === 'completed' && (entry.addedSmallTask || entry.addedSubtask) && entry.quote) {
    return entry.quote.status === 'waiting' ? [] : entry.quote.subtaskIds || [];
  }
  return entry.subtaskIds || [];
};
// Editing or deleting a completion retracts the same canonical targets it finished.
const retractProgressCompletion = (task, entry, waiting = false) => {
  const smallId = progressCompletionSmallId(task, entry);
  if (smallId && getProgressSubtasks(task).flatMap(getProgressSmallTasks).find(small => small.id === smallId)?.completionSource === 'manual') return task;
  if (smallId) return getProgressSubtasks(task).some(st => getProgressSmallTasks(st).some(small => small.id === smallId))
    ? reopenProgressSmallTask(task, smallId, waiting) : task;
  const ids = new Set(progressCompletionSubtaskIds(task, entry).filter(id => getProgressSubtasks(task).find(st => st.id === id)?.completionSource !== 'manual'));
  if (!getProgressSubtasks(task).some(st => ids.has(st.id))) return task;
  const updated = { ...task, completed: false, subtasks: getProgressSubtasks(task).map(st => {
    if (!ids.has(st.id) || st.completionSource === 'manual') return st;
    const reopened = { ...st, completed: false, waiting, completionManaged: true };
    delete reopened.completedAt; delete reopened.completionEntryId; delete reopened.completionConclusion;
    return reopened;
  }) };
  delete updated.completedAt;
  return updated;
};
const progressEntryParentIds = entry => [...new Set([...(entry.subtaskIds || []),
  ...(Array.isArray(entry.completedSubtaskIds) ? entry.completedSubtaskIds : []),
  ...(entry.isConclusion ? entry.conclusionTarget?.subtaskIds || [] : []),
  ...(entry.quote?.subtaskIds || [])])];
const progressConclusionTarget = entry => {
  if (entry.conclusionTarget) return entry.conclusionTarget;
  const source = (entry.addedSmallTask || entry.addedSubtask) && entry.quote ? entry.quote : entry;
  return { smallTaskId: entry.completedSmallTaskId || source.smallTaskId || null,
    subtaskIds: entry.completedSubtaskIds?.length ? entry.completedSubtaskIds : source.subtaskIds || [] };
};
const getProgressConclusions = (history, smallId, parentId) => history.filter(entry => {
  if (!entry.isConclusion || (!entry.text?.trim() && !progressMediaItems(entry.images).length && !progressMediaItems(entry.links).length)) return false;
  const target = progressConclusionTarget(entry);
  return smallId ? target.smallTaskId === smallId : !target.smallTaskId && target.subtaskIds.includes(parentId);
});
const progressDependencyKey = ref => `${ref.kind}${ref.kind === 'waiting' ? `:${ref.scopeKind}` : ''}:${ref.parentId || ''}:${ref.id}`;
const getProgressDependencyNode = (task, ref) => {
  const kind = ref.kind === 'waiting' ? ref.scopeKind : ref.kind;
  if (kind === 'task') return task.id === ref.id ? task : undefined;
  if (kind === 'subtask') return getProgressSubtasks(task).find(st => st.id === ref.id);
  if (kind === 'small') return getProgressSmallTasks(getProgressSubtasks(task).find(st => st.id === ref.parentId)).find(small => small.id === ref.id);
};
const progressDependencyTitle = (task, ref) => `${ref.kind === 'waiting' ? '相手待ち: ' : ''}${getProgressDependencyNode(task, ref)?.title || `${ref.title}（削除済み）`}`;
const progressWaitingDependencyEntry = (task, ref) => {
  const resolved = progressDependencyDone(task, ref);
  return (task.progressHistory || []).filter(entry => {
    if (entry.kind !== 'comment' || entry.status !== 'waiting' || progressEntryIsNote(entry) || (!resolved && entry.resolvedByReplyId)) return false;
    const scope = progressWaitingScope(task, entry);
    return ref.scopeKind === 'task' ? scope === 'task'
      : ref.scopeKind === 'small' ? scope === `small:${ref.id}` : scope === `subtask:${ref.id}`;
  }).reduce((latest, entry) => !latest || (Date.parse(entry.editedAt || entry.createdAt) || 0) >= (Date.parse(latest.editedAt || latest.createdAt) || 0) ? entry : latest, null);
};
const progressDependencyDone = (task, ref) => {
  if (task.completed) return true;
  const kind = ref.kind === 'waiting' ? ref.scopeKind : ref.kind;
  if (kind === 'small' && getCompletedProgressSmallIds(task).has(ref.id)) return true;
  if (kind === 'small' && getProgressSubtasks(task).find(st => st.id === ref.parentId)?.completed) return true;
  const node = getProgressDependencyNode(task, ref);
  return !!node && (node.completed || (ref.kind === 'waiting' && !node.waiting));
};
const pendingProgressDependencies = (task, item) => !task || !item || item.completed || task.completed ? []
  : (item.dependencies || []).filter(ref => !progressDependencyDone(task, ref));
const isProgressBlocked = (task, item) => pendingProgressDependencies(task, item).length > 0;
const progressDependencyOptions = (task, target) => {
  const parents = getProgressSubtasks(task);
  const options = parents.filter(st => st.id !== (target.kind === 'small' ? target.parentId : target.id))
    .map(st => ({ kind: 'subtask', id: st.id, title: st.title }));
  const taskOptions = target.kind !== 'small' ? options : [
    ...getProgressSmallTasks(parents.find(st => st.id === target.parentId)).filter(small => small.id !== target.id)
      .map(small => ({ kind: 'small', parentId: target.parentId, id: small.id, title: small.title })), ...options
  ];
  // Waiting is independently resolved by a reply, so a parent's or child's wait
  // can be referenced without waiting for that task's eventual completion.
  const waitingOptions = [{ scopeKind: 'task', id: task.id, title: task.title },
    ...parents.flatMap(st => [{ scopeKind: 'subtask', id: st.id, title: st.title },
      ...getProgressSmallTasks(st).map(small => ({ scopeKind: 'small', parentId: st.id, id: small.id, title: small.title }))])]
    .filter(ref => ref.scopeKind !== target.kind || ref.id !== target.id || (ref.parentId || '') !== (target.parentId || ''))
    .map(ref => ({ kind: 'waiting', ...ref }));
  // Keep existing links usable when their target changed hierarchy through a
  // conversion. This does not offer new links outside the usual scope.
  const retained = (getProgressDependencyNode(task, target)?.dependencies || []).filter(ref => ref.scopeMoved && getProgressDependencyNode(task, ref));
  return [...new Map([...taskOptions, ...waitingOptions, ...retained].map(ref => [progressDependencyKey(ref), ref])).values()];
};
const progressDependencyError = (task, target, selected) => {
  const validKeys = new Set(progressDependencyOptions(task, target).map(progressDependencyKey));
  if (selected.some(ref => !validKeys.has(progressDependencyKey(ref)))) return '関連先が削除されたか、関連付けできる範囲外です。選択を外してください。';
  return progressDependencyCycleError(task, target, selected);
};
const progressDependencyCycleError = (task, target, selected) => {
  const graph = new Map();
  const targetKey = target ? progressDependencyKey(target) : null;
  getProgressSubtasks(task).forEach(st => {
    const parentRef = { kind: 'subtask', id: st.id };
    const deps = progressDependencyKey(parentRef) === targetKey ? selected : st.dependencies || [];
    graph.set(progressDependencyKey(parentRef), [...deps.map(progressDependencyKey), ...getProgressSmallTasks(st).map(small => progressDependencyKey({ kind: 'small', parentId: st.id, id: small.id }))]);
    getProgressSmallTasks(st).forEach(small => {
      const ref = { kind: 'small', parentId: st.id, id: small.id };
      graph.set(progressDependencyKey(ref), (progressDependencyKey(ref) === targetKey ? selected : small.dependencies || []).map(progressDependencyKey));
    });
  });
  const visiting = new Set(), visited = new Set();
  const cycles = key => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    if ((graph.get(key) || []).some(cycles)) return true;
    visiting.delete(key); visited.add(key); return false;
  };
  return [...graph.keys()].some(cycles) ? '循環する関連付けです。互いの完了を待つ指定はできません。' : '';
};

const convertProgressTodoToSmall = (task, sourceId, parentId, { title, origin } = {}) => {
  const parents = getProgressSubtasks(task), source = parents.find(st => st.id === sourceId), parent = parents.find(st => st.id === parentId);
  if (!source || !parent || source.id === parent.id) return { error: '変換先のやるべきことを選択してください。自分自身は選べません。' };
  const allSmallIds = new Set([...parents.flatMap(getProgressSmallTasks).map(small => small.id), ...(task.deletedProgressSmallTaskIds || []), ...(task.deletedSmallTaskOriginIds || []), ...(task.completedSmallTaskIds || [])]);
  let smallId = source.id;
  while (allSmallIds.has(smallId)) smallId += '-small';
  const smallTitle = title || source.title, children = getProgressSmallTasks(source);
  const mapRef = ref => {
    const kind = ref.kind === 'waiting' ? ref.scopeKind : ref.kind;
    if (kind === 'subtask' && ref.id === source.id) return { ...ref, ...(ref.kind === 'waiting' ? { scopeKind: 'small' } : { kind: 'small' }), id: smallId, parentId: parent.id, title: smallTitle, scopeMoved: true };
    return kind === 'small' && ref.parentId === source.id ? { ...ref, parentId: parent.id, scopeMoved: true } : ref;
  };
  const mapNode = node => ({ ...node, ...(node.dependencies ? { dependencies: node.dependencies.map(mapRef) } : {}),
    ...(node.completionConclusion ? { completionConclusion: mapEntry(node.completionConclusion) } : {}) });
  const mapTarget = target => {
    if (!target?.subtaskIds?.includes(source.id)) return target;
    const subtaskIds = [...new Set(target.subtaskIds.map(id => id === source.id ? parent.id : id))];
    return { ...target, subtaskIds, ...(!target.smallTaskId ? { smallTaskId: smallId } : {}) };
  };
  const mapEntry = record => {
    if (!record) return record;
    const entry = record;
    const affected = entry.subtaskIds?.includes(source.id);
    const own = affected && !entry.smallTaskId;
    const ids = affected ? [...new Set(entry.subtaskIds.map(id => id === source.id ? parent.id : id))] : entry.subtaskIds;
    const converted = { ...entry,
      ...(affected ? { subtaskIds: ids, subtaskTitles: ids.map(id => parents.find(st => st.id === id)?.title || entry.subtaskTitles?.[entry.subtaskIds.indexOf(id)] || '') } : {}),
      ...(own ? { smallTaskId: smallId, smallTaskTitle: smallTitle, ...(entry.addedSubtask ? { addedSubtask: false, addedSmallTask: true } : {}) } : {}),
      ...(entry.completedSubtaskIds?.includes(source.id) ? { completedSubtaskIds: entry.completedSubtaskIds.filter(id => id !== source.id), completedSmallTaskId: smallId } : {}),
      ...(entry.conclusionTarget ? { conclusionTarget: mapTarget(entry.conclusionTarget) } : {}),
      ...(entry.quote ? { quote: mapEntry(entry.quote) } : {}) };
    return converted;
  };
  const { smallTasks: ignoredChildren, ...sourceFields } = source;
  const converted = mapNode({ ...sourceFields, id: smallId, title: smallTitle });
  const moved = [converted, ...children.map(mapNode)];
  const unfinished = moved.some(small => !small.completed);
  const reopen = node => {
    if (!unfinished || !node.completed) return node;
    const next = { ...node, completed: false, completionManaged: true };
    delete next.completedAt; delete next.completionEntryId; delete next.completionConclusion;
    return next;
  };
  const result = { ...reopen(task), subtasks: parents.filter(st => st.id !== source.id).map(st => {
    const mapped = mapNode(st);
    if (st.id !== parent.id) return { ...mapped, ...(st.smallTasks ? { smallTasks: getProgressSmallTasks(st).map(mapNode) } : {}) };
    return { ...reopen(mapped), smallTasks: [...getProgressSmallTasks(st).map(mapNode), ...moved].map((small, index) => ({ ...small, order: index + 1 })) };
  }), progressHistory: (task.progressHistory || []).map(entry => mapEntry(entry.id === origin?.id ? origin : entry)) };
  const error = progressDependencyCycleError(result);
  return error ? { error: 'この変換先ではタスク待ちが循環します。別のやるべきことを選ぶか、関連付けを解除してください。' } : { task: result, smallId, parentId: parent.id };
};

const withCompletionTimestamp = (previous, next) => {
  if (!next.completed) {
    if (!('completedAt' in next)) return next;
    const incomplete = { ...next };
    delete incomplete.completedAt;
    return incomplete;
  }
  if (previous && !previous.completed) return { ...next, completedAt: new Date().toISOString() };
  return next;
};

// Record todo creation and deadline changes for which the user supplied a reason.
const appendProgressHistory = (previous, next, { reason = '' } = {}) => {
  const explanation = reason.trim();
  if (!previous?.progressEnabled && !next.progressEnabled && !previous?.progressHistory?.length) return next;
  const createdAt = new Date().toISOString();
  const beforeById = new Map(previous ? getProgressSubtasks(previous).map(st => [st.id, st]) : []);
  const additions = getProgressSubtasks(next).filter(st => !beforeById.has(st.id)
    && !(next.progressHistory || []).some(entry => entry.addedSubtask && entry.subtaskIds?.includes(st.id))).map(st => ({
      id: createProgressId(), kind: 'comment', createdAt, text: progressTodoOriginText(st.title, st.dueDate),
      addedSubtask: true, status: st.completed ? 'completed' : 'active', dueDate: st.dueDate || '',
      subtaskIds: [st.id], subtaskTitles: [st.title]
    }));
  const recorded = additions.length ? { ...next, progressHistory: [...(next.progressHistory || []), ...additions] } : next;
  if (!previous || !explanation) return recorded;
  const changes = [];
  const record = (label, before, after, subtasks = []) => changes.push({
    id: createProgressId(), kind: 'change', changeType: 'deadline', reason: explanation, createdAt,
    text: `${label}の期限を ${before || '未設定'} → ${after || '未設定'} に変更しました\n理由: ${explanation}`,
    subtaskIds: subtasks.map(st => st.id), subtaskTitles: subtasks.map(st => st.title)
  });
  if (previous.dueDate !== next.dueDate) record(`タスク「${next.title}」`, previous.dueDate, next.dueDate);
  getProgressSubtasks(next).forEach(st => {
    const old = beforeById.get(st.id);
    if (old && old.dueDate !== st.dueDate) record(`「${st.title}」`, old.dueDate, st.dueDate, [st]);
  });
  return changes.length ? { ...recorded, progressHistory: [...(recorded.progressHistory || []), ...changes] } : recorded;
};

const isVisibleProgressEntry = (entry) => {
  if (entry.kind === 'comment') return true;
  if (entry.kind !== 'change') return false;
  if (entry.changeType === 'deadline') return !!entry.reason?.trim();
  // Preserve older reasoned deadline records without showing other old auto logs.
  return /^(?:タスク「.*」|「.*」)の期限を [^\n]* → [^\n]* に変更しました\n理由:\s*\S/.test(entry.text || '');
};

const progressEntryTone = (entry, task) => {
  if (progressEntryIsNote(entry)) return 'gray';
  const creation = !!(entry.addedSmallTask || entry.addedSubtask);
  const smallId = entry.completedSmallTaskId || (Array.isArray(entry.completedSubtaskIds) ? null : entry.smallTaskId);
  const parentIds = Array.isArray(entry.completedSubtaskIds) ? entry.completedSubtaskIds : entry.subtaskIds || [];
  const parents = task ? getProgressSubtasks(task).filter(st => entry.completedSmallTaskId
    ? getProgressSmallTasks(st).some(small => small.id === smallId) : parentIds.includes(st.id)) : [];
  const small = parents.flatMap(getProgressSmallTasks).find(item => item.id === smallId);
  if (task?.completed || (parents.length && parents.every(st => st.completed))
    || (task && smallId && getCompletedProgressSmallIds(task).has(smallId))) return 'blue';
  const targets = small ? [small] : parents.length ? parents : task ? [task] : [];
  if (creation) {
    // Creation records summarize work state; ordinary messages retain their own meaning.
    const states = targets.map(item => progressItemStatus(item, task));
    return states.includes('blocked') ? 'yellow' : states.includes('overdue') ? 'red' : states.includes('waiting') ? 'green' : 'blue';
  }
  if (entry.resolvedByReplyId || (task?.progressHistory || []).some(item => item.id === entry.id && item.resolvedByReplyId)
    || entry.status === 'completed') return 'blue';
  if (entry.status === 'waiting') return 'green';
  return 'blue';
};
const progressToneBorders = { yellow: 'border-black', gray: 'border-black', blue: 'border-black', green: 'border-black', red: 'border-black', purple: 'border-black' };
const progressEntryLabel = (entry, task, headerTone) => {
  if (headerTone) return ({ yellow: 'タスク待ち', blue: '完了', red: '期限超過', green: '相手待ち', purple: '進捗中' })[headerTone];
  if (entry.resolvedByReplyId) return '返信済み';
  const small = task && getProgressSubtasks(task).flatMap(getProgressSmallTasks).find(item => item.id === progressCompletionSmallId(task, entry));
  const parents = task ? getProgressSubtasks(task).filter(st => progressCompletionSubtaskIds(task, entry).includes(st.id)) : [];
  const retracted = small ? small.completionManaged && !small.completed : parents.some(st => st.completionManaged && !st.completed);
  if (entry.status === 'completed' && !retracted) return '完了';
  const tone = progressEntryTone(entry, task);
  return ({ yellow: 'タスク待ち', red: '期限超過', green: '相手待ち' })[tone] || '進捗';
};
const progressToneClasses = tone => {
  const backgrounds = { yellow: 'bg-yellow-50 text-yellow-900', gray: 'bg-gray-50 text-gray-700', blue: 'bg-blue-50 text-blue-900', green: 'bg-green-50 text-green-800', red: 'bg-red-50 text-red-800', purple: 'bg-purple-50 text-purple-900' };
  return `${backgrounds[tone]} ${progressToneBorders[tone]}`;
};
const progressEntryClasses = (entry, task) => progressToneClasses(progressEntryTone(entry, task));

// Older backups can contain null (or incomplete) optional attachment fields.
const progressMediaItems = value => Array.isArray(value)
  ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];

const createProgressQuote = (entry) => ({
  id: entry.id, text: entry.text, ...(progressMediaItems(entry.textLinks).length ? { textLinks: progressMediaItems(entry.textLinks).map(link => ({ ...link })) } : {}), ...(progressMediaItems(entry.textFormats).length ? {textFormats:progressMediaItems(entry.textFormats).map(mark=>({...mark}))} : {}), createdAt: entry.createdAt, status: entry.status,
  ...(entry.completedSmallTaskId ? { completedSmallTaskId: entry.completedSmallTaskId } : {}),
  ...(Array.isArray(entry.completedSubtaskIds) ? { completedSubtaskIds: [...entry.completedSubtaskIds] } : {}),
  ...(entry.plainComment ? { plainComment: true } : {}),
  ...(entry.assumptionMemo ? { assumptionMemo: true } : {}),
  ...(entry.isConclusion ? { isConclusion: true, conclusionTarget: progressConclusionTarget(entry) } : {}),
  ...(entry.resolvedByReplyId ? { resolvedByReplyId: entry.resolvedByReplyId } : {}),
  subtaskIds: [...(entry.subtaskIds || [])], subtaskTitles: [...(entry.subtaskTitles || [])],
  smallTaskId: entry.smallTaskId, smallTaskTitle: entry.smallTaskTitle,
  ...(entry.addedSmallTask ? { addedSmallTask: true } : {}),
  ...(entry.sourceType ? { sourceType: entry.sourceType } : {}),
  ...(progressMediaItems(entry.images).length ? { images: progressMediaItems(entry.images).map(image => ({ ...image })) } : {}),
  ...(progressMediaItems(entry.links).length ? { links: progressMediaItems(entry.links).map(link => ({ ...link })) } : {}),
  ...(entry.quote ? { quote: entry.quote } : {})
});
const findProgressReplySource = (task, quote) => {
  if (quote.sourceType !== 'small-task') return (task.progressHistory || []).find(entry => entry.id === quote.id && entry.kind === 'comment');
  const parent = getProgressSubtasks(task).find(st => st.id === quote.subtaskIds?.[0]);
  const small = getProgressSmallTasks(parent).find(item => item.id === quote.smallTaskId);
  return small ? { ...quote, text: small.title, smallTaskTitle: small.title } : null;
};
const progressQuoteSearchText = quote => quote
  ? [quote.text, ...(quote.subtaskTitles || []), quote.smallTaskTitle, ...progressMediaItems(quote.textLinks).map(link => link.url), ...progressMediaItems(quote.images).map(image => image.name), ...progressMediaItems(quote.links).flatMap(link => [link.label, link.url]), progressQuoteSearchText(quote.quote)].filter(Boolean).join(' ')
  : '';
const progressReplyWouldCycle = (task, editedId, candidate) => {
  const byId = new Map((task.progressHistory || []).map(entry => [entry.id, entry]));
  const seen = new Set();
  let entry = candidate;
  while (entry) {
    if (entry.id === editedId || seen.has(entry.id)) return true;
    seen.add(entry.id);
    const quote = entry.quote;
    entry = quote ? byId.get(quote.id) || quote : null;
  }
  return false;
};
// Reassign only the closure owned by this reply. Other replies and manual
// closures remain authoritative, and old quoted snapshots stay unchanged.
const syncEditedProgressReply = (task, id) => {
  const history = task.progressHistory || [], edited = history.find(entry => entry.id === id);
  if (!edited) return task;
  const sourceId = !progressEntryIsNote(edited) ? edited.quote?.id : null;
  return { ...task, progressHistory: history.map(entry => {
    if (entry.status !== 'waiting' || progressEntryIsNote(entry)) return entry;
    if (entry.id === sourceId) return { ...entry, resolvedByReplyId: entry.resolvedByReplyId || id };
    if (entry.resolvedByReplyId !== id) return entry;
    const other = history.find(reply => reply.id !== id && !progressEntryIsNote(reply) && reply.quote?.id === entry.id);
    if (other) return { ...entry, resolvedByReplyId: other.id };
    const reopened = { ...entry }; delete reopened.resolvedByReplyId; return reopened;
  }) };
};

const progressSafeUrl = value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
};
const progressTextLinks = (text, links) => {
  let end = 0;
  return progressMediaItems(links).filter(link => Number.isInteger(link.start) && Number.isInteger(link.end)
    && link.start >= 0 && link.end > link.start && link.end <= text.length && progressSafeUrl(link.url))
    .sort((a, b) => a.start - b.start).filter(link => {
      if (link.start < end) return false;
      end = link.end; return true;
    }).map(link => ({ start: link.start, end: link.end, url: progressSafeUrl(link.url) }));
};
const progressAutoTextLinks = text => {
  const links = [], pattern = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  let match;
  while ((match = pattern.exec(text))) {
    let candidate = match[0], before;
    do {
      before = candidate;
      candidate = candidate.replace(/[。、，．！？!,.;:]+$/u, '');
      for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}'], ['（', '）'], ['「', '」'], ['『', '』'], ['【', '】']]) {
        while (candidate.endsWith(closing) && candidate.split(closing).length > candidate.split(opening).length) candidate = candidate.slice(0, -1);
      }
    } while (candidate !== before);
    const url = progressSafeUrl(/^www\./i.test(candidate) ? `https://${candidate}` : candidate);
    if (url) links.push({ start: match.index, end: match.index + candidate.length, url });
  }
  return links;
};
const progressAllTextLinks = (text, links) => {
  const explicit = progressTextLinks(text, links);
  return [...explicit, ...progressAutoTextLinks(text).filter(link => !explicit.some(item => link.start < item.end && link.end > item.start))].sort((a, b) => a.start - b.start);
};
const progressTextParts = (text, links) => {
  const parts = []; let start = 0;
  links.forEach(link => {
    if (link.start > start) parts.push({ text: text.slice(start, link.start) });
    parts.push({ text: text.slice(link.start, link.end), url: link.url }); start = link.end;
  });
  if (start < text.length) parts.push({ text: text.slice(start) });
  return parts;
};
// Store tables as portable Markdown in the existing text field, so history,
// quotes, search and JSON backups retain them without a parallel data model.
const progressTableCell = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const progressTableText = rows => rows.map((row, i) => '| ' + row.map(progressTableCell).join(' | ') + ' |' + (i === 0 ? '\n| ' + row.map(() => '---').join(' | ') + ' |' : '')).join('\n');
const progressTableRows = line => {
  const cells = []; let cell = '', escaped = false;
  for (const c of line.trim().slice(1, -1)) {
    if (escaped) { cell += c; escaped = false; }
    else if (c === '\\') escaped = true;
    else if (c === '|') { cells.push(cell.replace(/^ | $/g, '').replace(/<br>/g, '\n').replace(/&lt;/g, '<').replace(/&amp;/g, '&')); cell = ''; }
    else cell += c;
  }
  cells.push(cell.replace(/^ | $/g, '').replace(/<br>/g, '\n').replace(/&lt;/g, '<').replace(/&amp;/g, '&')); return cells;
};
const progressTables = text => {
  const result = [], lines = text.split('\n'); let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i], start = offset;
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[i + 1] || '')) {
      const rows = [progressTableRows(line)]; let end = start + line.length + 1 + lines[i + 1].length;
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(progressTableRows(lines[i])); end += 1 + lines[i].length; i += 1; }
      i -= 1;
      if (rows.every(row => row.length === rows[0].length)) result.push({ start, end, rows });
      offset = end + 1;
    } else offset += line.length + 1;
  }
  return result;
};
const progressTalkTypes = [['all','すべて'],['image','画像あり'],['link','リンクあり'],['table','表あり']];
const progressTalkStatuses = [['all','すべて'],['progress','進捗'],['waiting','相手待ち'],['replied','返信済み'],['conclusion','結論・完了'],['comment','ただのコメント'],['premise','前提メモ'],['blocked','タスク待ち'],['overdue','期限超過']];
const progressTalkMatchesFilters = (entry, task, type, status) => {
  if (type !== 'all') {
    const text = typeof entry.text === 'string' ? entry.text : '';
    const matches = type === 'image' ? progressMediaItems(entry.images).some(image => typeof image.src === 'string' && image.src.trim())
      : type === 'link' ? progressMediaItems(entry.links).some(link => progressSafeUrl(link.url)) || progressAllTextLinks(text, entry.textLinks).length > 0
      : type === 'table' && progressTables(text).length > 0;
    if (!matches) return false;
  }
  if (status === 'all') return true;
  if (status === 'premise') return !!entry.assumptionMemo;
  if (status === 'comment') return !!entry.plainComment && !entry.assumptionMemo;
  if (status === 'conclusion') return !!entry.isConclusion || (!progressEntryIsNote(entry) && progressEntryLabel(entry, task) === '完了');
  if (progressEntryIsNote(entry) || (status === 'progress' && entry.isConclusion)) return false;
  return ({ progress: '進捗', waiting: '相手待ち', replied: '返信済み', blocked: 'タスク待ち', overdue: '期限超過' })[status] === progressEntryLabel(entry, task);
};
const ProgressTable = ({ rows }) => <span className="block max-w-full overflow-x-auto my-2">
  <table aria-label="トークの表" className="w-full border-collapse" style={{ minWidth: rows[0].length * 100 }}>
    <tbody>{rows.map((row,i)=><tr key={i}>{row.map((cell,j)=>React.createElement(i===0?'th':'td',{key:j,className:`border border-gray-400 p-2 whitespace-pre-wrap break-words text-left align-top ${i===0?'bg-slate-100 font-bold':'bg-white'}`,style:{minWidth:100}},<ProgressText value={cell}/>))}</tr>)}</tbody>
  </table>
</span>;
// Rich text is stored as validated ranges over plain text, never arbitrary HTML.
const progressTextFormats = (text, formats) => {
  const seen = new Set();
  const valid = progressMediaItems(formats).filter(mark => ['bold','italic','underline','strike','bullet','number'].includes(mark.type)
    && Number.isInteger(mark.start) && Number.isInteger(mark.end) && mark.start >= 0 && mark.end > mark.start && mark.end <= text.length)
    .map(mark => ({ start: mark.start, end: mark.end, type: mark.type,
      ...(['bullet','number'].includes(mark.type) ? { depth: Math.max(0, Math.min(5, Math.trunc(Number(mark.depth)) || 0)), index: Math.max(1, Math.min(1000000, Math.trunc(Number(mark.index)) || 1)) } : {}) }))
    .filter(mark => { const key = JSON.stringify(mark); if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a,b) => a.start-b.start || a.end-b.end || a.type.localeCompare(b.type));
  const result=valid.filter(mark=>['bullet','number'].includes(mark.type));
  ['bold','italic','underline','strike'].forEach(type=>{
    const merged=[];
    valid.filter(mark=>mark.type===type).forEach(mark=>{
      const last=merged.at(-1);
      if(last && last.end>=mark.start)last.end=Math.max(last.end,mark.end);else merged.push({...mark});
    });
    result.push(...merged);
  });
  return result.sort((a,b)=>a.start-b.start || a.end-b.end || a.type.localeCompare(b.type));
};
const progressSliceFormats = (text, formats, start, end, prefix = 0) => progressTextFormats(text, formats)
  .filter(mark => mark.start < end && mark.end > start).map(mark => ({ ...mark, start: Math.max(start, mark.start)-start+prefix, end: Math.min(end, mark.end)-start+prefix }));
const progressInlineFragment = (text, links, formats) => {
  const fragment = document.createDocumentFragment(), boundaries = new Set([0,text.length]);
  const marks = progressTextFormats(text, formats).filter(mark => !['bullet','number'].includes(mark.type));
  const safeLinks = progressTextLinks(text, links);
  [...marks,...safeLinks].forEach(mark => { boundaries.add(mark.start); boundaries.add(mark.end); });
  const points = [...boundaries].sort((a,b) => a-b);
  points.slice(0,-1).forEach((start,index) => {
    const end=points[index+1]; let node=document.createTextNode(text.slice(start,end));
    const link=safeLinks.find(link => link.start<=start && link.end>=end);
    if(link) { const a=document.createElement('a'); a.href=link.url; a.target='_blank'; a.rel='noopener noreferrer'; a.className='text-black underline break-all'; a.contentEditable='false'; a.append(node);node=a; }
    ['bold','italic','underline','strike'].forEach(type => {
      if(!marks.some(mark => mark.type===type && mark.start<=start && mark.end>=end)) return;
      const element=document.createElement(({bold:'strong',italic:'em',underline:'u',strike:'s'})[type]); element.append(node);node=element;
    });
    fragment.append(node);
  });
  return fragment;
};
const progressListFragment = (text, links, formats) => {
  const marks=progressTextFormats(text,formats), lists=marks.filter(mark=>['bullet','number'].includes(mark.type));
  if(!lists.length) return progressInlineFragment(text,links,marks);
  const fragment=document.createDocumentFragment(); let offset=0, stack=[], previous=null;
  const inline = (start,end) => progressInlineFragment(text.slice(start,end), progressTextLinks(text,links).filter(link=>link.start>=start && link.end<=end).map(link=>({...link,start:link.start-start,end:link.end-start})), progressSliceFormats(text,marks,start,end));
  text.split('\n').forEach((line,index,lines) => {
    const start=offset,end=start+line.length; offset=end+1;
    const mark=lists.filter(mark=>mark.start<=start && mark.end>=end && end>mark.start).sort((a,b)=>(b.depth-a.depth)||(a.end-a.start)-(b.end-b.start))[0];
    if(!mark) { stack=[];previous=null;fragment.append(inline(start,end)); if(index<lines.length-1)fragment.append(document.createTextNode('\n'));return; }
    const depth=Math.min(Math.max(0,mark.depth-Math.min(...lists.map(item=>item.depth))),stack.length);
    stack=stack.slice(0,depth+1);
    let level=stack[depth];
    if(!level || level.type!==mark.type) {
      const list=document.createElement(mark.type==='number'?'ol':'ul'); list.setAttribute('data-progress-list-root',''); list.className=mark.type==='number'?'list-decimal pl-5':'list-disc pl-5';
      list.style.listStyleType=mark.type==='number'?'decimal':'disc'; if(mark.type==='number')list.start=mark.index;
      if(depth && stack[depth-1]?.last) { stack[depth-1].last.append(document.createTextNode('\n'),list); } else { if(stack[0])fragment.append(document.createTextNode('\n')); fragment.append(list); }
      level={node:list,type:mark.type,last:null};stack[depth]=level;
    }
    const same=previous && previous.start===mark.start && previous.end===mark.end && previous.depth===mark.depth;
    if(same && level.last)level.last.append(document.createElement('br'),inline(start,end));
    else { const li=document.createElement('li'); if(mark.type==='number' && mark.index!==(level.node.start||1)+level.node.children.length)li.value=mark.index; li.append(inline(start,end));level.node.append(li);level.last=li; }
    previous=mark;
    const nextStart=end+1;
    if(index<lines.length-1 && !lists.some(item=>item.start<=nextStart && item.end>nextStart)) {fragment.append(document.createTextNode('\n'));stack=[];previous=null;}
  });
  return fragment;
};
const progressFragmentReact = fragment => {
  const convert=(node,key) => {
    if(node.nodeType===3)return node.textContent;
    const props={key};
    if(node.nodeName==='A')Object.assign(props,{href:node.href,target:'_blank',rel:'noopener noreferrer',className:node.className});
    if(node.className)props.className=node.className;
    if(node.nodeName==='OL')props.start=node.start;
    if(node.nodeName==='LI' && node.hasAttribute('value'))props.value=node.value;
    return React.createElement(node.nodeName.toLowerCase(),props,...[...node.childNodes].map((child,i)=>convert(child,`${key}-${i}`)));
  };
  return [...fragment.childNodes].map((node,i)=>convert(node,i));
};
const ProgressText = ({ value, textLinks, textFormats }) => {
  if (typeof value !== 'string') return value ?? null;
  const tables = progressTables(value), parts = []; let start = 0;
  const appendText = (from,to) => parts.push(...progressFragmentReact(progressListFragment(value.slice(from,to), progressAllTextLinks(value,textLinks).filter(link=>link.start>=from && link.end<=to).map(link=>({...link,start:link.start-from,end:link.end-from})), progressSliceFormats(value,textFormats,from,to))));
  tables.forEach((table, i) => { appendText(start, table.start); parts.push(<ProgressTable key={`table-${i}`} rows={table.rows}/>); start = table.end; });
  appendText(start, value.length);
  return <span data-progress-body style={{ color: '#000' }}>{parts}</span>;
};
// Read text, our serialized tables and HTTP(S) link ranges. Clipboard HTML is rebuilt from these safe values.
const readProgressEditor = root => {
  let text = ''; const links = [], formats = [];
  const block = node => !(/^(UL|OL)$/.test(node.nodeName) && node.hasAttribute?.('data-progress-list-root')) && /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE|TR|UL|OL)$/.test(node.nodeName);
  const walk = node => {
    if (node.nodeType === 3) { text += node.textContent.replace(/\u200B/g, ''); return; }
    if ((node.nodeType !== 1 && node !== root) || /^(SCRIPT|STYLE|HEAD|IFRAME|OBJECT|SVG|TEMPLATE)$/.test(node.nodeName)) return;
    if (node.nodeName === 'TABLE' && node.hasAttribute('data-progress-table')) { text += node.getAttribute('data-progress-table'); return; }
    if (node.nodeName === 'BR') { text += '\n'; return; }
    const start = text.length;
    const children = [...node.childNodes].filter(child => child.nodeType === 1 || child.nodeType === 3);
    const emptyBlock = children.length === 1 && children[0].nodeName === 'BR';
    if (!emptyBlock || (!block(node) && node !== root)) children.forEach((child, i) => {
      if (i > 0 && (block(child) || block(children[i - 1]))) text += '\n';
      walk(child);
    });
    const url = node.nodeName === 'A' && progressSafeUrl(node.getAttribute('href'));
    if (url && text.length > start) links.push({ start, end: text.length, url });
    const style=node.style;
    const add = type => { if(text.length>start)formats.push({start,end:text.length,type}); };
    if(/^(B|STRONG)$/.test(node.nodeName) || /^(bold|[6-9]00)$/.test(style?.fontWeight || ''))add('bold');
    if(/^(I|EM)$/.test(node.nodeName) || style?.fontStyle==='italic')add('italic');
    if(node.nodeName==='U' || /underline/.test(style?.textDecoration || ''))add('underline');
    if(/^(S|STRIKE|DEL)$/.test(node.nodeName) || /line-through/.test(style?.textDecoration || ''))add('strike');
    if(node.nodeName==='LI' && /^(UL|OL)$/.test(node.parentElement?.nodeName)) {
      const list=node.parentElement; let ancestor=list.parentElement,depth=0;
      while(ancestor) { if(/^(UL|OL)$/.test(ancestor.nodeName))depth++;ancestor=ancestor.parentElement; }
      const index=node.hasAttribute('value') ? node.value : (list.start || 1)+[...list.children].filter(item=>item.nodeName==='LI').indexOf(node);
      if(text.length>start)formats.push({start,end:text.length,type:list.nodeName==='OL'?'number':'bullet',depth,index});
    }
  };
  walk(root);
  return { text, textLinks: progressTextLinks(text, links), textFormats: progressTextFormats(text,formats) };
};
const progressEditorFragment = (text, links, formats = []) => {
  const fragment = document.createDocumentFragment(); let start = 0;
  const appendText = (from,to) => fragment.append(progressListFragment(text.slice(from,to),progressTextLinks(text,links).filter(link=>link.start>=from && link.end<=to).map(link=>({...link,start:link.start-from,end:link.end-from})),progressSliceFormats(text,formats,from,to)));
  progressTables(text).forEach(item => {
    appendText(start, item.start);
    const table = document.createElement('table'); table.contentEditable = 'false';
    table.setAttribute('data-progress-table', text.slice(item.start, item.end)); table.setAttribute('aria-label', '下書きの表');
    table.style.cssText = 'border-collapse:collapse;margin:8px 0;max-width:100%;color:black';
    item.rows.forEach((row, i) => { const tr = table.insertRow(); row.forEach(value => {
      const cell = document.createElement(i === 0 ? 'th' : 'td'); cell.textContent = value;
      cell.style.cssText = 'border:1px solid #9ca3af;padding:6px;min-width:80px;white-space:pre-wrap;overflow-wrap:anywhere'; tr.append(cell);
    }); });
    fragment.append(table); start = item.end;
  });
  appendText(start, text.length); return fragment;
};
const PROGRESS_GRID_ROWS = 500, PROGRESS_GRID_COLUMNS = 100, PROGRESS_GRID_CELLS = 20000;
const progressGridError = (height, width) => height > PROGRESS_GRID_ROWS || width > PROGRESS_GRID_COLUMNS || height * width > PROGRESS_GRID_CELLS
  ? '一度に扱える表は500行・100列、合計20,000セルまでです。範囲を分けて貼り付けてください。' : '';
const progressGridTsv = rows => rows.map(row => row.map(value => /[\t\r\n"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value).join('\t')).join('\r\n');
const progressClipboardGrid = (html, plain, cellMode = false) => {
  const rectangular = rows => {
    const width = Math.max(1, ...rows.map(row => row.length));
    const error = progressGridError(rows.length, width);
    return error ? { error } : { rows: rows.map(row => Array.from({ length: width }, (_, j) => row[j] ?? '')) };
  };
  if (html) {
    const template = document.createElement('template'); template.innerHTML = html;
    const table = template.content.querySelector('table');
    if (table) {
      const rows = [];
      const source = [...table.querySelectorAll('tr')].filter(row => row.closest('table') === table);
      if (source.length > PROGRESS_GRID_ROWS) return { error: progressGridError(source.length, 1) };
      for (let i = 0; i < source.length; i += 1) {
        rows[i] ||= []; let column = 0;
        for (const cell of [...source[i].cells]) {
          while (rows[i][column] !== undefined) column += 1;
          const height = Math.max(1, cell.rowSpan), width = Math.max(1, cell.colSpan);
          const error = progressGridError(i + height, column + width);
          if (error) return { error };
          for (let y = 0; y < height; y += 1) {
            rows[i + y] ||= [];
            for (let x = 0; x < width; x += 1) rows[i + y][column + x] = y === 0 && x === 0 ? readProgressEditor(cell).text : '';
          }
          column += width;
        }
      }
      if (rows.length) return rectangular(rows);
    }
  }
  if (!plain.includes('\t') && !(cellMode && (/[\r\n]/.test(plain) || /^"[\s\S]*"$/.test(plain)))) return null;
  const rows = []; let row = [], value = '', quoted = false;
  const input = plain.replace(/\r\n?/g, '\n');
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '"' && (quoted || value === '')) {
      if (quoted && input[i + 1] === '"') { value += '"'; i += 1; } else quoted = !quoted;
    } else if (!quoted && (char === '\t' || char === '\n')) {
      row.push(value); value = '';
      if (char === '\n') { rows.push(row); row = []; }
      const error = progressGridError(rows.length + (char === '\n' && i === input.length - 1 ? 0 : 1), row.length + 1);
      if (error) return { error };
    } else value += char;
  }
  if (value || row.length || !rows.length || !input.endsWith('\n')) { row.push(value); rows.push(row); }
  return rectangular(rows);
};
const progressClipboardDraft = (html, plain) => {
  const plainText = plain.replace(/\u200B/g, '');
  if (!html) return { text: plainText, textLinks: [], textFormats: [] };
  const template = document.createElement('template');
  template.innerHTML = html;
  // Rebuild every real table in place, preserving paragraphs/lists before,
  // between and after tables. Clipboard HTML itself is never inserted.
  const tables=[...template.content.querySelectorAll('table')].filter(table=>!table.parentElement?.closest('table'));
  for(const table of tables) {
    const grid=progressClipboardGrid(table.outerHTML,'');
    if(grid?.error)return {error:grid.error};
    if(grid?.rows)table.replaceWith(progressEditorFragment('\n\n'+progressTableText(grid.rows)+'\n\n',[]));
  }

  // Source formatting whitespace between HTML blocks is not a user line break.
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  const block = node => node && /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE|TR|TABLE|UL|OL)$/.test(node.nodeName);
  nodes.forEach(node => {
    if (node.parentElement?.closest('pre,[style*="white-space"],table[data-progress-table]')) return;
    const value = node.textContent;
    if (/^[\t\r\n ]+$/.test(value) && /[\r\n]/.test(value)) {
      if (!node.previousSibling || !node.nextSibling || block(node.previousSibling) || block(node.nextSibling)) node.remove();
      else node.textContent = ' ';
    } else node.textContent = value.replace(/[\t\r\n ]+/g, ' ');
  });
  const rich = readProgressEditor(template.content);
  if (!rich.text) return { text: plainText, textLinks: [], textFormats: [] };
  const positions = value => {
    const result = []; for (let i = 0; i < value.length; i += 1) if (!/\s/u.test(value[i])) result.push(i);
    return result;
  };
  const richPositions = positions(rich.text), plainPositions = positions(plainText);
  if (plainText && richPositions.map(i => rich.text[i]).join('') === plainPositions.map(i => plainText[i]).join('')) {
    // Keep the clipboard's visible line layout while retaining rich link labels.
    const textLinks = rich.textLinks.flatMap(link => {
      const first = richPositions.findIndex(i => i >= link.start);
      let last = first;
      while (last + 1 < richPositions.length && richPositions[last + 1] < link.end) last += 1;
      return first < 0 || richPositions[first] >= link.end ? [] : [{ start: plainPositions[first], end: plainPositions[last] + 1, url: link.url }];
    });
    const textFormats = (rich.textFormats || []).flatMap(mark => {
      const first=richPositions.findIndex(i=>i>=mark.start); let last=first;
      while(last+1<richPositions.length && richPositions[last+1]<mark.end)last++;
      return first<0 || richPositions[first]>=mark.end ? [] : [{...mark,start:plainPositions[first],end:plainPositions[last]+1}];
    });
    return { text: plainText, textLinks, textFormats };
  }
  return rich;
};
const ProgressTableDialog = ({ initial, onApply, onClose }) => {
  const [gridState, setGridState] = useState(() => ({ rows: initial || [['', ''], ['', '']], past: [], future: [] }));
  const rows = gridState.rows;
  const setRows = update => setGridState(previous => {
    const next = typeof update === 'function' ? update(previous.rows) : update;
    return JSON.stringify(next) === JSON.stringify(previous.rows) ? previous : { rows: next, past: [...previous.past, previous.rows].slice(-100), future: [] };
  });
  const [error, setError] = useState('');
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.querySelector('textarea')?.focus();
    return () => previous?.focus();
  }, []);
  const [selection, setSelection] = useState({ row: 0, column: 0, endRow: 0, endColumn: 0 });
  const [editingCell, setEditingCell] = useState(null);
  const [notice, setNotice] = useState('');
  const dragging = useRef(false);
  const bounds = {
    top: Math.min(selection.row, selection.endRow), bottom: Math.max(selection.row, selection.endRow),
    left: Math.min(selection.column, selection.endColumn), right: Math.max(selection.column, selection.endColumn)
  };
  useEffect(() => {
    const stop = () => { dragging.current = false; };
    window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
    return () => { window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
  }, []);
  const [contextMenu, setContextMenu] = useState(null);
  const menuRef = useRef(null);
  const menuAnchor = useRef(null);
  const historyChange = direction => {
    setGridState(previous => {
      const source = direction === 'undo' ? previous.past : previous.future;
      if (!source.length) return previous;
      return direction === 'undo'
        ? { rows: source[source.length - 1], past: source.slice(0, -1), future: [...previous.future, previous.rows] }
        : { rows: source[source.length - 1], past: [...previous.past, previous.rows], future: source.slice(0, -1) };
    });
    setEditingCell(null); setContextMenu(null); setSelection({ row: 0, column: 0, endRow: 0, endColumn: 0 }); setError('');
    setNotice(direction === 'undo' ? '操作を元に戻しました。' : '操作をやり直しました。');
    requestAnimationFrame(() => dialogRef.current?.querySelector('textarea')?.focus());
  };
  const closeMenu = () => { setContextMenu(null); menuAnchor.current?.focus(); };
  const openContextMenu = (event, row, column, keyboard = false) => {
    event.preventDefault(); event.stopPropagation();
    if (!(row >= bounds.top && row <= bounds.bottom && column >= bounds.left && column <= bounds.right)) selectCell(row, column);
    setEditingCell(null); dragging.current = false; menuAnchor.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({ x: Math.max(8, Math.min(keyboard ? rect.left : event.clientX, window.innerWidth - 280)), y: Math.max(8, Math.min(keyboard ? rect.bottom : event.clientY, window.innerHeight - 210)) });
  };
  useEffect(() => {
    if (!contextMenu) return;
    menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    const outside = e => { if (!menuRef.current?.contains(e.target)) setContextMenu(null); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [contextMenu]);
  const selectCell = (row, column, extend = false) => {
    setNotice(''); setError(''); setEditingCell(null);
    setSelection(previous => extend ? { ...previous, endRow: row, endColumn: column } : { row, column, endRow: row, endColumn: column });
  };
  const clearCells = () => {
    setRows(previous => previous.map((row, i) => row.map((value, j) => i >= bounds.top && i <= bounds.bottom && j >= bounds.left && j <= bounds.right ? '' : value)));
    setEditingCell(null); setNotice('選択セルの内容を削除しました。');
  };
  const selectedTsv = () => progressGridTsv(rows.slice(bounds.top, bounds.bottom + 1).map(row => row.slice(bounds.left, bounds.right + 1)));
  const copyCells = async () => {
    try { await navigator.clipboard.writeText(selectedTsv()); setNotice('選択セルをコピーしました。'); }
    catch { setError('コピーできませんでした。セルを選択してCtrl+C（Macは⌘C）を使ってください。'); }
  };
  const deleteAxis = (axis, first, last) => {
    const row = axis === 'row', start = first ?? (row ? bounds.top : bounds.left), end = last ?? (row ? bounds.bottom : bounds.right);
    setRows(previous => row
      ? (previous.filter((_, i) => i < start || i > end).length ? previous.filter((_, i) => i < start || i > end) : [Array(previous[0].length).fill('')])
      : previous.map(values => { const retained = values.filter((_, j) => j < start || j > end); return retained.length ? retained : ['']; }));
    selectCell(0, 0); setNotice(row ? '選択行を削除しました。' : '選択列を削除しました。');
    requestAnimationFrame(() => dialogRef.current?.querySelector('textarea')?.focus());
  };
  const pasteCells = (event, row, column) => {
    const plain = event.clipboardData?.getData('text/plain') || '';
    const grid = progressClipboardGrid(event.clipboardData?.getData('text/html') || '', plain, true)
      || (!editingCell && event.clipboardData?.types.includes('text/plain') ? { rows: [[plain]] } : null);
    if (!grid) return;
    event.preventDefault(); event.stopPropagation();
    if (grid.error) { setError(grid.error); return; }
    const height = Math.max(rows.length, row + grid.rows.length), width = Math.max(rows[0].length, column + grid.rows[0].length);
    const error = progressGridError(height, width);
    if (error) { setError(error); return; }
    setRows(previous => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) =>
      i >= row && i < row + grid.rows.length && j >= column && j < column + grid.rows[0].length ? grid.rows[i - row][j - column] : previous[i]?.[j] || '')));
    setSelection({ row, column, endRow: row + grid.rows.length - 1, endColumn: column + grid.rows[0].length - 1 });
    setEditingCell(null); setError(''); setNotice(`${grid.rows.length}行・${grid.rows[0].length}列を貼り付けました。`);
  };
  const maxRows = Math.min(PROGRESS_GRID_ROWS, Math.floor(PROGRESS_GRID_CELLS / rows[0].length));
  const maxColumns = Math.min(PROGRESS_GRID_COLUMNS, Math.floor(PROGRESS_GRID_CELLS / rows.length));
  const resize = (height, width) => { setRows(previous => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => previous[i]?.[j] || ''))); selectCell(0, 0); };
  const insertRow = index => setRows(previous => previous.length >= maxRows ? previous : [...previous.slice(0, index), Array(previous[0].length).fill(''), ...previous.slice(index)]);
  const insertColumn = index => setRows(previous => previous[0].length >= maxColumns ? previous : previous.map(row => [...row.slice(0, index), '', ...row.slice(index)]));
  const confirmTable = () => {
    if (!rows.some(row => row.some(cell => cell.trim()))) { setError('表に内容を入力してください。'); return; }
    onApply(rows);
  };
  const edgeControl = (axis, index, count, limit, insert, remove = false) => {
    const column = axis === 'column';
    const base = remove ? `${index + 1}${column ? '列' : '行'}目を削除`
      : index === 0 ? `先頭に${column ? '列' : '行'}を追加` : index === count ? `末尾に${column ? '列' : '行'}を追加` : `${index + 1}${column ? '列' : '行'}目の前に${column ? '列' : '行'}を追加`;
    return (column ? ['top', 'bottom'] : ['left', 'right']).map((side, sideIndex) => {
      const sideName = { top: '上辺', bottom: '下辺', left: '左辺', right: '右辺' }[side];
      const label = remove || sideIndex ? `${base}（${sideName}）` : base;
      const position = `${(index + (remove ? 0.5 : 0)) / count * 100}%`;
      return <button key={`${axis}-${remove ? 'delete' : 'insert'}-${index === count ? 'end' : index}-${side}`} type="button" data-grid-side={side}
        data-progress-table-insert={remove ? undefined : ''} data-progress-table-delete={remove ? '' : undefined}
        aria-label={label} title={remove ? base : count >= limit ? `${column ? '列' : '行'}は最大${limit}までです` : base}
        disabled={!remove && count >= limit}
        style={column ? { left: position, [side]: -28, transform: 'translateX(-50%)' } : { top: position, [side]: -28, transform: 'translateY(-50%)' }}
        onClick={() => remove ? deleteAxis(axis === 'column' ? 'column' : 'row', index, index) : insert(index)}
        className={`absolute z-20 flex h-5 w-5 items-center justify-center rounded-full border bg-white disabled:opacity-30 focus-visible:outline focus-visible:outline-2 ${remove ? 'text-red-600 focus-visible:outline-red-500' : 'text-violet-600 focus-visible:outline-violet-500'}`}>
        {remove ? <Minus size={14}/> : <Plus size={14}/>}</button>;
    });
  };
  return <div className="fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-3" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={initial ? '表を編集' : '表を作成'} className="bg-white rounded-xl shadow-xl p-4 w-full max-w-3xl max-h-[85vh] overflow-auto text-black space-y-3"
      onCopy={e => { if (editingCell) return; e.preventDefault(); e.clipboardData.setData('text/plain', selectedTsv()); }}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        const command = e.ctrlKey || e.metaKey;
        if (command && e.key === 'Enter') { e.preventDefault(); confirmTable(); return; }
        if (command && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
          e.preventDefault(); historyChange(e.key.toLowerCase() === 'y' || e.shiftKey ? 'redo' : 'undo'); return;
        }
        if (command && e.key === 'Backspace' && (e.altKey || e.shiftKey)) {
          e.preventDefault(); deleteAxis(e.altKey ? 'row' : 'column'); return;
        }
        if (e.key === 'Escape') { e.preventDefault(); if (contextMenu) closeMenu(); else onClose(); }
        if (e.key === 'Tab') {
          const items = [...dialogRef.current.querySelectorAll('button:not(:disabled), textarea, select')];
          if (e.shiftKey && e.target === items[0]) { e.preventDefault(); items[items.length - 1].focus(); }
          else if (!e.shiftKey && e.target === items[items.length - 1]) { e.preventDefault(); items[0].focus(); }
        }
      }}>
      <div className="flex justify-between items-center"><h3 className="font-bold">{initial ? '表を編集' : '表を作成'}</h3><button type="button" aria-label="表の画面を閉じる" onClick={onClose}><X size={18}/></button></div>
      <p className="text-xs text-gray-600">先頭行は見出しです。各セルに入力してください。行・列を減らすと、削除されるセルの内容は失われます。</p>
      <div className="flex flex-wrap gap-3 text-sm">
        <label>行数（見出しを含む）<select aria-label="表の行数" value={rows.length} onChange={e => resize(Number(e.target.value), rows[0].length)} className="border rounded p-1 ml-2">{Array.from({ length: maxRows }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>
        <label>列数<select aria-label="表の列数" value={rows[0].length} onChange={e => resize(rows.length, Number(e.target.value))} className="border rounded p-1 ml-2">{Array.from({ length: maxColumns }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>
      </div>
      <p className="text-xs text-gray-600">セルをドラッグして範囲選択。ダブルクリック・Enterでセル内を編集できます。Excelの範囲を貼り付けると、必要な行・列を自動で追加します。</p>
      <div className="flex flex-wrap gap-2 text-xs" role="toolbar" aria-label="表の範囲操作">
        <button type="button" className="border rounded px-2 py-1" onClick={copyCells}>選択セルをコピー</button>
        <button type="button" className="border rounded px-2 py-1" onClick={clearCells}>選択セルの内容を削除</button>
        <button type="button" className="border rounded px-2 py-1" onClick={() => deleteAxis('row')}>選択行を削除</button>
        <button type="button" className="border rounded px-2 py-1" onClick={() => deleteAxis('column')}>選択列を削除</button>
        <button type="button" aria-label="表の操作を元に戻す" title="Ctrl/⌘+Z" disabled={!gridState.past.length} onClick={() => historyChange('undo')} className="border rounded px-2 py-1 disabled:opacity-30">元に戻す</button>
        <button type="button" aria-label="表の操作をやり直す" title="Ctrl/⌘+Y / Ctrl/⌘+Shift+Z" disabled={!gridState.future.length} onClick={() => historyChange('redo')} className="border rounded px-2 py-1 disabled:opacity-30">やり直す</button>
        <span role="status">{notice || `${bounds.bottom - bounds.top + 1}行・${bounds.right - bounds.left + 1}列を選択中`}</span>
      </div>
      <p className="text-xs text-gray-600">四辺の＋で行・列を挿入、−で行・列を削除できます。選択範囲の右クリックでも操作できます。</p>
      <style>{`[data-progress-page] [data-progress-table-insert]:not(:disabled) { border-color: #8b5cf6 !important; } [data-progress-page] [data-progress-table-delete] { border-color: #ef4444 !important; }`}</style>
      <div className="overflow-x-auto p-10">
        <div className="relative" style={{ minWidth: rows[0].length * 144 }}>
          <table role="grid" aria-label="表のセル編集" aria-rowcount={rows.length} aria-colcount={rows[0].length} className="w-full border-collapse table-fixed" style={{ height: rows.length * 64 }}><tbody>{rows.map((row, i) => <tr key={i} className="h-16">{row.map((cell, j) => <td key={j} role="gridcell" aria-selected={i >= bounds.top && i <= bounds.bottom && j >= bounds.left && j <= bounds.right} className={`border p-1 ${i === 0 ? 'bg-slate-100' : ''}`}><textarea aria-label={`${i + 1}行${j + 1}列`} value={cell}
      onPointerDown={e => {
        if (e.button !== 0 || (editingCell?.row === i && editingCell?.column === j)) return;
        e.preventDefault(); e.currentTarget.focus(); e.currentTarget.select(); dragging.current = true; selectCell(i, j, e.shiftKey);
      }}
      onPointerEnter={() => { if (dragging.current) setSelection(previous => ({ ...previous, endRow: i, endColumn: j })); }}
      onContextMenu={e => openContextMenu(e, i, j)}
      onCompositionStart={() => setEditingCell({ row: i, column: j })}
      onDoubleClick={e => { selectCell(i, j); setEditingCell({ row: i, column: j }); e.currentTarget.focus(); }}
      onFocus={() => { if (!dragging.current && !(i >= bounds.top && i <= bounds.bottom && j >= bounds.left && j <= bounds.right)) selectCell(i, j); }}
      onPaste={e => pasteCells(e, bounds.top, bounds.left)}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.key === 'Process') return;
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { openContextMenu(e, i, j, true); return; }
        if ((e.ctrlKey || e.metaKey) && e.key==='Enter') return;
        const editing = editingCell?.row === i && editingCell?.column === j;
        if (e.key === 'Escape' && editing) { e.preventDefault(); e.stopPropagation(); setEditingCell(null); return; }
        if (e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault(); e.stopPropagation();
          let row = i, column = !editing && e.shiftKey && e.key !== 'Tab' ? selection.endColumn : j;
          if (e.key === 'Tab') {
            const position = Math.max(0, Math.min(rows.length * rows[0].length - 1, i * rows[0].length + j + (e.shiftKey ? -1 : 1)));
            row = Math.floor(position / rows[0].length); column = position % rows[0].length;
          } else row = Math.max(0, Math.min(rows.length - 1, (!editing && e.shiftKey ? selection.endRow : i) + (e.key === 'ArrowDown' ? 1 : -1)));
          selectCell(row, column, e.shiftKey && e.key !== 'Tab' && !editing);
          if (!e.shiftKey || e.key === 'Tab' || editing) {
            const next = dialogRef.current?.querySelector(`[aria-label="${row + 1}行${column + 1}列"]`);
            next?.focus(); next?.select();
          }
          return;
        }
        if (editing) return;
        if ((e.key === 'Delete'  || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); clearCells(); }
        else if (e.key === 'F2' || e.key === 'Enter') { e.preventDefault(); setEditingCell({ row: i, column: j }); e.currentTarget.setSelectionRange(cell.length, cell.length); }
        else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
          e.preventDefault(); const nextRow = Math.max(0, Math.min(rows.length - 1, selection.endRow + (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0)));
          const nextColumn = Math.max(0, Math.min(rows[0].length - 1, selection.endColumn + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0)));
          selectCell(nextRow, nextColumn, e.shiftKey);
          if (!e.shiftKey) dialogRef.current?.querySelector(`[aria-label="${nextRow + 1}行${nextColumn + 1}列"]`)?.focus();
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          setEditingCell({ row: i, column: j });
          setRows(previous => previous.map((r, ri) => ri === i ? r.map((v, ci) => ci === j ? e.key : v) : r)); e.preventDefault();
        }
      }}
      onChange={e => { const value = e.target.value; setRows(previous => previous.map((r, ri) => ri === i ? r.map((v, ci) => ci === j ? value : v) : r)); }}
      className={`block h-12 w-full resize-none p-1 text-sm border rounded ${i >= bounds.top && i <= bounds.bottom && j >= bounds.left && j <= bounds.right ? 'bg-violet-100 ring-1 ring-violet-500' : 'bg-white'}`} rows={2}/></td>)}</tr>)}</tbody></table>
          {Array.from({ length: rows[0].length + 1 }, (_, index) => edgeControl('column', index, rows[0].length, maxColumns, insertColumn))}
          {Array.from({ length: rows.length + 1 }, (_, index) => edgeControl('row', index, rows.length, maxRows, insertRow))}
          {Array.from({ length: rows[0].length }, (_, index) => edgeControl('column', index, rows[0].length, maxColumns, insertColumn, true))}
          {Array.from({ length: rows.length }, (_, index) => edgeControl('row', index, rows.length, maxRows, insertRow, true))}
        </div>
      </div>
      {contextMenu && <div ref={menuRef} role="menu" aria-label="表の選択範囲の操作" style={{ left: contextMenu.x, top: contextMenu.y }} className="fixed z-[200] w-64 rounded-lg border bg-white p-1 shadow-xl text-sm"
        onKeyDown={e => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault(); e.stopPropagation(); const items = [...menuRef.current.querySelectorAll('[role="menuitem"]')], index = items.indexOf(document.activeElement);
            items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
          }
          if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
        }}>
        {[
          ['コピー', 'Ctrl/⌘+C', copyCells],
          ['選択行削除', 'Ctrl/⌘+Alt+Backspace', () => deleteAxis('row')],
          ['選択列削除', 'Ctrl/⌘+Shift+Backspace', () => deleteAxis('column')],
          ['セル内容削除', 'Delete / Backspace', clearCells]
        ].map(([label, shortcut, action]) => <button key={label} type="button" role="menuitem" onClick={() => { action(); closeMenu(); }} className="flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left hover:bg-violet-50 focus:bg-violet-50 focus:outline-none"><span>{label}</span><span className="text-[10px] text-gray-500">{shortcut}</span></button>)}
      </div>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="border rounded px-3 py-2">キャンセル</button><button type="button" className="bg-blue-600 text-white rounded px-3 py-2" onClick={confirmTable}>{initial ? '表を更新' : '表を挿入'}</button></div>
    </section>
  </div>;
};
const ProgressComposer = ({ text, textLinks, textFormats = [], onChange, onPasteImages, editorRef, editing, expanded = false }) => {
  const composing = useRef(false);
  const [pasteError, setPasteError] = useState('');
  const [tableDialog, setTableDialog] = useState(null);
  const [tableIndex, setTableIndex] = useState(0);
  const tables = progressTables(text);
  const selectionRef = useRef(null);
  const openTable = edit => {
    const selection = window.getSelection();
    selectionRef.current = selection?.rangeCount && editorRef.current.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
    const table = tables[Math.min(tableIndex, tables.length - 1)];
    setTableDialog(edit ? { table } : {});
  };
  const applyTable = rows => {
    const markdown = progressTableText(rows);
    if (tableDialog.table) {
      const { start, end } = tableDialog.table, delta = markdown.length - (end - start);
      onChange({ text: text.slice(0, start) + markdown + text.slice(end), textFormats: progressTextFormats(text,textFormats).filter(mark=>mark.end<=start || mark.start>=end).map(mark=>mark.start>=end?{...mark,start:mark.start+delta,end:mark.end+delta}:mark), textLinks: progressTextLinks(text, textLinks).filter(link => link.end <= start || link.start >= end).map(link => link.start >= end ? { ...link, start: link.start + delta, end: link.end + delta } : link) });
    } else {
      editorRef.current.focus();
      const selection = window.getSelection();
      if (selectionRef.current) { selection.removeAllRanges(); selection.addRange(selectionRef.current); }
      else { const range = document.createRange(); range.selectNodeContents(editorRef.current); range.collapse(false); selection.removeAllRanges(); selection.addRange(range); }
      const container = document.createElement('div'); container.append(progressEditorFragment('\n\n' + markdown + '\n\n', []));
      document.execCommand('insertHTML', false, container.innerHTML); emit();
    }
    setTableDialog(null);
  };
  const read = () => readProgressEditor(editorRef.current);
  const emit = () => onChange(read());
  React.useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || composing.current) return;
    const current = read(), wanted = progressTextLinks(text, textLinks);
    if (current.text === text && JSON.stringify(current.textLinks) === JSON.stringify(wanted) && JSON.stringify(current.textFormats) === JSON.stringify(progressTextFormats(text,textFormats)) && (text || !editor.textContent)) return;
    editor.replaceChildren(progressEditorFragment(text, wanted, textFormats));
  }, [text, textLinks, textFormats]);
  const format = command => { editorRef.current.focus(); document.execCommand(command,false,null); emit(); };
  const paste = e => {
    e.preventDefault();
    const clipboard = e.clipboardData;
    const files = [...(clipboard?.files || [])];
    const images = files.length ? files : [...(clipboard?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
    const plain = clipboard?.getData('text/plain') || '', html = clipboard?.getData('text/html');
    const template=document.createElement('template'); template.innerHTML=html || '';
    const semanticHtml=!!template.content.querySelector('table,ul,ol,[role="list"],[role="listitem"],[style*="mso-list"],.MsoListParagraph');
    const lines=plain.split(/\r?\n/).filter(line=>line.trim());
    const listText=lines.length>0 && lines.every(line=>/^\s*(?:[-*•●◦▪・]|\d+[.)])\s+/.test(line));
    const grid=!semanticHtml && !listText ? progressClipboardGrid('',plain) : null;
    const draft=grid?.rows ? {text:'\n\n'+progressTableText(grid.rows)+'\n\n',textLinks:[],textFormats:[]} : grid?.error ? grid : progressClipboardDraft(html,plain);
    if(draft.error){setPasteError(draft.error);return;} setPasteError('');
    if (draft.text) {
      const container = document.createElement('div');
      container.append(progressEditorFragment(draft.text, progressAllTextLinks(draft.text, draft.textLinks), draft.textFormats));
      // Keep subsequent typing outside the pasted hyperlink; omit this caret marker when saving.
      if (container.lastChild?.nodeName === 'A') container.append(document.createTextNode('\u200B'));
      editorRef.current.focus();
      document.execCommand('insertHTML', false, container.innerHTML);
      emit();
    }
    if (images.length) onPasteImages(images);
  };
  return <div className={`relative ${expanded ? 'flex flex-col flex-1 min-h-0' : ''}`}>
    <div role="toolbar" aria-label="トークの表ツール" className="shrink-0 flex flex-wrap items-center gap-1 px-2 pt-1 text-xs">
      <button type="button" aria-label="表を作成" title="表を作成" onMouseDown={e => e.preventDefault()} onClick={() => openTable(false)} className="rounded p-1 hover:bg-slate-100"><Table2 size={18}/></button>
      <button type="button" aria-label="表を編集" title="表を編集" disabled={!tables.length} onMouseDown={e => e.preventDefault()} onClick={() => openTable(true)} className="rounded p-1 hover:bg-slate-100 disabled:opacity-30"><Pencil size={18}/></button>
      {tables.length > 1 && <select aria-label="編集する表" value={Math.min(tableIndex, tables.length - 1)} onChange={e => setTableIndex(Number(e.target.value))} className="border rounded">{tables.map((table, i) => <option key={i} value={i}>表 {i + 1}: {table.rows[0].join(' / ').slice(0, 40)}</option>)}</select>}
      <span className="h-4 border-l" aria-hidden="true"/>
      {[['bold','太字','B'],['italic','斜体','I'],['underline','下線','U'],['strikeThrough','取り消し線','S'],['insertUnorderedList','箇条書き','•'],['insertOrderedList','番号付きリスト','1.']].map(([command,label,icon]) => <button key={command} type="button" aria-label={label} title={label} onMouseDown={e=>e.preventDefault()} onClick={()=>format(command)} className="rounded px-1.5 py-0.5 hover:bg-slate-100"><span style={{fontWeight:command==='bold'?'bold':undefined,fontStyle:command==='italic'?'italic':undefined,textDecoration:command==='underline'?'underline':command==='strikeThrough'?'line-through':undefined}}>{icon}</span></button>)}
    </div>
    {pasteError && <p role="alert" className="px-2 text-xs text-red-700">{pasteError}</p>}
    {tableDialog && <ProgressTableDialog initial={tableDialog.table?.rows} onApply={applyTable} onClose={() => setTableDialog(null)}/>}
    <div ref={editorRef} role="textbox" aria-multiline="true" aria-label={editing ? 'コメントの編集' : '進捗コメント'} title="Enter: 改行 / Ctrl+Enter: 送信 / Alt+Enter: 相手待ち / Shift+Enter: コメント / Ctrl+Shift+Enter: 小タスク追加 / Ctrl+Alt+Enter: やるべきこと追加 / Ctrl+Shift+Alt+Enter: 前提メモ" contentEditable suppressContentEditableWarning
      onInput={emit} onPaste={paste} onKeyDown={e=>{ if(e.nativeEvent.isComposing)return; if((e.ctrlKey || e.metaKey) && ['b','i','u'].includes(e.key.toLowerCase())) { e.preventDefault(); e.stopPropagation(); format(({b:'bold',i:'italic',u:'underline'})[e.key.toLowerCase()]); } }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; emit(); }}
      className={`w-full ${expanded ? 'flex-1 min-h-32' : 'min-h-10 max-h-40'} overflow-y-auto rounded-xl p-2 text-sm text-black whitespace-pre-wrap break-words focus:outline-none`}/>
    {!text && <span aria-hidden="true" className="absolute top-10 left-2 right-2 pointer-events-none text-xs text-gray-400">コメントを入力…画像・リンク貼り付け可（Ctrl+Enter で送信）</span>}
  </div>;
};

const ProgressAttachments = ({ images = [], links = [], onRemoveImage, onRemoveLink }) => {
  const [expanded, setExpanded] = useState(null);
  const closeRef = useRef(null);
  useEffect(() => {
    if (!expanded) return;
    const previous = document.activeElement;
    closeRef.current?.focus();
    const close = e => { if (e.key === 'Escape') setExpanded(null); };
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('keydown', close); previous?.focus(); };
  }, [expanded]);
  const visibleImages = progressMediaItems(images).filter(image => typeof image.src === 'string' && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(image.src));
  const visibleLinks = progressMediaItems(links).filter(link => progressSafeUrl(link.url));
  return <>
    {!!visibleImages.length && <div className="flex flex-wrap gap-2 mt-2">{visibleImages.map(image => <div key={image.id} className="relative rounded-lg border bg-white p-1 max-w-full">
      <button type="button" aria-label={`画像を拡大: ${image.name}`} onClick={() => setExpanded(image)}><img src={image.src} alt={image.name} className="max-h-40 max-w-full rounded object-contain"/></button>
      {onRemoveImage && <button type="button" aria-label={`添付画像を削除: ${image.name}`} onClick={() => onRemoveImage(image.id)} className="block text-xs text-red-700 underline">削除</button>}
    </div>)}</div>}
    {!!visibleLinks.length && <ul className="space-y-1 mt-2 text-sm">{visibleLinks.map(link => <li key={link.id} className="flex gap-2 items-start min-w-0">
      <a href={progressSafeUrl(link.url)} target="_blank" rel="noopener noreferrer" className="underline break-all" style={{ color: '#000' }}>{link.label || link.url}</a>
      {onRemoveLink && <button type="button" aria-label={`添付リンクを削除: ${link.label || link.url}`} onClick={() => onRemoveLink(link.id)} className="text-xs text-red-700 shrink-0 underline">削除</button>}
    </li>)}</ul>}
    {expanded && <div role="dialog" aria-modal="true" aria-label="トークの画像" className="fixed inset-0 z-[90] bg-black/80 flex flex-col items-center justify-center p-4 gap-3" onClick={() => setExpanded(null)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setExpanded(null); } }}>
      <button ref={closeRef} type="button" aria-label="画像を閉じる" onClick={() => setExpanded(null)} className="rounded-lg bg-white text-gray-900 px-4 py-2 self-end">閉じる</button>
      <img src={expanded.src} alt={expanded.name} className="max-h-[80vh] max-w-full object-contain" onClick={e => e.stopPropagation()}/>
    </div>}
  </>;
};

const ProgressQuote = ({ quote, onNavigate, task }) => {
  const [expanded, setExpanded] = useState(false);
  const [longContent, setLongContent] = useState(false);
  const contentRef = useRef(null), contentId = React.useId();
  const collapsible = !!quote.quote || longContent || (typeof quote.text === 'string' && quote.text.split(/\r?\n/).length >= 3);
  const collapsed = collapsible && !expanded;
  useEffect(() => { setExpanded(false); }, [quote.id]);
  React.useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(content).lineHeight) || 16;
      setLongContent(content.getBoundingClientRect().height > lineHeight * 2 + 0.5);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); observer.observe(content);
    return () => observer.disconnect();
  }, [quote.text, quote.textFormats, quote.textLinks, quote.images, quote.links, quote.smallTaskTitle]);
  return <blockquote aria-label="引用コメント" data-quoted-entry-id={quote.id} data-quote-collapsed={collapsed}
  className={`my-2 rounded-lg border-l-4 px-3 py-2 bg-white/60 text-xs ${progressToneBorders[progressEntryTone(quote, task)]}`}>
  <div className="flex flex-wrap gap-2 text-gray-500 mb-1">
    <span>引用</span>{quote.createdAt && <time dateTime={quote.createdAt}>{new Date(quote.createdAt).toLocaleString('ja-JP')}</time>}
    {quote.assumptionMemo && <span>前提メモ</span>}
    {quote.status === 'waiting' && <span>引用当時: 相手待ち</span>}
    {onNavigate && <button type="button" aria-label={`引用元へ移動: ${quote.text}`} onClick={() => onNavigate(quote)} className="text-blue-700 underline">引用元へ移動</button>}
    {collapsible && <button type="button" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)} className="text-blue-700 underline">{expanded ? '引用を折りたたむ' : '引用を展開'}</button>}
  </div>
  <div id={contentId}>
    <div className={collapsed ? 'max-h-8 overflow-hidden' : ''}>
      <div ref={contentRef} className="leading-4">
        <div className="whitespace-pre-wrap break-words"><ProgressText value={quote.text} textLinks={quote.textLinks} textFormats={quote.textFormats}/></div>
        <ProgressAttachments images={quote.images} links={quote.links}/>
      </div>
      {quote.smallTaskTitle && <p className="mt-1 text-gray-500 break-words">小さいタスク: {quote.smallTaskTitle}</p>}
    </div>
    {quote.quote && <div hidden={!expanded} className={expanded ? '' : 'hidden'}><ProgressQuote quote={quote.quote} onNavigate={onNavigate} task={task}/></div>}
  </div>
</blockquote>;
};

const QuoteSourceModal = ({ quote, onClose, task }) => {
  const closeRef = useRef(null), modalRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const handleKey = e => {
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); onClose(); }
      if (e.key === 'Tab') {
        const elements = [...(modalRef.current?.querySelectorAll('button:not([disabled]),a[href]') || [])].filter(element => element.getClientRects().length);
        const first = elements[0], last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); previous?.focus(); };
  }, [onClose]);
  return <div className="fixed inset-0 bg-black/60 z-50 p-4 flex items-center justify-center">
    <section ref={modalRef} role="dialog" aria-modal="true" aria-label="引用元のコメント" className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white rounded-2xl shadow-2xl p-5">
      <header className="flex justify-between items-center gap-3 mb-3"><h2 className="font-bold">引用元のコメント</h2>
        <button ref={closeRef} type="button" aria-label="引用元の確認を閉じる" onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100"><X size={20}/></button>
      </header>
      <p className="text-sm text-gray-500">引用元は現在の一覧にないため、引用時に保存した内容を表示しています。</p>
      <ProgressQuote quote={quote} task={task}/>
    </section>
  </div>;
};

// --- Mock Initial Data ---
const initialTasks = [
  {
    id: 't1', type: 'simple', title: '要件定義書のレビュー',
    date: TODAY_STR, dueDate: TODAY_STR, memo: '顧客からのFB反映確認', urls: [], completed: false,
    completionNote: '', resultUrls: [], resultImages: [], order: Date.now()
  },
  {
    id: 't2', type: 'simple', title: '先週の経費精算',
    date: formatDate(addDays(new Date(), -2)), dueDate: formatDate(addDays(new Date(), -4)), memo: '', urls: [], completed: true,
    completionNote: '申請完了しました', resultUrls: [], resultImages: [], order: Date.now() + 1000
  }
];

const initialRecurringSchedules = [
  {
    id: 'r1',
    title: '週次定例ミーティング',
    frequency: 'weekly',
    interval: 1,
    dayOfWeek: getLocalDate(TODAY_STR).getDay(),
    dayOfMonth: getLocalDate(TODAY_STR).getDate(),
    startDate: TODAY_STR,
    endDate: '',
    memo: '毎週の定例予定',
    urls: []
  }
];

const initialProjects = [
  {
    id: 'p1', title: '秋期大型リリース', type: 'project', durationWeeks: 4,
    tasksTemplate: [
      { id: 'tt1', title: '要件定義完了' },
      { id: 'tt2', title: '環境構築＆テスト開始' },
      { id: 'tt3', title: 'ユーザー受け入れテスト' },
      { id: 'tt4', title: '本番デプロイ' }
    ]
  },
  {
    id: 'e1', title: '全社目標設定プロセス (上期)', type: 'evaluation', durationWeeks: 3,
    tasksTemplate: [
      { id: 'tt5', title: '全社方針発表' },
      { id: 'tt6', title: '部門目標の策定' },
      { id: 'tt7', title: '個別面談の完了' }
    ]
  }
];

// --- Components ---

const TaskCard = ({ task, onEdit, onCompleteAction, onPointerDown, onCompleteSubtask, onEditParentTask, onToggleProgress }) => {
  const isOverdue = new Date(task.dueDate) < new Date(TODAY_STR) && !task.completed;
  const isCompleted = task.completed;
  const [isSubtasksOpen, setIsSubtasksOpen] = useState(false);

  const stateClasses = isCompleted
    ? "bg-blue-50 border-blue-300"
    : isOverdue
      ? "bg-red-50 border-red-300 hover:border-red-400"
      : task.waiting
        ? "bg-green-50 border-green-300 hover:border-green-400"
        : "bg-purple-50 border-purple-300 hover:border-purple-400";

  return (
    <div
      id={`task-${task.id}`}
      data-task-id={task.id}
      data-is-subtask={task.isSubtask || false}
      data-drop-date={task.date}
      className={`relative p-3 mb-2 rounded-xl shadow-sm border flex gap-2 transition-colors ${stateClasses}`}
    >
      <div
        className="flex flex-col items-center justify-center cursor-grab touch-none text-gray-300 hover:text-gray-600 active:text-blue-500 px-1 -ml-1"
        onPointerDown={(e) => onPointerDown(e, 'task', task)}
      >
        <GripVertical size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-start mb-1">
          <span className={`text-[10px] font-black tracking-wider uppercase px-2 py-0.5 rounded-full
            ${task.type === 'project' ? 'bg-purple-100 text-purple-700' :
              task.type === 'evaluation' || task.type === 'single_eval' ? 'bg-orange-100 text-orange-700' :
              task.type === 'recurring' ? 'bg-green-100 text-green-700' :
              task.type === 'subtask' ? 'bg-gray-100 text-gray-600' :
              'bg-blue-100 text-blue-700'}`}>
            {task.type === 'project' ? 'Project' :
             task.type === 'evaluation' ? 'Eval' :
             task.type === 'recurring' ? 'Sync' :
             task.type === 'subtask' ? 'Subtask' : 'Task'}
          </span>
          <div className="flex gap-1 -mt-1 -mr-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (task.isSubtask) {
                  onEditParentTask(task.parentId);
                } else {
                  onEdit(task);
                }
              }}
              className="p-1.5 text-gray-400 hover:text-blue-600 transition-colors rounded-lg hover:bg-blue-50"
              title={task.isSubtask ? "親タスクを編集" : "編集"}
            >
              <Pencil size={16} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCompleteAction(task);
              }}
              className={`p-1.5 transition-colors rounded-lg ${isCompleted ? 'text-green-600 bg-green-50 hover:bg-green-100 hover:text-green-700' : 'text-gray-400 hover:text-green-600 hover:bg-green-50'}`}
              title="結論入力 / 完了"
            >
              <CheckSquare size={18} />
            </button>
          </div>
        </div>

        {onToggleProgress && !task.isSubtask && (
          <label className="flex items-center gap-1.5 text-xs text-blue-700 font-bold my-2 cursor-pointer">
            <input type="checkbox" checked={!!task.progressEnabled}
              aria-label={`「${task.title}」を進捗ページに表示`}
              onChange={e => onToggleProgress(task, e.target.checked)}
              className="w-4 h-4 rounded accent-blue-600" />
            進捗ページに表示
          </label>
        )}
        <h4 className={`font-bold text-sm mb-1 line-clamp-2 leading-tight
          ${isCompleted ? 'text-gray-500' : isOverdue ? 'text-red-700' : 'text-gray-800'}`}>
          {task.title}
        </h4>

        {task.dueDate && (
          <div className={`flex items-center gap-1 text-xs mb-1 ${isCompleted ? 'text-gray-400' : isOverdue ? 'text-red-600 font-bold' : 'text-gray-500'}`}>
            {isOverdue && !isCompleted ? <AlertCircle size={12} /> : <Clock size={12} />}
            <span>{task.dueDate}</span>
          </div>
        )}

        {/* リンクアイコンの表示（関連URL/成果物URL） */}
        {(task.urls?.length > 0 || task.resultUrls?.length > 0) && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {task.urls?.map((url, idx) => (
              <a key={`u-${idx}`} href={url} target="_blank" rel="noopener noreferrer" className="bg-gray-100 hover:bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded text-[10px] font-bold flex items-center gap-0.5 border border-gray-200 transition-colors" onClick={e => e.stopPropagation()} title={url}>
                <LinkIcon size={10} /> 関連
              </a>
            ))}
            {task.resultUrls?.map((url, idx) => (
              <a key={`ru-${idx}`} href={url} target="_blank" rel="noopener noreferrer" className="bg-blue-50 hover:bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded text-[10px] font-bold flex items-center gap-0.5 border border-blue-200 transition-colors" onClick={e => e.stopPropagation()} title={url}>
                <LinkIcon size={10} /> 成果
              </a>
            ))}
          </div>
        )}

        {!task.isSubtask && task.subtasks && task.subtasks.length > 0 && (
          <div className="mt-2">
            <button
              onClick={(e) => { e.stopPropagation(); setIsSubtasksOpen(!isSubtasksOpen); }}
              className="flex items-center gap-1 text-[10px] font-bold text-gray-500 hover:text-blue-600 transition-colors bg-gray-50 border border-gray-200 px-2 py-1 rounded w-full justify-between"
            >
              <span>小タスク一覧 ({task.subtasks.length})</span>
              {isSubtasksOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>

            {isSubtasksOpen && (
              <div className="mt-1 space-y-1 bg-gray-50/80 p-1.5 rounded border border-gray-100">
                {task.subtasks.map((st, i) => {
                  const stId = st.id || `${task.id}-sub-${i}`;
                  return (
                    <div key={stId} className={`flex justify-between items-center text-[10px] border rounded px-1.5 py-1 ${progressStatusClasses(progressItemStatus(st, task))}`}>
                      <span className="truncate flex-1 font-medium mr-2">{st.title}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="opacity-70">{st.dueDate?.slice(5).replace('-', '/')}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const subtaskEl = document.getElementById(`task-${stId}`);
                            if (subtaskEl) {
                              subtaskEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                              subtaskEl.classList.add('ring-2', 'ring-blue-500', 'bg-blue-50');
                              setTimeout(() => {
                                subtaskEl.classList.remove('ring-2', 'ring-blue-500', 'bg-blue-50');
                              }, 1500);
                            } else {
                              alert('小タスクが画面内に見つかりません。別の週に配置されている可能性があります。');
                            }
                          }}
                          className="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded hover:bg-blue-200 transition-colors flex items-center gap-0.5 font-bold"
                          title="小タスクへ飛ぶ"
                        >
                          飛ぶ <ArrowLeft size={10} className="rotate-180" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {task.isSubtask && (
          <div className="mt-2 bg-gray-50 border border-gray-200 rounded p-2 flex flex-col gap-1">
            <div className="text-[10px] text-gray-500 font-bold flex items-center justify-between">
              <span>親タスク</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const parentEl = document.getElementById(`task-${task.parentId}`);
                  if (parentEl) {
                    parentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    parentEl.classList.add('ring-2', 'ring-blue-500', 'bg-blue-50');
                    setTimeout(() => {
                      parentEl.classList.remove('ring-2', 'ring-blue-500', 'bg-blue-50');
                    }, 1500);
                  } else {
                    alert('親タスクが画面内に見つかりません。別の週に配置されている可能性があります。');
                  }
                }}
                className="text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded hover:bg-blue-200 font-bold flex items-center gap-0.5 transition-colors"
                title="親タスクへスクロール"
              >
                <ArrowLeft size={10} className="rotate-90" /> 親へ飛ぶ
              </button>
            </div>
            <div className="text-xs font-bold text-gray-700 truncate">{task.parentTitle}</div>
            <div className="text-[10px] text-red-500 font-bold flex items-center gap-0.5 mt-0.5">
              <Clock size={10} /> 納期: {task.parentDueDate}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const BoardColumn = ({ date, dateLabel, tasks, onEdit, onCompleteAction, onPointerDown, isHovered, onAddTask, onCompleteSubtask, onEditParentTask, onToggleProgress }) => {
  const isToday = date === TODAY_STR;
  return (
    <div
      data-drop-zone="column"
      data-drop-date={date}
      className={`flex-none w-[280px] bg-gray-50/80 rounded-2xl border-2 flex flex-col h-full min-h-[300px] overflow-hidden transition-all
        ${isHovered ? 'border-blue-400 bg-blue-50/50 shadow-inner' : isToday ? 'border-blue-300 shadow-sm' : 'border-gray-200'}`}
    >
      <div className={`p-3 text-center border-b flex justify-center items-center relative ${isToday ? 'bg-blue-100 text-blue-800' : 'bg-gray-200/50 text-gray-700'}`}>
        <div className="flex items-baseline gap-2">
          <span className="font-black text-lg">{dateLabel}</span>
          <span className="text-xs font-medium opacity-75">{date.slice(5)}</span>
        </div>
        <button
          onClick={() => onAddTask(date)}
          className={`absolute right-2 p-1.5 rounded-xl transition-colors ${isToday ? 'text-blue-600 hover:bg-blue-200' : 'text-gray-400 hover:text-blue-600 hover:bg-gray-200'}`}
          title={`${date} にタスクを追加`}
        >
          <Plus size={18} />
        </button>
      </div>
      <div className="flex-1 p-3 overflow-y-auto">
        {tasks.map(task => (
          <TaskCard
            key={task.id}
            task={task}
            onEdit={onEdit}
            onCompleteAction={onCompleteAction}
            onPointerDown={onPointerDown}
            onCompleteSubtask={onCompleteSubtask}
            onEditParentTask={onEditParentTask}
            onToggleProgress={onToggleProgress}
          />
        ))}
        {tasks.length === 0 && (
          <div className="h-20 flex items-center justify-center text-gray-400 text-xs border-2 border-dashed border-gray-200 rounded-xl m-2 opacity-50">
            タスクなし
          </div>
        )}
      </div>
    </div>
  );
};

const ListViewTask = ({ task, onEdit, onCompleteAction, onPointerDown }) => {
  const isOverdue = new Date(task.dueDate) < new Date(TODAY_STR) && !task.completed;
  const isCompleted = task.completed;

  // リッチテキストエリア内のリンクを強制的に開かせる
  const handleRichTextClick = (e) => {
    const a = e.target.closest('a');
    if (a) {
      e.preventDefault();
      e.stopPropagation();
      window.open(a.href, a.target || '_blank');
    }
  };

  return (
    <div
      id={`list-task-${task.id}`}
      data-task-id={task.id}
      data-is-subtask={task.isSubtask || false}
      data-drop-date={task.date}
      className={`p-4 rounded-xl border flex flex-col md:flex-row gap-4 items-start md:items-center transition-colors
      ${isCompleted ? 'bg-blue-50 border-blue-300' : isOverdue ? 'bg-red-50 border-red-200' : task.waiting ? 'bg-green-50 border-green-300' : 'bg-purple-50 border-purple-300 shadow-sm hover:border-purple-400'}`}
    >
      <div
        className="flex flex-col items-center justify-center cursor-grab touch-none text-gray-300 hover:text-gray-600 active:text-blue-500 px-1 -ml-2 h-full"
        onPointerDown={(e) => onPointerDown && onPointerDown(e, 'task', task)}
      >
        <GripVertical size={20} />
      </div>

      <div className="flex-1 min-w-0 flex flex-col gap-1.5 w-full">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-black tracking-wider uppercase px-2 py-0.5 rounded-full
            ${task.type === 'project' ? 'bg-purple-100 text-purple-700' :
              task.type === 'evaluation' || task.type === 'single_eval' ? 'bg-orange-100 text-orange-700' :
              task.type === 'recurring' ? 'bg-green-100 text-green-700' :
              task.type === 'subtask' ? 'bg-gray-100 text-gray-600' : 'bg-blue-100 text-blue-700'}`}>
            {task.type === 'project' ? 'Project' : task.type === 'evaluation' ? 'Eval' : task.type === 'recurring' ? 'Sync' : task.type === 'subtask' ? 'Subtask' : 'Task'}
          </span>
          {isOverdue && !isCompleted && (
             <span className="text-[10px] font-bold text-red-600 bg-red-100 px-2 py-0.5 rounded-full flex items-center gap-1"><AlertCircle size={10}/> 期限切れ</span>
          )}
        </div>
        <h4 className={`font-bold text-base leading-tight ${isCompleted ? 'text-gray-500' : isOverdue ? 'text-red-700' : 'text-gray-900'}`}>{task.title}</h4>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 font-medium">
          <span className="flex items-center gap-1"><Calendar size={12}/> 表示日: {task.date}</span>
          <span className="flex items-center gap-1"><Clock size={12}/> 期限: {task.dueDate}</span>
        </div>

        {task.subtasks && task.subtasks.length > 0 && (
          <div className="mt-2 bg-gray-50 p-2.5 rounded-lg border border-gray-200/60">
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1 block">Subtasks</span>
            <div className="space-y-1">
              {task.subtasks.map((st, i) => (
                <div key={i} className="flex justify-between items-center text-xs text-gray-700">
                  <span className="truncate flex-1">• {st.title}</span>
                  <span className="text-gray-500 shrink-0 ml-2">{st.dueDate?.slice(5)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {(task.memo || task.richResult || task.completionNote || (task.resultImages && task.resultImages.length > 0) || (task.resultUrls && task.resultUrls.length > 0) || (task.urls && task.urls.length > 0)) && (
          <div className="mt-2 text-xs bg-white/50 p-2.5 rounded-lg border border-gray-200/60 space-y-2">
            {task.memo && <div className="text-gray-600"><span className="font-bold bg-gray-100 px-1.5 py-0.5 rounded mr-1">メモ</span> {task.memo}</div>}

            {task.richResult ? (
              <div
                className="rich-text-content text-blue-900 bg-blue-50/50 p-2 rounded border border-blue-100"
                dangerouslySetInnerHTML={{ __html: task.richResult }}
                onClick={handleRichTextClick}
              />
            ) : (
              <>
                {task.completionNote && <div className="text-blue-800"><span className="font-bold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded mr-1">成果/結果</span> {task.completionNote}</div>}
                {task.resultImages && task.resultImages.length > 0 && (
                  <div className="flex gap-2 mt-2 pt-2 border-t border-gray-100 overflow-x-auto">
                    {task.resultImages.map((img, idx) => (
                      <img key={idx} src={img} alt="成果物" className="h-16 w-16 object-cover rounded border border-gray-200 shrink-0" />
                    ))}
                  </div>
                )}
              </>
            )}

            {/* 関連URLの表示と開くボタン */}
            {task.urls && task.urls.length > 0 && (
              <div className="flex flex-col gap-1.5 mt-2 pt-2 border-t border-gray-100">
                <span className="font-bold text-gray-500">関連URL:</span>
                {task.urls.map((url, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <a href={url} target="_blank" rel="noopener noreferrer" className="text-gray-600 hover:underline flex items-center gap-1 flex-1 truncate" onClick={e => e.stopPropagation()}>
                      <LinkIcon size={12} className="shrink-0" /> {url}
                    </a>
                    <a href={url} target="_blank" rel="noopener noreferrer" className="bg-gray-100 text-gray-700 px-2 py-1 rounded border border-gray-200 hover:bg-gray-200 shrink-0 font-bold" onClick={e => e.stopPropagation()}>
                      開く
                    </a>
                  </div>
                ))}
              </div>
            )}

            {/* 成果物URLの表示と開くボタン */}
            {task.resultUrls && task.resultUrls.length > 0 && (
              <div className="flex flex-col gap-1.5 mt-2 pt-2 border-t border-gray-100">
                <span className="font-bold text-blue-500">成果物リンク:</span>
                {task.resultUrls.map((url, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1 flex-1 truncate" onClick={e => e.stopPropagation()}>
                      <LinkIcon size={12} className="shrink-0" /> {url}
                    </a>
                    <a href={url} target="_blank" rel="noopener noreferrer" className="bg-blue-50 text-blue-600 px-2 py-1 rounded border border-blue-200 hover:bg-blue-100 shrink-0 font-bold" onClick={e => e.stopPropagation()}>
                      開く
                    </a>
                  </div>
                ))}
              </div>
            )}

          </div>
        )}
      </div>

      <div className="flex gap-2 shrink-0 w-full md:w-auto justify-end mt-2 md:mt-0">
        <button
          onClick={() => onEdit(task)}
          className="p-2 text-gray-500 hover:text-blue-600 bg-white border border-gray-200 rounded-lg shadow-sm hover:bg-blue-50 transition-colors"
          title="編集"
        >
          <Pencil size={18} />
        </button>
        <button
          onClick={() => onCompleteAction(task)}
          className={`px-4 py-2 flex items-center justify-center gap-2 border rounded-lg font-bold text-sm shadow-sm transition-colors flex-1 md:flex-none
            ${isCompleted ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100' : 'bg-white text-gray-600 border-gray-200 hover:text-green-600 hover:border-green-300 hover:bg-green-50'}`}
        >
          <CheckSquare size={18} />
          {isCompleted ? '完了済 / 成果確認' : '結論・完了'}
        </button>
      </div>
    </div>
  );
};

const TaskModal = ({ isOpen, onClose, onSave, onDelete, defaultDate = TODAY_STR, editingTask, projects }) => {
  const [newTaskType, setNewTaskType] = useState('simple');
  const [formData, setFormData] = useState({ title: '', dueDate: defaultDate, memo: '', urls: [''] });
  const [subtasks, setSubtasks] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');

  useEffect(() => {
    if (isOpen) {
      if (editingTask) {
        setNewTaskType(editingTask.type);
        setFormData({
          title: editingTask.title,
          dueDate: editingTask.dueDate,
          memo: editingTask.memo || '',
          urls: editingTask.urls && editingTask.urls.length > 0 ? editingTask.urls : ['']
        });
        setSubtasks(getProgressSubtasks(editingTask));
        setSelectedProjectId('');
      } else {
        setNewTaskType('simple');
        setFormData({ title: '', dueDate: defaultDate, memo: '', urls: [''] });
        setSubtasks([]);
        setSelectedProjectId('');
      }
    }
  }, [isOpen, defaultDate, editingTask]);

  if (!isOpen) return null;

  const hasSubtasks = ['simple', 'single_eval', 'project', 'evaluation', 'project_subtask'].includes(newTaskType);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (newTaskType === 'project_subtask' && !editingTask) {
      const targetProject = projects.find(p => p.id === selectedProjectId);
      if(!targetProject) return alert('プロジェクトを選択してください');

      onSave({
        type: targetProject.type,
        title: `[${targetProject.title}] ${formData.title}`,
        rawTitle: formData.title,
        projectId: targetProject.id,
        isProjectSubtask: true,
        dueDate: formData.dueDate,
        memo: formData.memo,
        urls: formData.urls.filter(u => u.trim() !== ''),
        subtasks: subtasks
      });
    } else {
      onSave({
        id: editingTask?.id,
        type: newTaskType,
        title: formData.title,
        dueDate: formData.dueDate,
        memo: formData.memo,
        urls: formData.urls.filter(u => u.trim() !== ''),
        subtasks: hasSubtasks ? subtasks : undefined
      });
    }
  };

  const addUrlScheme = (scheme) => {
    setFormData({...formData, urls: [...formData.urls, scheme]});
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b flex justify-between items-center bg-gray-50">
          <h2 className="text-xl font-black flex items-center gap-2 text-gray-800">
            {editingTask ? <Pencil size={24} className="text-blue-600" /> : <Plus size={24} className="text-blue-600" />}
            {editingTask ? 'タスクの編集' : '新規タスクの追加'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-800 bg-white hover:bg-gray-200 p-2 rounded-full transition-colors"><X size={20}/></button>
        </div>

        {!editingTask && (
          <div className="p-4 flex gap-2 border-b bg-gray-50 flex-wrap">
            <button
              type="button"
              className={`flex-1 min-w-[90px] py-2 text-xs font-bold rounded-xl border-2 transition-all ${newTaskType === 'simple' ? 'bg-blue-600 text-white border-blue-600 shadow-md' : 'bg-white text-gray-500 border-gray-200 hover:border-blue-300'}`}
              onClick={() => setNewTaskType('simple')}
            >
              シンプル
            </button>
            <button
              type="button"
              className={`flex-1 min-w-[90px] py-2 text-xs font-bold rounded-xl border-2 transition-all ${newTaskType === 'single_eval' ? 'bg-orange-500 text-white border-orange-500 shadow-md' : 'bg-white text-gray-500 border-gray-200 hover:border-orange-300'}`}
              onClick={() => setNewTaskType('single_eval')}
            >
              単評価(細分化)
            </button>
            <button
              type="button"
              className={`flex-1 min-w-[120px] py-2 text-xs font-bold rounded-xl border-2 transition-all ${newTaskType === 'project_subtask' ? 'bg-purple-600 text-white border-purple-600 shadow-md' : 'bg-white text-gray-500 border-gray-200 hover:border-purple-300'}`}
              onClick={() => setNewTaskType('project_subtask')}
            >
              イベント小タスク
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto flex-1 flex flex-col gap-5">
          {newTaskType === 'project_subtask' && !editingTask && (
            <div className="bg-purple-50 p-4 rounded-xl border border-purple-100">
              <label className="block text-sm font-bold text-purple-800 mb-2">関連付けるイベント・プロジェクト</label>
              <select
                required
                className="w-full border-2 border-purple-200 p-3 rounded-xl focus:border-purple-500 focus:outline-none transition-colors bg-white text-sm"
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
              >
                <option value="" disabled>プロジェクトを選択してください</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
              <p className="text-xs text-purple-600 mt-2 font-medium">※追加したタスクはプランナー側のイベント一覧にも連動して表示されます。</p>
            </div>
          )}

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">タイトル</label>
            <input required type="text" className="w-full border-2 border-gray-200 p-3 rounded-xl focus:border-blue-500 focus:outline-none transition-colors" value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} placeholder={newTaskType === 'project_subtask' ? "小タスク名を入力" : "タスク名を入力"} />
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">表示日 兼 期限日</label>
            <input required type="date" className="w-full border-2 border-gray-200 p-3 rounded-xl focus:border-blue-500 focus:outline-none transition-colors" value={formData.dueDate} onChange={e => setFormData({...formData, dueDate: e.target.value})} />
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">メモ</label>
            <textarea className="w-full border-2 border-gray-200 p-3 rounded-xl focus:border-blue-500 focus:outline-none transition-colors" rows="2" value={formData.memo} onChange={e => setFormData({...formData, memo: e.target.value})} placeholder="補足情報など" />
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2">関連URL</label>
            <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
              <button type="button" onClick={() => addUrlScheme('ms-excel:ofv|u|')} className="text-xs bg-green-50 text-green-700 px-2.5 py-1.5 rounded-lg border border-green-200 hover:bg-green-100 flex items-center gap-1 font-bold whitespace-nowrap shrink-0 transition-colors">
                <FileSpreadsheet size={14} /> Excelリンク
              </button>
              <button type="button" onClick={() => addUrlScheme('ms-powerpoint:ofv|u|')} className="text-xs bg-orange-50 text-orange-700 px-2.5 py-1.5 rounded-lg border border-orange-200 hover:bg-orange-100 flex items-center gap-1 font-bold whitespace-nowrap shrink-0 transition-colors">
                <MonitorPlay size={14} /> PPTリンク
              </button>
              <button type="button" onClick={() => addUrlScheme('ms-word:ofv|u|')} className="text-xs bg-blue-50 text-blue-700 px-2.5 py-1.5 rounded-lg border border-blue-200 hover:bg-blue-100 flex items-center gap-1 font-bold whitespace-nowrap shrink-0 transition-colors">
                <FileText size={14} /> Wordリンク
              </button>
            </div>
            {formData.urls.map((url, i) => (
              <div key={i} className="flex gap-2 mb-3">
                <div className="relative flex-1">
                  <LinkIcon size={16} className="absolute left-3 top-3 text-gray-400" />
                  <input
                    type="text"
                    placeholder="https://... または ms-powerpoint:ofv|u|..."
                    className="w-full border-2 border-gray-200 py-2.5 pl-9 pr-3 rounded-xl text-sm focus:border-blue-500 focus:outline-none transition-colors"
                    value={url}
                    onChange={e => {
                      const newUrls = [...formData.urls];
                      newUrls[i] = e.target.value;
                      setFormData({...formData, urls: newUrls});
                    }}
                  />
                </div>
                {url.trim() && (
                  <a
                    href={url.trim()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center text-blue-600 bg-blue-50 border-2 border-blue-200 hover:bg-blue-100 px-4 rounded-xl transition-colors font-bold text-sm shrink-0"
                  >
                    開く
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const newUrls = formData.urls.filter((_, idx) => idx !== i);
                    setFormData({...formData, urls: newUrls});
                  }}
                  className="text-red-500 bg-white border-2 border-red-100 hover:bg-red-50 p-2.5 rounded-xl transition-colors"
                >
                  <Trash2 size={18}/>
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setFormData({...formData, urls: [...formData.urls, '']})}
              className="w-full py-2.5 border-2 border-dashed border-gray-300 text-sm text-gray-600 font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-gray-50 hover:border-blue-300 transition-colors"
            >
              <Plus size={16}/> URLを追加
            </button>
          </div>

          {hasSubtasks && (
            <div className="border-2 border-orange-200 bg-orange-50/50 p-4 rounded-xl">
              <label className="block text-sm font-bold text-orange-800 mb-3">小スケジュール (納期付きサブタスク)</label>
              {subtasks.map((st, i) => (
                <div key={i} className="flex gap-2 mb-3">
                  <input type="text" required placeholder="サブタスク名" className="flex-1 border-2 border-orange-100 p-2 rounded-lg text-sm focus:border-orange-400 focus:outline-none" value={st.title} onChange={e => {
                    setSubtasks(subtasks.map((st, idx) => idx === i ? { ...st, title: e.target.value } : st));
                  }}/>
                  <input type="date" required className="border-2 border-orange-100 p-2 rounded-lg text-sm w-36 focus:border-orange-400 focus:outline-none" value={st.dueDate} onChange={e => {
                    setSubtasks(subtasks.map((st, idx) => idx === i ? { ...st, dueDate: e.target.value } : st));
                  }}/>
                  <button type="button" onClick={() => setSubtasks(subtasks.filter((_, idx) => idx !== i))} className="text-red-500 bg-white border border-red-100 hover:bg-red-50 p-2 rounded-lg"><Trash2 size={18}/></button>
                </div>
              ))}
              <button type="button" onClick={() => setSubtasks([...subtasks, { title: '', dueDate: formData.dueDate, completed: false }])} className="w-full py-2 border-2 border-dashed border-orange-300 text-sm text-orange-600 font-bold rounded-lg flex items-center justify-center gap-1 hover:bg-orange-100 transition-colors">
                <Plus size={16}/> サブタスクを追加
              </button>
            </div>
          )}

          <div className="mt-4 flex justify-between items-center pt-4 border-t">
            <div>
              {editingTask && (
                <button type="button" onClick={() => onDelete(editingTask.id)} className="px-4 py-3 text-red-600 bg-red-50 rounded-xl font-bold hover:bg-red-100 transition-colors flex items-center gap-2">
                  <Trash2 size={18} /> 削除
                </button>
              )}
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={onClose} className="px-5 py-3 text-gray-600 bg-gray-100 rounded-xl font-bold hover:bg-gray-200 transition-colors">キャンセル</button>
              <button type="submit" className="px-8 py-3 bg-blue-600 text-white rounded-xl font-bold shadow-lg hover:bg-blue-700 hover:shadow-xl transition-all transform hover:-translate-y-0.5">
                {editingTask ? '保存する' : '登録する'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

const RichTextEditor = ({ html, onChange }) => {
  const editorRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (editorRef.current && html !== undefined && editorRef.current.innerHTML === '') {
      editorRef.current.innerHTML = html;
    }
  }, [html]);

  const handleInput = () => {
    onChange(editorRef.current.innerHTML);
  };

  const insertLink = (defaultUrl = 'https://') => {
    const url = prompt('リンク先のURLを入力してください\n(※ファイルへのパスやアプリ起動リンクも可):', defaultUrl);
    if (!url) return;

    const editor = editorRef.current;
    editor.focus();

    const selection = window.getSelection();
    if (selection.isCollapsed) {
       document.execCommand('insertText', false, url);
       const range = selection.getRangeAt(0);
       range.setStart(range.startContainer, range.startOffset - url.length);
       selection.removeAllRanges();
       selection.addRange(range);
    }

    document.execCommand('createLink', false, url);

    const links = editor.querySelectorAll('a');
    links.forEach(link => {
      if (!link.hasAttribute('target')) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
        link.style.color = '#2563eb';
        link.style.textDecoration = 'underline';
        link.style.cursor = 'pointer';
      }
    });

    onChange(editor.innerHTML);
  };

  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      insertLink();
    }
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    let hasImage = false;
    for (let i = 0; i < items?.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        hasImage = true;
        const blob = items[i].getAsFile();
        const reader = new FileReader();
        reader.onload = (event) => {
          const imgHtml = `<img src="${event.target.result}" style="max-height: 300px; max-width: 100%; border-radius: 8px; margin: 8px 0; border: 1px solid #e5e7eb; display: block;" />`;
          document.execCommand('insertHTML', false, imgHtml);
          onChange(editorRef.current.innerHTML);
        };
        reader.readAsDataURL(blob);
      }
    }
    if (hasImage) e.preventDefault();
  };

  const insertImageFile = (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    const editor = editorRef.current;
    editor.focus();

    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    files.forEach(file => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const imgHtml = `<img src="${event.target.result}" style="max-height: 300px; max-width: 100%; border-radius: 8px; margin: 8px 0; border: 1px solid #e5e7eb; display: block;" />`;
          document.execCommand('insertHTML', false, imgHtml);
          onChange(editor.innerHTML);
        };
        reader.readAsDataURL(file);
      }
    });
    e.target.value = '';
  };

  const handleEditorClick = (e) => {
    const a = e.target.closest('a');
    if (a) {
      e.preventDefault();
      e.stopPropagation();
      window.open(a.href, a.target || '_blank');
    }
  };

  return (
    <div className="border-2 border-gray-200 rounded-xl overflow-hidden focus-within:border-blue-500 transition-colors bg-white flex flex-col">
      <div className="bg-gray-50 border-b border-gray-200 p-2 flex gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="text-gray-600 hover:text-blue-600 hover:bg-blue-50 px-2 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-bold"
          title="画像を挿入"
        >
          <ImageIcon size={16} /> 画像
        </button>
        <button
          type="button"
          onClick={() => insertLink()}
          className="text-gray-600 hover:text-blue-600 hover:bg-blue-50 px-2 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-bold"
          title="リンクを挿入 (Ctrl+K)"
        >
          <LinkIcon size={16} /> リンク
        </button>

        <div className="w-px h-6 bg-gray-300 mx-1"></div>

        <button
          type="button"
          onClick={() => insertLink('ms-excel:ofv|u|')}
          className="text-green-600 hover:text-green-700 hover:bg-green-50 px-2 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-bold"
          title="Excelリンクを挿入"
        >
          <FileSpreadsheet size={16} /> Excel
        </button>
        <button
          type="button"
          onClick={() => insertLink('ms-powerpoint:ofv|u|')}
          className="text-orange-600 hover:text-orange-700 hover:bg-orange-50 px-2 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-bold"
          title="PPTリンクを挿入"
        >
          <MonitorPlay size={16} /> PPT
        </button>
        <button
          type="button"
          onClick={() => insertLink('ms-word:ofv|u|')}
          className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 px-2 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-bold"
          title="Wordリンクを挿入"
        >
          <FileText size={16} /> Word
        </button>

        <input type="file" accept="image/*" multiple className="hidden" ref={fileInputRef} onChange={insertImageFile} />
      </div>
      <div
        ref={editorRef}
        contentEditable
        className="w-full p-4 min-h-[200px] max-h-[50vh] overflow-y-auto text-sm focus:outline-none"
        onInput={handleInput}
        onBlur={handleInput}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        onClick={handleEditorClick}
        data-placeholder="結論・成果を入力。文字と画像を自由に混ぜて記述でき、画像をペースト(Ctrl+V)することも可能です。テキストを選択してCtrl+Kでリンク挿入も可能。"
      />
    </div>
  );
};

const CompletionModal = ({ isOpen, task, onClose, onSave }) => {
  const [richHtml, setRichHtml] = useState('');
  const richHtmlRef = useRef('');
  const [urls, setUrls] = useState(['']);

  useEffect(() => {
    if (isOpen && task) {
      let initialHtml = task.richResult || '';
      if (!task.richResult && (task.completionNote || (task.resultImages && task.resultImages.length > 0))) {
        initialHtml = (task.completionNote || '').replace(/\n/g, '<br/>');
        if (task.resultImages) {
          task.resultImages.forEach(img => {
            initialHtml += `<img src="${img}" style="max-height: 300px; max-width: 100%; border-radius: 8px; margin: 8px 0; border: 1px solid #e5e7eb; display: block;" />`;
          });
        }
      }
      setRichHtml(initialHtml);
      richHtmlRef.current = initialHtml;
      setUrls(task.resultUrls && task.resultUrls.length > 0 ? task.resultUrls : ['']);
    } else {
      setRichHtml('');
      richHtmlRef.current = '';
    }
  }, [isOpen, task]);

  if (!isOpen || !task) return null;

  const handleRichHtmlChange = (nextHtml) => {
    richHtmlRef.current = nextHtml;
    setRichHtml(nextHtml);
  };

  const handleSaveAction = (isCompletedState) => {
    const filteredUrls = urls.filter(u => u.trim() !== '');
    onSave(task.id, richHtmlRef.current, filteredUrls, isCompletedState);
  };

  const addUrlScheme = (scheme) => {
    setUrls([...urls, scheme]);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b flex justify-between items-center bg-gray-50">
          <h2 className="text-xl font-black flex items-center gap-2 text-gray-800">
            <CheckSquare size={24} className={task.completed ? "text-green-600" : "text-blue-600"} />
            タスクの結論・成果の入力
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-800 bg-white hover:bg-gray-200 p-2 rounded-full transition-colors"><X size={20}/></button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 flex flex-col gap-6">
          <div className="bg-blue-50 border border-blue-100 p-3 rounded-xl">
            <p className="text-sm font-bold text-blue-800">{task.title}</p>
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2">結論・成果ノート (未記入でもOK)</label>
            <RichTextEditor html={richHtml} onChange={handleRichHtmlChange} />
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2">成果物 URL</label>
            <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
              <button type="button" onClick={() => addUrlScheme('ms-excel:ofv|u|')} className="text-xs bg-green-50 text-green-700 px-2.5 py-1.5 rounded-lg border border-green-200 hover:bg-green-100 flex items-center gap-1 font-bold whitespace-nowrap shrink-0 transition-colors">
                <FileSpreadsheet size={14} /> Excelリンク
              </button>
              <button type="button" onClick={() => addUrlScheme('ms-powerpoint:ofv|u|')} className="text-xs bg-orange-50 text-orange-700 px-2.5 py-1.5 rounded-lg border border-orange-200 hover:bg-orange-100 flex items-center gap-1 font-bold whitespace-nowrap shrink-0 transition-colors">
                <MonitorPlay size={14} /> PPTリンク
              </button>
              <button type="button" onClick={() => addUrlScheme('ms-word:ofv|u|')} className="text-xs bg-blue-50 text-blue-700 px-2.5 py-1.5 rounded-lg border border-blue-200 hover:bg-blue-100 flex items-center gap-1 font-bold whitespace-nowrap shrink-0 transition-colors">
                <FileText size={14} /> Wordリンク
              </button>
            </div>
            {urls.map((url, i) => (
              <div key={i} className="flex gap-2 mb-3">
                <div className="relative flex-1">
                  <LinkIcon size={16} className="absolute left-3 top-3 text-gray-400" />
                  <input
                    type="text"
                    placeholder="https://... または ms-excel:ofv|u|..."
                    className="w-full border-2 border-gray-200 py-2.5 pl-9 pr-3 rounded-xl text-sm focus:border-blue-500 focus:outline-none transition-colors"
                    value={url}
                    onChange={e => {
                      const newUrls = [...urls];
                      newUrls[i] = e.target.value;
                      setUrls(newUrls);
                    }}
                  />
                </div>
                {url.trim() && (
                  <a
                    href={url.trim()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center text-blue-600 bg-blue-50 border-2 border-blue-200 hover:bg-blue-100 px-4 rounded-xl transition-colors font-bold text-sm shrink-0"
                  >
                    開く
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setUrls(urls.filter((_, idx) => idx !== i))}
                  className="text-red-500 bg-white border-2 border-red-100 hover:bg-red-50 p-2.5 rounded-xl transition-colors"
                >
                  <Trash2 size={18}/>
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setUrls([...urls, ''])}
              className="w-full py-2.5 border-2 border-dashed border-gray-300 text-sm text-gray-600 font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-gray-50 hover:border-blue-300 transition-colors"
            >
              <Plus size={16}/> URLを追加
            </button>
          </div>

          <div className="flex flex-wrap justify-between items-center mt-2 pt-4 border-t gap-4">
            <button type="button" onClick={onClose} className="px-5 py-3 text-gray-600 bg-gray-100 rounded-xl font-bold hover:bg-gray-200 transition-colors">
              キャンセル
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleSaveAction(task.completed)}
                className="px-5 py-3 text-blue-600 border-2 border-blue-600 rounded-xl font-bold hover:bg-blue-50 transition-colors"
              >
                保存のみ
              </button>
              <button
                type="button"
                onClick={() => handleSaveAction(!task.completed)}
                className={`px-6 py-3 text-white rounded-xl font-bold shadow-md transition-all ${task.completed ? 'bg-orange-500 hover:bg-orange-600' : 'bg-green-600 hover:bg-green-700'}`}
              >
                {task.completed ? 'タスク完了を取り消す' : 'タスク完了'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const RecurringScheduleModal = ({ isOpen, onClose, onSave, onDelete, editingSchedule }) => {
  const [formData, setFormData] = useState({
    title: '',
    frequency: 'weekly',
    interval: 1,
    dayOfWeek: getLocalDate(TODAY_STR).getDay(),
    dayOfMonth: getLocalDate(TODAY_STR).getDate(),
    startDate: TODAY_STR,
    endDate: '',
    memo: '',
    urls: ['']
  });

  useEffect(() => {
    if (isOpen) {
      if (editingSchedule) {
        setFormData({
          title: editingSchedule.title || '',
          frequency: editingSchedule.frequency || 'weekly',
          interval: editingSchedule.interval || 1,
          dayOfWeek: editingSchedule.dayOfWeek !== undefined ? editingSchedule.dayOfWeek : getLocalDate(editingSchedule.startDate || TODAY_STR).getDay(),
          dayOfMonth: editingSchedule.dayOfMonth || getLocalDate(editingSchedule.startDate || TODAY_STR).getDate(),
          startDate: editingSchedule.startDate || TODAY_STR,
          endDate: editingSchedule.endDate || '',
          memo: editingSchedule.memo || '',
          urls: editingSchedule.urls && editingSchedule.urls.length > 0 ? editingSchedule.urls : ['']
        });
      } else {
        setFormData({ title: '', frequency: 'weekly', interval: 1, dayOfWeek: getLocalDate(TODAY_STR).getDay(), dayOfMonth: getLocalDate(TODAY_STR).getDate(), startDate: TODAY_STR, endDate: '', memo: '', urls: [''] });
      }
    }
  }, [isOpen, editingSchedule]);

  if (!isOpen) return null;

  const addUrlScheme = (scheme) => {
    setFormData({ ...formData, urls: [...formData.urls, scheme] });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (formData.endDate && formData.endDate < formData.startDate) {
      alert('終了時期は開始時期以降の日付を指定してください。');
      return;
    }
    onSave({
      id: editingSchedule?.id,
      title: formData.title,
      frequency: formData.frequency,
      interval: Math.max(1, Number(formData.interval) || 1),
      dayOfWeek: Number(formData.dayOfWeek),
      dayOfMonth: Math.min(31, Math.max(1, Number(formData.dayOfMonth) || 1)),
      startDate: formData.startDate,
      endDate: formData.endDate,
      memo: formData.memo,
      urls: formData.urls.filter(u => u.trim() !== '')
    });
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b flex justify-between items-center bg-green-50">
          <h2 className="text-xl font-black flex items-center gap-2 text-gray-800">
            <Repeat size={24} className="text-green-600" />
            {editingSchedule ? '定期スケジュールの編集' : '新規定期スケジュール'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-800 bg-white hover:bg-gray-200 p-2 rounded-full transition-colors"><X size={20}/></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto flex-1 flex flex-col gap-5">
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">タイトル</label>
            <input required type="text" className="w-full border-2 border-gray-200 p-3 rounded-xl focus:border-green-500 focus:outline-none transition-colors" value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} placeholder="例: 週次定例、月次レポート作成" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-1">繰り返し単位</label>
              <select required className="w-full border-2 border-gray-200 p-3 rounded-xl focus:border-green-500 focus:outline-none bg-white" value={formData.frequency} onChange={e => setFormData({...formData, frequency: e.target.value})}>
                <option value="daily">日ごと</option>
                <option value="weekly">週ごと</option>
                <option value="monthly">月ごと</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-1">間隔</label>
              <input required type="number" min="1" max="99" className="w-full border-2 border-gray-200 p-3 rounded-xl focus:border-green-500 focus:outline-none" value={formData.interval} onChange={e => setFormData({...formData, interval: e.target.value})} />
            </div>
          </div>

          {formData.frequency === 'weekly' && (
            <div className="bg-green-50 border border-green-100 p-4 rounded-xl">
              <label className="block text-sm font-bold text-green-800 mb-2">繰り返す曜日</label>
              <select
                required
                className="w-full border-2 border-green-200 p-3 rounded-xl focus:border-green-500 focus:outline-none bg-white"
                value={formData.dayOfWeek}
                onChange={e => setFormData({...formData, dayOfWeek: Number(e.target.value)})}
              >
                {WEEKDAY_OPTIONS.map(day => (
                  <option key={day.value} value={day.value}>{day.label}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-green-700 font-medium">開始時期以降の指定曜日に予定を自動生成します。</p>
            </div>
          )}

          {formData.frequency === 'monthly' && (
            <div className="bg-green-50 border border-green-100 p-4 rounded-xl">
              <label className="block text-sm font-bold text-green-800 mb-2">繰り返す日付</label>
              <div className="flex items-center gap-2">
                <input
                  required
                  type="number"
                  min="1"
                  max="31"
                  className="w-28 border-2 border-green-200 p-3 rounded-xl focus:border-green-500 focus:outline-none bg-white"
                  value={formData.dayOfMonth}
                  onChange={e => setFormData({...formData, dayOfMonth: e.target.value})}
                />
                <span className="text-sm font-bold text-green-800">日</span>
              </div>
              <p className="mt-2 text-xs text-green-700 font-medium">月末より大きい日付は、その月の最終日に調整して表示します。</p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-green-50 border border-green-100 p-4 rounded-xl">
            <div>
              <label className="block text-sm font-bold text-green-800 mb-1">開始時期 <span className="text-red-500">必須</span></label>
              <input required type="date" className="w-full border-2 border-green-200 p-3 rounded-xl focus:border-green-500 focus:outline-none bg-white" value={formData.startDate} onChange={e => setFormData({...formData, startDate: e.target.value})} />
            </div>
            <div>
              <label className="block text-sm font-bold text-green-800 mb-1">終了時期 <span className="text-gray-400">任意</span></label>
              <input type="date" min={formData.startDate} className="w-full border-2 border-green-200 p-3 rounded-xl focus:border-green-500 focus:outline-none bg-white" value={formData.endDate} onChange={e => setFormData({...formData, endDate: e.target.value})} />
            </div>
            <p className="sm:col-span-2 text-xs text-green-700 font-medium">終了時期を空欄にすると、表示対象期間内で継続して予定を自動生成します。</p>
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">メモ</label>
            <textarea className="w-full border-2 border-gray-200 p-3 rounded-xl focus:border-green-500 focus:outline-none transition-colors" rows="2" value={formData.memo} onChange={e => setFormData({...formData, memo: e.target.value})} placeholder="補足情報など" />
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2">関連URL</label>
            <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
              <button type="button" onClick={() => addUrlScheme('ms-excel:ofv|u|')} className="text-xs bg-green-50 text-green-700 px-2.5 py-1.5 rounded-lg border border-green-200 hover:bg-green-100 flex items-center gap-1 font-bold whitespace-nowrap shrink-0 transition-colors">
                <FileSpreadsheet size={14} /> Excelリンク
              </button>
              <button type="button" onClick={() => addUrlScheme('ms-powerpoint:ofv|u|')} className="text-xs bg-orange-50 text-orange-700 px-2.5 py-1.5 rounded-lg border border-orange-200 hover:bg-orange-100 flex items-center gap-1 font-bold whitespace-nowrap shrink-0 transition-colors">
                <MonitorPlay size={14} /> PPTリンク
              </button>
              <button type="button" onClick={() => addUrlScheme('ms-word:ofv|u|')} className="text-xs bg-blue-50 text-blue-700 px-2.5 py-1.5 rounded-lg border border-blue-200 hover:bg-blue-100 flex items-center gap-1 font-bold whitespace-nowrap shrink-0 transition-colors">
                <FileText size={14} /> Wordリンク
              </button>
            </div>
            {formData.urls.map((url, i) => (
              <div key={i} className="flex gap-2 mb-3">
                <input type="text" className="flex-1 border-2 border-gray-200 p-2.5 rounded-xl text-sm focus:border-green-500 focus:outline-none" value={url} onChange={e => {
                  const newUrls = [...formData.urls];
                  newUrls[i] = e.target.value;
                  setFormData({...formData, urls: newUrls});
                }} placeholder="https://..." />
                <button type="button" onClick={() => setFormData({...formData, urls: formData.urls.filter((_, idx) => idx !== i)})} className="text-red-500 bg-white border-2 border-red-100 hover:bg-red-50 p-2.5 rounded-xl transition-colors"><Trash2 size={18}/></button>
              </div>
            ))}
            <button type="button" onClick={() => setFormData({...formData, urls: [...formData.urls, '']})} className="w-full py-2.5 border-2 border-dashed border-gray-300 text-sm text-gray-600 font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-gray-50 hover:border-green-300 transition-colors">
              <Plus size={16}/> URLを追加
            </button>
          </div>

          <div className="mt-4 flex justify-between items-center pt-4 border-t">
            <div>
              {editingSchedule && (
                <button type="button" onClick={() => onDelete(editingSchedule.id)} className="px-4 py-3 text-red-600 bg-red-50 rounded-xl font-bold hover:bg-red-100 transition-colors flex items-center gap-2">
                  <Trash2 size={18} /> 削除
                </button>
              )}
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={onClose} className="px-5 py-3 text-gray-600 bg-gray-100 rounded-xl font-bold hover:bg-gray-200 transition-colors">キャンセル</button>
              <button type="submit" className="px-8 py-3 bg-green-600 text-white rounded-xl font-bold shadow-lg hover:bg-green-700 hover:shadow-xl transition-all transform hover:-translate-y-0.5">
                {editingSchedule ? '保存する' : '作成する'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

const ProjectModal = ({ isOpen, onClose, onSave }) => {
  const [formData, setFormData] = useState({ title: '', type: 'project', durationWeeks: 4 });

  useEffect(() => {
    if (isOpen) {
      setFormData({ title: '', type: 'project', durationWeeks: 4 });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col">
        <div className="p-4 border-b flex justify-between items-center bg-gray-50">
          <h2 className="text-xl font-black flex items-center gap-2 text-gray-800">
            <Plus size={24} className="text-purple-600" />
            新規イベント・プロジェクト作成
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-800 bg-white hover:bg-gray-200 p-2 rounded-full transition-colors"><X size={20}/></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 flex flex-col gap-5">
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">タイトル</label>
            <input required type="text" className="w-full border-2 border-gray-200 p-3 rounded-xl focus:border-purple-500 focus:outline-none" value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} placeholder="プロジェクト名またはイベント名を入力" />
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2">種別</label>
            <div className="flex gap-3">
              <label className="flex-1 cursor-pointer">
                <input type="radio" className="peer sr-only" name="ptype" checked={formData.type === 'project'} onChange={() => setFormData({...formData, type: 'project'})} />
                <div className="border-2 border-gray-200 rounded-xl p-3 text-center font-bold text-gray-500 peer-checked:border-purple-500 peer-checked:bg-purple-50 peer-checked:text-purple-700 transition-all shadow-sm">プロジェクト</div>
              </label>
              <label className="flex-1 cursor-pointer">
                <input type="radio" className="peer sr-only" name="ptype" checked={formData.type === 'evaluation'} onChange={() => setFormData({...formData, type: 'evaluation'})} />
                <div className="border-2 border-gray-200 rounded-xl p-3 text-center font-bold text-gray-500 peer-checked:border-orange-500 peer-checked:bg-orange-50 peer-checked:text-orange-700 transition-all shadow-sm">評価イベント</div>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">想定期間 (週)</label>
            <input required type="number" min="1" max="52" className="w-full border-2 border-gray-200 p-3 rounded-xl focus:border-purple-500 focus:outline-none" value={formData.durationWeeks} onChange={e => setFormData({...formData, durationWeeks: Number(e.target.value)})} />
          </div>

          <div className="mt-4 flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={onClose} className="px-5 py-3 text-gray-600 bg-gray-100 rounded-xl font-bold hover:bg-gray-200 transition-colors">キャンセル</button>
            <button type="submit" className="px-8 py-3 bg-purple-600 text-white rounded-xl font-bold shadow-lg hover:bg-purple-700 hover:shadow-xl transition-all transform hover:-translate-y-0.5">作成する</button>
          </div>
        </form>
      </div>
    </div>
  );
};

// Progress uses the same tasks/subtasks as the calendar and board.
// Availability is independent of deadline colors: overdue work can still be
// actionable, while an overdue waiting item still cannot unblock its parent.
const progressItemAvailability = (item, task) => {
  if (item.completed) return 'completed';
  const context = task || (Array.isArray(item.subtasks) ? item : undefined);
  if (isProgressBlocked(context, item)) return 'blocked';
  const children = Array.isArray(item.subtasks) ? getProgressSubtasks(item) : getProgressSmallTasks(item);
  const pending = children.filter(child => !child.completed);
  const states = pending.map(child => progressItemAvailability(child, context));
  if (states.includes('active')) return 'active';
  if (item.waiting || states.includes('waiting')) return 'waiting';
  return pending.length ? 'blocked' : 'active';
};
const progressItemStatus = (item, task) => {
  const available = progressItemAvailability(item, task);
  if (available === 'completed' || available === 'blocked') return available;
  if (item.dueDate && item.dueDate < formatDate(new Date())) return 'overdue';
  return available;
};
const progressStatusTone = status => ({ blocked: 'yellow', completed: 'blue', overdue: 'red', waiting: 'green', active: 'purple' })[status];
const progressCompletionBlocked = (task, item) => !item.completed && (item.waiting
  || isProgressBlocked(task, item) || getProgressSmallTasks(item).some(small => !small.completed));
const canCompleteProgressTask = task => !task.completed && !progressCompletionBlocked(task, task)
  && getProgressSubtasks(task).every(st => st.completed);
const progressStatusLabel = (status) => ({ blocked: 'タスク待ち', completed: '完了', overdue: '期限超過', waiting: '相手待ち', active: '進行可能' }[status]);
const progressStatusClasses = (status) => ({
  blocked: 'bg-yellow-50 border-black text-yellow-900',
  completed: 'bg-blue-50 border-black text-blue-900',
  overdue: 'bg-red-50 border-black text-red-800',
  waiting: 'bg-green-50 border-black text-green-800',
  active: 'bg-purple-50 border-black text-purple-900'
}[status]);

const ProgressSettingsModal = ({ task, starting, onClose, onSave }) => {
  const [title, setTitle] = useState(task.title || '');
  const [dueDate, setDueDate] = useState(task.dueDate || '');
  const [subtasks, setSubtasks] = useState(() => getProgressSubtasks(task).map(st => ({ ...st })));
  const [newTitle, setNewTitle] = useState('');
  const [newDueDate, setNewDueDate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const formRef = useRef(null);
  const inputRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current?.focus();
    const handleKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Tab' && formRef.current) {
        const elements = [...formRef.current.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled])')];
        const first = elements[0]; const last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); previous?.focus(); };
  }, [onClose]);
  const addSubtask = () => {
    if (!newTitle.trim()) return;
    setSubtasks(prev => [...prev, { id: createProgressId(), title: newTitle.trim(), dueDate: newDueDate || dueDate || task.dueDate || '', completed: false, waiting: false, order: Date.now() }]);
    setNewTitle(''); setNewDueDate(''); setError(''); inputRef.current?.focus();
  };
  const confirm = (e) => {
    e.preventDefault();
    if (!title.trim()) { setError('タスク名を入力してください。'); return; }
    if (subtasks.some(st => !st.title.trim())) { setError('やるべきことの名前を入力してください。'); return; }
    if (subtasks.some(st => st.completed && !getProgressSubtasks(task).find(old => old.id === st.id)?.completed && progressCompletionBlocked({ ...task, subtasks }, { ...st, completed: false }))) { setError('相手待ち、未完了の小さいタスク、または完了待ちの関連先が残っています。'); return; }
    const additions = newTitle.trim() ? [{ id: createProgressId(), title: newTitle.trim(), dueDate: newDueDate || dueDate || task.dueDate || '', completed: false, waiting: false, order: Date.now() }] : [];
    onSave({ title: title.trim(), dueDate, subtasks: [...subtasks.map(st => ({ ...st, title: st.title.trim(), dueDate: st.dueDate || dueDate })), ...additions], ...(starting ? { progressStage: 'doing' } : {}) }, reason.trim());
  };
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <form ref={formRef} role="dialog" aria-modal="true" aria-label="進捗の設定" onSubmit={confirm} onKeyDown={e => {
        if (e.key === 'Enter' && e.ctrlKey && !e.nativeEvent.isComposing) { e.preventDefault(); formRef.current?.requestSubmit(); }
        else if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.target.tagName === 'INPUT') e.preventDefault();
      }} className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <header className="p-5 border-b flex justify-between items-start gap-3">
          <div><h2 className="text-lg font-black text-gray-900">{starting ? '着手前にやるべきことを設定' : '進捗の設定'}</h2><p className="text-sm text-gray-500 mt-1 break-words">{task.title}</p></div>
          <button type="button" onClick={onClose} aria-label="進捗の設定を閉じる" className="p-2 rounded-lg hover:bg-gray-100"><X size={20}/></button>
        </header>
        <div className="overflow-y-auto p-5 space-y-5">
          <label className="block text-sm font-bold">タスク名<input type="text" required value={title} onChange={e => setTitle(e.target.value)} className="block w-full mt-2 border rounded-lg px-3 py-2 font-normal"/></label>
          <label className="block text-sm font-bold">タスクの期限<input type="date" required value={dueDate} onChange={e => setDueDate(e.target.value)} className="block mt-2 border rounded-lg px-3 py-2 bg-white"/></label>
          <div>
            <h3 className="text-sm font-bold mb-2">やるべきこと（小タスク）</h3>
            <p className="text-xs text-gray-500 mb-3">変更はカレンダーなど、すべてのページに反映されます。</p>
            <div className="space-y-2">
              {subtasks.map((st, i) => <div key={st.id} className="flex flex-wrap gap-2 items-center border rounded-xl p-3 bg-gray-50">
                <input aria-label={`やるべきこと ${i + 1}`} required value={st.title} onChange={e => setSubtasks(prev => prev.map(item => item.id === st.id ? { ...item, title: e.target.value } : item))} className="min-w-0 flex-1 border rounded-lg px-3 py-2 text-sm"/>
                <input aria-label={`やるべきこと ${i + 1} の期限`} type="date" value={st.dueDate || ''} onChange={e => setSubtasks(prev => prev.map(item => item.id === st.id ? { ...item, dueDate: e.target.value } : item))} className="border rounded-lg px-2 py-2 text-sm"/>
                <button type="button" aria-label={`やるべきこと ${i + 1} を削除`} onClick={() => setSubtasks(prev => prev.filter(item => item.id !== st.id))} className="p-2 text-red-500 hover:bg-red-100 rounded-lg"><Trash2 size={16}/></button>
                <div className="w-full text-xs flex gap-4 text-gray-600">
                  <label className="flex items-center gap-1"><input type="checkbox" checked={!!st.waiting} onChange={e => setSubtasks(prev => prev.map(item => item.id === st.id ? { ...item, waiting: e.target.checked, ...(e.target.checked ? { completed: false } : {}) } : item))}/>相手待ち</label>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={!!st.completed} disabled={!st.completed && progressCompletionBlocked({ ...task, subtasks }, st)} onChange={e => setSubtasks(prev => prev.map(item => item.id === st.id ? { ...item, completed: e.target.checked, ...(e.target.checked ? { waiting: false } : {}) } : item))}/>完了</label>
                </div>
              </div>)}
            </div>
            {!subtasks.length && <p className="text-sm text-gray-400 py-3">やるべきことはまだありません。</p>}
            <div className="mt-3 p-3 rounded-xl bg-blue-50 border border-blue-100 flex flex-wrap gap-2">
              <input ref={inputRef} aria-label="新しいやるべきこと" placeholder="やるべきことを入力 → Enter で追加" value={newTitle} onChange={e => setNewTitle(e.target.value)} onKeyDown={e => {
                if (e.key === 'Enter' && !e.ctrlKey && !e.nativeEvent.isComposing) { e.preventDefault(); addSubtask(); }
              }} className="flex-1 min-w-[180px] border rounded-lg px-3 py-2 text-sm"/>
              <input type="date" aria-label="新しいやるべきことの期限" value={newDueDate} onChange={e => setNewDueDate(e.target.value)} className="border rounded-lg px-2 py-2 text-sm"/>
              <button type="button" onClick={addSubtask} disabled={!newTitle.trim()} className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold disabled:opacity-40">追加</button>
              <p className="w-full text-xs text-blue-700">期限の未入力時: {dueDate || 'タスクの期限なし'}</p>
            </div>
          </div>
          <label className="block text-sm font-bold">変更理由<textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="期限などを変更した理由（任意）" rows={2} className="block w-full mt-2 border rounded-lg px-3 py-2 text-sm font-normal"/></label>
          <p className="text-xs text-gray-500">期限の変更は、変更理由を入力した場合だけ履歴へ残ります。Enter で追加、Ctrl+Enter で確定。</p>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        </div>
        <footer className="p-4 border-t bg-gray-50 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-bold rounded-lg border bg-white">キャンセル</button>
          <button type="submit" className="px-5 py-2 text-sm font-bold rounded-lg bg-blue-600 text-white">確定</button>
        </footer>
      </form>
    </div>
  );
};

const ProgressDependencyModal = ({ task, target, onClose, onSave }) => {
  const item = getProgressDependencyNode(task, target);
  const [selected, setSelected] = useState(item?.dependencies || []);
  const [error, setError] = useState('');
  const focusRef = useRef(null);
  useEffect(() => { focusRef.current?.focus(); }, []);
  const options = progressDependencyOptions(task, target).filter(ref => ref.kind !== 'waiting'
    || selected.some(item => progressDependencyKey(item) === progressDependencyKey(ref))
    || (getProgressDependencyNode(task, ref)?.waiting && !progressDependencyDone(task, ref)));
  const optionKeys = new Set(options.map(progressDependencyKey));
  const missing = (item?.dependencies || []).filter(ref => !optionKeys.has(progressDependencyKey(ref)));
  const toggle = (ref, checked) => {
    setError(''); setSelected(prev => checked ? [...prev, ref] : prev.filter(item => progressDependencyKey(item) !== progressDependencyKey(ref)));
  };
  return <div className="fixed inset-0 bg-black/40 z-[80] flex items-center justify-center p-4" onClick={e => e.stopPropagation()}>
    <form role="dialog" aria-modal="true" aria-label="タスク待ちの設定" className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }} onSubmit={e => {
        e.preventDefault(); const issue = progressDependencyError(task, target, selected);
        if (issue) { setError(issue); return; } onSave(selected);
      }}>
      <header className="flex items-start justify-between gap-3 p-4 border-b"><div><h3 className="font-bold">タスク待ちの設定</h3><p className="text-sm mt-1 break-words">{item?.title}</p></div><button type="button" aria-label="タスク待ちの設定を閉じる" onClick={onClose}><X size={20}/></button></header>
      <div className="p-4 space-y-3 overflow-y-auto">
        <p className="text-sm text-gray-600">タスクの完了、または相手待ちの解除を待つ項目を選択します。すべての条件を満たすと、自動で進行可能になります。</p>
        <p className="text-xs text-gray-500">{target.kind === 'small' ? '完了待ちは同じやるべきことの小さいタスク、または別のやるべきことを選べます。' : '完了待ちは同じ案件の別のやるべきことを選べます。'} 相手待ちは、同じ案件内から選べます。</p>
        {[{ waiting: false, title: 'タスクの完了待ち' }, { waiting: true, title: '相手待ちの解除待ち' }].map(group => {
          const choices = [...options, ...missing].filter(ref => (ref.kind === 'waiting') === group.waiting);
          return choices.length > 0 && <fieldset key={group.title} className="space-y-2"><legend className="text-xs font-bold text-gray-600 mb-2">{group.title}</legend>{choices.map(ref => {
            const key = progressDependencyKey(ref), node = getProgressDependencyNode(task, ref);
            const kind = ref.kind === 'waiting' ? ref.scopeKind : ref.kind;
            const kindLabel = ({ task: 'タスク全体', subtask: 'やるべきこと', small: '小さいタスク' })[kind];
            const parent = kind === 'small' ? getProgressSubtasks(task).find(st => st.id === ref.parentId) : null;
            const waitingEntry = group.waiting ? progressWaitingDependencyEntry(task, ref) : null;
            return <div key={key} data-dependency-option={key} className="rounded-lg border p-2 text-sm">
              <label className="flex gap-2 items-start"><input type="checkbox" aria-label={`${group.waiting ? '解除を待つ: 相手待ち' : `完了を待つ: ${kindLabel}`} ${node?.title || ref.title}`} checked={selected.some(item => progressDependencyKey(item) === key)} onChange={e => toggle(ref, e.target.checked)}/>
              <span className="min-w-0 break-words">{node?.title || ref.title}<span className="block text-xs text-gray-500">{kindLabel}{parent ? ` / ${parent.title}` : ''} · {progressDependencyDone(task, ref) ? group.waiting ? '解除済み' : '完了' : node ? group.waiting ? '相手待ち' : '未完了' : '削除された関連先'}</span></span></label>
              {group.waiting && <div aria-label="相手待ちの内容" className="mt-2 ml-5 rounded-lg bg-green-50 p-2 text-green-900">
                {waitingEntry ? <div className="whitespace-pre-wrap break-words"><ProgressText value={waitingEntry.text || '本文はありません。'} textLinks={waitingEntry.textLinks} textFormats={waitingEntry.textFormats}/></div>
                  : <p className="text-xs text-gray-500">相手待ちの内容はまだ記録されていません。</p>}
              </div>}
            </div>;
          })}</fieldset>;
        })}
        {!options.length && !missing.length && <p className="text-sm text-gray-500">関連付けできる項目がありません。</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      </div>
      <footer className="border-t p-4 flex justify-end gap-2"><button ref={focusRef} type="button" className="rounded-lg border px-4 py-2 text-sm" onClick={onClose}>キャンセル</button><button type="submit" className="rounded-lg bg-purple-600 text-white px-4 py-2 text-sm font-bold">タスク待ちを保存</button></footer>
    </form>
  </div>;
};

// Waiting is a status on an existing item, never a separate board card.
const getProgressWaitingItems = task => {
  if (task.completed) return [];
  const history = (task.progressHistory || []).filter(entry => entry.kind === 'comment'
    && entry.status === 'waiting' && !progressEntryIsNote(entry) && !entry.resolvedByReplyId);
  const items = [];
  const append = (scope, item) => {
    const entries = history.filter(entry => progressWaitingScope(task, entry) === scope);
    if (entries.length) entries.forEach(entry => items.push({ ...item, key: `${item.key}:${entry.id}`, entry }));
    else items.push(item);
  };
  if (task.waiting) append('task', { key: `task:${task.id}`, title: task.title, path: 'タスク全体' });
  getProgressSubtasks(task).forEach(st => {
    if (st.completed) return;
    if (st.waiting) append(`subtask:${st.id}`, { key: `subtask:${st.id}`, subtaskId: st.id, title: st.title, path: 'やるべきこと' });
    getProgressSmallTasks(st).forEach(small => {
      if (!small.waiting || small.completed || getCompletedProgressSmallIds(task).has(small.id)) return;
      append(`small:${small.id}`, { key: `small:${st.id}:${small.id}`, subtaskId: st.id, smallTaskId: small.id, title: small.title, path: `小さいタスク / ${st.title}` });
    });
  });
  return items;
};
const scopeProgressWaitingItems = (items, scope) => items.filter(item => scope?.kind === 'small'
  ? item.subtaskId === scope.parentId && item.smallTaskId === scope.id
  : scope?.kind === 'subtask' ? item.subtaskId === scope.id : true);

const ProgressWaitingModal = ({ task, scope, onClose }) => {
  const items = scopeProgressWaitingItems(getProgressWaitingItems(task), scope);
  const title = scope ? getProgressDependencyNode(task, scope)?.title : task.title;
  const modalRef = useRef(null), closeRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const handleKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Tab') {
        const elements = [...(modalRef.current?.querySelectorAll('button:not([disabled]),a[href]') || [])].filter(element => element.getClientRects().length);
        const first = elements[0], last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); previous?.focus(); };
  }, []);
  return <div className="fixed inset-0 bg-black/40 z-[80] flex items-center justify-center p-4" onClick={e => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}>
    <section ref={modalRef} role="dialog" aria-modal="true" aria-label="相手待ちステータス一覧" className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
      <header className="p-4 border-b flex items-start justify-between gap-3"><div><h3 className="font-bold">相手待ちステータス一覧 <span className="text-green-700">{items.length}件</span></h3><p className="mt-1 text-sm break-words">{title}</p></div><button ref={closeRef} type="button" aria-label="相手待ち一覧を閉じる" onClick={onClose} className="p-1 rounded hover:bg-gray-100"><X size={20}/></button></header>
      <div className="p-4 overflow-y-auto space-y-3">
        {!items.length && <p className="text-sm text-gray-500">現在、相手待ちの項目はありません。</p>}
        {items.map(item => <article key={item.key} data-waiting-status-key={item.key} className="rounded-xl border border-green-300 bg-green-50 p-3 text-green-900">
          <p className="text-xs">{item.path} · 相手待ち</p><h4 className="font-bold mt-1 break-words">{item.title}</h4>
          {item.entry ? <div className="mt-2 space-y-1"><p className="text-xs text-gray-500">直近の相手待ちトーク{(item.entry.editedAt || item.entry.createdAt) && <> · <time dateTime={item.entry.editedAt || item.entry.createdAt}>{new Date(item.entry.editedAt || item.entry.createdAt).toLocaleString('ja-JP')}</time></>}</p><div className="text-sm whitespace-pre-wrap break-words"><ProgressText value={item.entry.text} textLinks={item.entry.textLinks} textFormats={item.entry.textFormats}/></div><ProgressAttachments images={item.entry.images} links={item.entry.links}/></div>
            : <p className="mt-2 text-sm">相手待ちの内容はまだ記録されていません。</p>}
        </article>)}
      </div>
      <footer className="border-t p-4 flex justify-end"><button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm">閉じる</button></footer>
    </section>
  </div>;
};

const ProgressTaskCard = ({ task, selected, onSelect, onSettings, onStart, onDragStart, onDeleteSmallTask, onFilter, onOtherTalks, onCompleteSubtask, onCompleteTask, onReopenTask, onDependency, onWaiting, onReorderSubtask, onReorderSmallTask, tableView = false }) => {
  const [dropHint, setDropHint] = useState(null);
  const todoDragType = 'application/x-taskmatrix-progress-todo';
  const status = progressItemStatus(task);
  const waitingItems = getProgressWaitingItems(task);
  return <article data-progress-task-id={task.id} data-status={status} draggable onDragStart={e => onDragStart(e, task.id)} onClick={onSelect} className={`border rounded-xl p-3 shadow-sm ${progressStatusClasses(status)} ${selected ? 'ring-2 ring-purple-500' : ''}`}>
    <div className="flex gap-2 justify-between items-start">
      <button type="button" onClick={e => { e.stopPropagation(); onSelect(); }} className="font-bold text-sm text-left break-words flex-1">{task.title}</button>
      <button type="button" aria-label={`${task.title}の設定`} onClick={e => { e.stopPropagation(); onSettings(); }} className="p-1.5 rounded-lg hover:bg-white/70 shrink-0"><Settings size={16}/></button>
    </div>
    <div className="mt-2 mb-3 flex flex-wrap gap-2 text-xs items-center"><span className="font-bold px-2 py-0.5 rounded bg-white/70">{progressStatusLabel(status)}</span><span>タスク期日: {task.dueDate || '未設定'}</span><button type="button" aria-label={`${task.title}の相手待ち一覧`} onClick={e => { e.stopPropagation(); onWaiting(); }} className="rounded-lg border border-black bg-white/80 px-2 py-1 text-green-800">相手待ち一覧（{waitingItems.length}）</button></div>
    {task.completed && <p className="mb-3 text-xs">完了日時: {Number.isFinite(reportEntryDate(task.completedAt).getTime()) ? reportEntryDate(task.completedAt).toLocaleString('ja-JP') : '未記録'}</p>}
    <ul className="space-y-1.5">
      {getProgressSubtasks(task).length > 0 && <li data-progress-other-talks={task.id} className="rounded-lg border border-black bg-white/80 text-xs overflow-hidden">
        <button type="button" aria-label="その他のトークを表示" onClick={e => { e.stopPropagation(); onOtherTalks(); }} className="flex w-full items-center gap-1.5 px-2 py-3 text-left hover:bg-slate-50">
          <MessageSquare size={14} className="shrink-0"/><span className="flex-1 font-medium">その他のトーク</span><span className="text-[10px] text-gray-500">{getProgressOtherTalks(task).length}件</span>
        </button>
      </li>}
      {getProgressSubtasks(task).map(st => {
        const smallTasks = getProgressSmallTasks(st);
        const canComplete = !st.completed && !progressCompletionBlocked(task, st);
        return <li key={st.id} draggable data-progress-subtask-id={st.id} data-status={st.completed || task.completed ? 'completed' : progressItemStatus(st, task)}
          onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData(todoDragType, JSON.stringify({ taskId: task.id, id: st.id })); e.dataTransfer.effectAllowed = 'move'; }}
          onDragEnd={e => { e.stopPropagation(); setDropHint(null); }}
          onDragOver={e => { if (!e.dataTransfer.types.includes(todoDragType)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDropHint({ id: st.id, after: e.clientY > e.currentTarget.getBoundingClientRect().top + e.currentTarget.getBoundingClientRect().height / 2 }); }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropHint(null); }}
          onDrop={e => { if (!e.dataTransfer.types.includes(todoDragType)) return; e.preventDefault(); e.stopPropagation(); setDropHint(null); try { const source = JSON.parse(e.dataTransfer.getData(todoDragType)); if (source.taskId === task.id) onReorderSubtask(source.id, st.id, e.clientY > e.currentTarget.getBoundingClientRect().top + e.currentTarget.getBoundingClientRect().height / 2); } catch { /* Ignore unrelated drag payloads. */ } }}
          className={`border rounded-lg text-xs overflow-hidden ${progressStatusClasses(task.completed ? 'completed' : progressItemStatus(st, task))} ${dropHint?.id === st.id ? dropHint.after ? 'border-b-4 border-b-purple-600' : 'border-t-4 border-t-purple-600' : ''}`} onClick={e => { e.stopPropagation(); onFilter(st.id); }}>
          <button type="button" aria-label={`${st.title}のトークを表示`} onClick={e => { e.stopPropagation(); onFilter(st.id); }}
            className="w-full px-2 py-2 text-left hover:bg-white/40 cursor-grab active:cursor-grabbing" draggable>
            <div className="flex gap-1.5 items-start">
              <GripVertical size={13} className="shrink-0 opacity-50 cursor-grab" aria-label="ドラッグで並べ替え"/>
              <span className={`break-words font-medium flex-1 min-w-0 ${st.completed ? 'line-through' : ''}`}>{st.title}</span>
              <span className="text-[10px] shrink-0 opacity-70">小さいタスク {smallTasks.length}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-1 mt-1 opacity-80"><span>{progressStatusLabel(task.completed ? 'completed' : progressItemStatus(st, task))}</span><span>期限: {st.dueDate || '未設定'}</span></div>
          </button>
          <div className="px-2 pb-2 border-t border-black">
            <button type="button" aria-label={`${st.title}の相手待ち一覧`} onClick={e => { e.stopPropagation(); onWaiting({ kind: 'subtask', id: st.id }); }} className="my-1.5 mr-1 rounded border border-black bg-white/80 px-2 py-1 text-[10px] text-green-800">相手待ち一覧（{scopeProgressWaitingItems(waitingItems, { kind: 'subtask', id: st.id }).length}）</button>
            <button type="button" aria-label={`${st.title}のタスク待ちを設定`} onClick={e => { e.stopPropagation(); onDependency({ kind: 'subtask', id: st.id }); }} className="my-1.5 inline-flex items-center gap-1 rounded border bg-white/70 px-2 py-1 text-[10px]"><LinkIcon size={12}/>タスク待ちを設定</button>
            {pendingProgressDependencies(task, st).length > 0 && <p className="text-[11px] mb-2 break-words">タスク待ち: {pendingProgressDependencies(task, st).map(ref => progressDependencyTitle(task, ref)).join('、')}</p>}
            {!smallTasks.length && <p className="py-2 text-[11px] opacity-70">未完了の小さいタスクはありません。</p>}
            <ul className="space-y-1.5 mt-1.5">
              {smallTasks.map(small => <li key={small.id} data-progress-small-task-id={small.id} data-status={task.completed || st.completed ? 'completed' : progressItemStatus(small, task)}
                onClick={e => { e.stopPropagation(); onFilter(st.id, small.id); }}
                draggable
                onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData('application/x-taskmatrix-progress-small', JSON.stringify({ taskId: task.id, parentId: st.id, id: small.id })); e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={e => { if (!e.dataTransfer.types.includes('application/x-taskmatrix-progress-small')) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDropHint({ smallId: small.id, after: e.clientY > e.currentTarget.getBoundingClientRect().top + e.currentTarget.getBoundingClientRect().height / 2 }); }}
                onDrop={e => { if (!e.dataTransfer.types.includes('application/x-taskmatrix-progress-small')) return; e.preventDefault(); e.stopPropagation(); try { const source = JSON.parse(e.dataTransfer.getData('application/x-taskmatrix-progress-small')); setDropHint(null); if (source.taskId === task.id && source.parentId === st.id) onReorderSmallTask(st.id, source.id, small.id, e.clientY > e.currentTarget.getBoundingClientRect().top + e.currentTarget.getBoundingClientRect().height / 2); } catch {} }}
                className={`rounded-lg border px-2 py-1.5 flex gap-2 items-center text-xs ${progressStatusClasses(task.completed || st.completed ? 'completed' : progressItemStatus(small, task))} ${dropHint?.smallId === small.id ? dropHint.after ? 'border-b-4' : 'border-t-4' : ''}`}>
                <button type="button" aria-label={`${small.title}のトークを表示`} disabled={tableView} title={tableView ? 'テーブルでは大タスクかやるべきことを選択してください' : undefined} draggable
                  onClick={e => { e.stopPropagation(); onFilter(st.id, small.id); }}
                  className={`flex-1 min-w-0 text-left rounded focus:outline-none focus:ring-2 focus:ring-purple-400 ${small.completed ? 'line-through' : ''} disabled:opacity-50 disabled:cursor-not-allowed`}>
                  <span className="break-words">{small.title}</span>
                  <span className="block text-[10px] opacity-70 mt-0.5">{progressStatusLabel(task.completed || st.completed ? 'completed' : progressItemStatus(small, task))}</span>
                </button>
                <button type="button" aria-label={`${small.title}の相手待ち一覧`} onClick={e => { e.stopPropagation(); onWaiting({ kind: 'small', parentId: st.id, id: small.id }); }} className="shrink-0 rounded border border-black bg-white/80 px-1.5 py-1 text-[10px] text-green-800">相手待ち {scopeProgressWaitingItems(waitingItems, { kind: 'small', parentId: st.id, id: small.id }).length}</button>
                <button type="button" aria-label={`${small.title}のタスク待ちを設定`} onClick={e => { e.stopPropagation(); onDependency({ kind: 'small', parentId: st.id, id: small.id }); }} className="shrink-0 rounded border bg-white/70 p-1"><LinkIcon size={14}/></button>
                <button type="button" aria-label={`${small.title}を削除`} title="小さいタスクを削除（過去のコメント・引用は残ります）"
                  onClick={e => { e.stopPropagation(); onDeleteSmallTask(small.id); }}
                  className="shrink-0 rounded p-1 text-red-700 hover:bg-red-100"><Trash2 size={14}/></button>
              </li>)}
            </ul>
            {canComplete && !task.completed && <button type="button" aria-label={`${st.title}を完了`} onClick={e => { e.stopPropagation(); onCompleteSubtask(st.id); }} className="mt-2 rounded-lg bg-blue-600 text-white px-3 py-1.5 font-bold">やるべきことを完了</button>}
          </div>
        </li>;
      })}
    </ul>
    {canCompleteProgressTask(task) && <button type="button" aria-label={`${task.title}を完了`} onClick={e => { e.stopPropagation(); onCompleteTask(); }} className="mt-3 w-full rounded-lg bg-blue-600 hover:bg-blue-700 text-white py-2 text-xs font-bold">タスク全体を完了</button>}
    {task.completed && <button type="button" aria-label={`${task.title}の完了を取り消す`} onClick={e => { e.stopPropagation(); onReopenTask(); }} className="mt-3 w-full rounded-lg border bg-white/80 py-1.5 text-xs font-bold">完了を取り消す</button>}
    {!task.completed && (!task.progressStage || task.progressStage === 'todo') && <button type="button" onClick={e => { e.stopPropagation(); onStart(); }} className="mt-3 w-full bg-white/80 border border-current rounded-lg py-1.5 text-xs font-bold hover:bg-white">着手する</button>}
    <p className="mt-3 text-[11px] opacity-70">クリックしてタスク全体のトークを表示</p>
  </article>;
};

const getProgressSmallThreads = (task, history) => {
  const groups = new Map();
  const deletedOrigins = new Set(task.deletedSmallTaskOriginIds || []);
  const deletedEntries = new Set(task.deletedProgressEntryIds || []);
  const completedIds = getCompletedProgressSmallIds(task);
  const ids = new Set([...completedIds, ...getProgressSubtasks(task).flatMap(getProgressSmallTasks).map(small => small.id)]);
  ids.forEach(id => {
    if (deletedOrigins.has(id) || (task.deletedProgressSmallTaskIds || []).includes(id)) return;
    const parent = getProgressSubtasks(task).find(st => getProgressSmallTasks(st).some(small => small.id === id));
    const small = getProgressSmallTasks(parent).find(item => item.id === id);
    const entries = history.filter(entry => entry.smallTaskId === id || entry.completedSmallTaskId === id || entry.quote?.smallTaskId === id
      || (entry.isConclusion && progressConclusionTarget(entry).smallTaskId === id));
    const source = entries.find(entry => entry.addedSmallTask && entry.smallTaskId === id);
    const findOrigin = quote => !quote ? null : quote.smallTaskId === id && quote.addedSmallTask && !deletedEntries.has(quote.id) ? quote : findOrigin(quote.quote);
    const savedOrigin = source || history.map(entry => findOrigin(entry.quote)).find(Boolean);
    const first = savedOrigin || entries[0];
    const origin = source || { ...savedOrigin, id: savedOrigin?.id && !history.some(entry => entry.id === savedOrigin.id) ? savedOrigin.id : `small-origin:${id}`,
      kind: 'comment', addedSmallTask: true, text: savedOrigin?.text || small?.title || first?.smallTaskTitle || '小さいタスク',
      smallTaskId: id, smallTaskTitle: small?.title || first?.smallTaskTitle,
      subtaskIds: savedOrigin?.subtaskIds || (parent ? [parent.id] : first?.subtaskIds || []),
      subtaskTitles: savedOrigin?.subtaskTitles || (parent ? [parent.title] : first?.subtaskTitles || []),
      createdAt: savedOrigin?.createdAt || small?.createdAt };
    groups.set(id, { id, parentId: parent?.id || origin.subtaskIds?.[0], completed: !!(task.completed || parent?.completed || completedIds.has(id)),
      status: task.completed || parent?.completed || completedIds.has(id) ? 'completed' : small ? progressItemStatus(small, task) : 'active', origin, virtual: !source,
      conclusions: getProgressConclusions(history, id), entries: entries.filter(entry => entry.id !== origin.id) });
  });
  return groups;
};
const getProgressTodoThreads = (task, history) => {
  const groups = new Map();
  history.filter(entry => entry.addedSubtask && !entry.smallTaskId && entry.subtaskIds?.length === 1).forEach(origin => {
    const id = origin.subtaskIds[0];
    if (groups.has(id)) return;
    const subtask = getProgressSubtasks(task).find(st => st.id === id);
    groups.set(id, { id, origin, subtask,
      title: progressTodoOriginText(subtask?.title || origin.subtaskTitles?.[0] || origin.text, subtask?.dueDate || origin.dueDate),
      entries: history.filter(entry => entry.id !== origin.id && progressEntryParentIds(entry).includes(id)) });
  });
  getProgressSubtasks(task).forEach(subtask => {
    if (groups.has(subtask.id)) return;
    const entries = history.filter(entry => progressEntryParentIds(entry).includes(subtask.id));
    const title = progressTodoOriginText(subtask.title, subtask.dueDate);
    groups.set(subtask.id, { id: subtask.id, subtask, title, virtual: true, entries,
      origin: { id: `todo-origin:${task.id}:${subtask.id}`, kind: 'comment', addedSubtask: true, text: title,
        status: subtask.completed ? 'completed' : 'active', subtaskIds: [subtask.id], subtaskTitles: [subtask.title],
        createdAt: subtask.createdAt || task.createdAt } });
  });
  groups.forEach(group => { group.conclusions = getProgressConclusions(history, null, group.id); });
  return groups;
};
const getProgressOtherTalks = (task, history = (task.progressHistory || []).filter(isVisibleProgressEntry)) => {
  const parents = getProgressTodoThreads(task, history);
  return history.filter(entry => !progressEntryParentIds(entry).some(id => parents.has(id)));
};
const isResolvedProgressWaiting = entry => entry.status === 'waiting' && !progressEntryIsNote(entry) && !!entry.resolvedByReplyId;

const progressTableStatuses = ['未進捗', '進捗中', '相手待ち', '結論済み'];
const progressSummaryHistory = task => (task.progressHistory || []).filter(entry => entry.kind === 'comment' && !(task.deletedProgressEntryIds || []).includes(entry.id));
const progressSummaryRows = (task, parentId = '') => {
  const parents = getProgressSubtasks(task), completed = getCompletedProgressSmallIds(task);
  const savedHistory = progressSummaryHistory(task), byId = new Map(savedHistory.map(entry => [entry.id, entry]));
  const taskReplies = new Set();
  const history = savedHistory.map(entry => {
    const source = byId.get(entry.quote?.id) || entry.quote;
    if (!(entry.addedSmallTask || entry.addedSubtask) || progressEntryIsNote(entry)
      || source?.status !== 'waiting' || progressEntryIsNote(source)) return entry;
    const added = entry.addedSmallTask ? parents.flatMap(getProgressSmallTasks).find(small => small.id === entry.smallTaskId)
      : parents.find(parent => entry.subtaskIds?.includes(parent.id));
    const title = added?.title || (entry.addedSmallTask ? entry.smallTaskTitle : entry.subtaskTitles?.[0])
      || (entry.addedSubtask ? entry.text?.match(/【([\s\S]*)】$/)?.[1] : '') || entry.text;
    taskReplies.add(entry.id);
    // Creating follow-up work concludes the request in this table, not the new task.
    return { ...entry, text: title, images: [], links: [], isConclusion: true, conclusionTarget: progressConclusionTarget(entry) };
  });
  const meaningful = entry => !entry.assumptionMemo && !entry.addedSmallTask && !entry.addedSubtask;
  const children = new Map();
  history.forEach(entry => { if (entry.quote?.id) children.set(entry.quote.id, [...(children.get(entry.quote.id) || []), entry]); });
  const pendingWait = entry => entry.status === 'waiting' && !progressEntryIsNote(entry) && !entry.resolvedByReplyId && !taskReplies.has(entry.id);
  const entryText = entry => entry ? [entry.text || '', ...progressMediaItems(entry.images).map(image => `[画像: ${image.name || '添付画像'}]`), ...progressMediaItems(entry.links).map(link => `${link.label || 'リンク'}: ${link.url || ''}`)].filter(Boolean).join('\n') : '';
  const initialWait = entry => {
    const seen = new Set([entry.id]); let ancestor = entry.quote;
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id); const actual = byId.get(ancestor.id) || ancestor;
      if (actual.status === 'waiting' && !progressEntryIsNote(actual)) return false;
      ancestor = actual.quote;
    }
    return true;
  };
  const result = [];
  const waitingThread = source => {
    const linked = new Set([source.id]), queue = [source.id];
    for (let index = 0; index < queue.length; index++) (children.get(queue[index]) || []).forEach(entry => {
      if (!linked.has(entry.id)) { linked.add(entry.id); queue.push(entry.id); }
    });
    return history.filter(entry => linked.has(entry.id));
  };
  const decorate = (row, entries, closed, waiting) => {
    const conclusions = entries.filter(entry => entry.isConclusion && (row.kind === 'small' || row.splitSmall ? progressConclusionTarget(entry).smallTaskId === row.smallId : !progressConclusionTarget(entry).smallTaskId) && (entry.text?.trim() || progressMediaItems(entry.images).length || progressMediaItems(entry.links).length));
    const talks = entries.filter(meaningful);
    const latest = entries.filter(entry => !entry.addedSmallTask && !entry.addedSubtask).at(-1) || null;
    return { ...row, entries, conclusions, latest,
      status: closed || conclusions.length ? '結論済み' : waiting ? '相手待ち' : talks.length ? '進捗中' : '未進捗',
      text: conclusions.length ? conclusions.map(entryText).filter(Boolean).join('\n') : entryText(latest),
      updated: Math.max(0, ...entries.map(entry => Date.parse(entry.editedAt || entry.createdAt) || 0)) };
  };
  parents.filter(parent => !parentId || parent.id === parentId).forEach(parent => {
    getProgressSmallTasks(parent).forEach(small => {
      const entries = history.filter(entry => entry.smallTaskId === small.id || entry.completedSmallTaskId === small.id || (entry.isConclusion && progressConclusionTarget(entry).smallTaskId === small.id));
      const waits = entries.filter(entry => entry.status === 'waiting' && !progressEntryIsNote(entry));
      const pending = !!small.waiting || waits.some(pendingWait);
      const closed = task.completed || parent.completed || small.completed || completed.has(small.id);
      const splitEnabled = !!small.progressTableSplitWaiting;
      const context = { parentId: parent.id, parentIds: [parent.id], parentTitle: parent.title, smallId: small.id, smallTitle: small.title, canSplit: waits.length > 0 || !!small.waiting || splitEnabled, splitEnabled };
      if (splitEnabled) {
        waits.filter(initialWait).forEach(source => {
          const thread = waitingThread(source), replies = thread.filter(entry => entry.id !== source.id && !progressEntryIsNote(entry));
          const finished = closed || source.resolvedByReplyId === 'waiting-cleared-in-settings' || replies.some(entry => entry.status === 'completed' && !progressEntryIsNote(entry));
          result.push(decorate({ ...context, id: `waiting:${source.id}`, kind: 'waiting', splitSmall: true, sourceId: source.id, waitingTitle: source.text || '本文なし' }, thread, finished, thread.some(pendingWait)));
        });
        if (!waits.filter(initialWait).length) result.push(decorate({ ...context, id: `waiting-scope:small:${small.id}`, kind: 'waiting', splitSmall: true, waitingScope: `small:${small.id}`, waitingTitle: small.waiting ? `${small.title}（相手待ち）` : '相手待ちトークなし（分割設定中）' }, entries, closed, pending));
      } else result.push(decorate({ ...context, id: `small:${parent.id}:${small.id}`, kind: 'small', waitingTitle: '' }, entries, closed, pending));
    });
  });
  const waits = history.filter(entry => entry.status === 'waiting' && !progressEntryIsNote(entry) && !entry.smallTaskId && !entry.completedSmallTaskId && (!parentId || entry.subtaskIds?.includes(parentId)) && initialWait(entry));
  waits.forEach(source => {
    const entries = waitingThread(source);
    const replies = entries.filter(entry => entry.id !== source.id && !progressEntryIsNote(entry));
    const owner = parents.find(parent => source.subtaskIds?.includes(parent.id));
    const manuallyClosed = source.resolvedByReplyId === 'waiting-cleared-in-settings';
    const closed = task.completed || (owner?.completed && (source.subtaskIds || []).every(id => parents.find(parent => parent.id === id)?.completed)) || manuallyClosed || replies.some(entry => entry.status === 'completed' && !progressEntryIsNote(entry));
    result.push(decorate({ id: `waiting:${source.id}`, kind: 'waiting', sourceId: source.id, parentId: owner?.id || '', parentIds: source.subtaskIds || [], parentTitle: (source.subtaskIds || []).map(id => parents.find(parent => parent.id === id)?.title).filter(Boolean).join('、') || 'タスク全体', smallTitle: '', waitingTitle: source.text || '本文なし' }, entries, closed, entries.some(pendingWait)));
  });
  // A parent can be waiting before a request is posted; the big task itself is never a row.
  parents.filter(parent => !parentId || parent.id === parentId).forEach(parent => {
    const scope = `subtask:${parent.id}`;
    const entries = history.filter(entry => entry.tableWaitingScope === scope);
    const hasRequest = history.some(entry => entry.status === 'waiting' && !progressEntryIsNote(entry) && !entry.smallTaskId && progressWaitingScope(task, entry) === scope);
    if (hasRequest || (!parent.waiting && !entries.length)) return;
    result.push(decorate({ id: `waiting-scope:${scope}`, kind: 'waiting', waitingScope: scope, parentId: parent.id, parentIds: [parent.id], parentTitle: parent.title, smallTitle: '', waitingTitle: `${parent.title}（相手待ち）` }, entries, task.completed || parent.completed || !parent.waiting, !!parent.waiting));
  });
  return result;
};
const progressSummaryMatrix = rows => [
  ['やるべきこと', '小さいタスク', '相手待ち', '結論／最後のトーク', 'ステータス', '内容の区分'],
  ...rows.map(row => [row.parentTitle, row.smallTitle, row.waitingTitle, row.text, row.status, row.conclusions.length ? '結論' : row.latest ? '最後のトーク（未確定）' : 'トークなし'])
];
const progressSummaryExcel = rows => {
  const matrix = progressSummaryMatrix(rows), xml = reportXml;
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${matrix.map((row, i) => `<row r="${i + 1}">${row.map((value, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:F${matrix.length}"/></worksheet>`;
  const files = [
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="進捗一覧" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheet }
  ];
  return new Blob([reportZip(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
};
const applyProgressTableConclusion = (task, rowId, text, useLatest = false) => {
  const row = progressSummaryRows(task).find(row => row.id === rowId);
  if (!row || row.conclusions.length) return task;
  const now = new Date().toISOString();
  if (useLatest) {
    if (!row.latest) return task;
    return { ...task, progressHistory: (task.progressHistory || []).map(entry => entry.id === row.latest.id ? { ...entry, isConclusion: true, conclusionTarget: progressConclusionTarget(entry), editedAt: now } : entry) };
  }
  if (!text.trim()) return task;
  const source = row.sourceId ? progressSummaryHistory(task).find(entry => entry.id === row.sourceId) : null;
  const entry = { id: createProgressId(), kind: 'comment', createdAt: now, text: text.trim(), status: 'active', isConclusion: true,
    subtaskIds: row.smallId ? [row.parentId] : row.parentIds || [],
    subtaskTitles: row.smallId ? [row.parentTitle] : getProgressSubtasks(task).filter(parent => (row.parentIds || []).includes(parent.id)).map(parent => parent.title),
    ...(row.smallId ? { smallTaskId: row.smallId, smallTaskTitle: row.smallTitle } : {}),
    ...(source ? { quote: createProgressQuote(source) } : {}), ...(row.waitingScope ? { tableWaitingScope: row.waitingScope } : {}) };
  entry.conclusionTarget = progressConclusionTarget(entry);
  return { ...task, progressHistory: [...(task.progressHistory || []), entry] };
};
const setProgressTableSplitWaiting = (task, parentId, smallId, enabled) => ({
  ...task, subtasks: getProgressSubtasks(task).map(parent => parent.id === parentId
    ? { ...parent, smallTasks: getProgressSmallTasks(parent).map(small => small.id === smallId ? { ...small, progressTableSplitWaiting: enabled } : small) } : parent)
});
const ProgressSummaryTable = ({ task, parentId, query, onUpdateTask, active = true, onNavigate }) => {
  const [status, setStatus] = useState('all'), [sort, setSort] = useState('default'), [descending, setDescending] = useState(false);
  const [checked, setChecked] = useState([]), [onlyChecked, setOnlyChecked] = useState(false);
  const [notice, setNotice] = useState(''), [draft, setDraft] = useState(null), [conclusionText, setConclusionText] = useState('');
  const dialogRef = useRef(null), settingsRef = useRef(null);
  const [rowSettings, setRowSettings] = useState(null);
  const rows = active ? progressSummaryRows(task, parentId) : [];
  const filtered = rows.filter(row => (status === 'all' || row.status === status) && (!onlyChecked || checked.includes(row.id)) && (!query.trim() || [row.parentTitle, row.smallTitle, row.waitingTitle, row.text, row.status].join(' ').toLowerCase().includes(query.trim().toLowerCase())));
  const compare = (a, b) => sort === 'status' ? progressTableStatuses.indexOf(a.status) - progressTableStatuses.indexOf(b.status) : sort === 'updated' ? a.updated - b.updated : sort === 'title' ? (a.smallTitle || a.waitingTitle).localeCompare(b.smallTitle || b.waitingTitle, 'ja') : rows.indexOf(a) - rows.indexOf(b);
  const displayed = [...filtered].sort((a, b) => (descending ? -1 : 1) * compare(a, b));
  const toggle = id => setChecked(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
  const changeSplit = (row, enabled) => {
    const sameGroup = item => item.parentId === row.parentId && item.smallId === row.smallId;
    const groupIds = rows.filter(sameGroup).map(item => item.id);
    const nextRows = progressSummaryRows(setProgressTableSplitWaiting(task, row.parentId, row.smallId, enabled), parentId).filter(sameGroup);
    setChecked(previous => {
      const retained = previous.filter(id => !groupIds.includes(id));
      return previous.some(id => groupIds.includes(id)) ? [...new Set([...retained, ...nextRows.map(item => item.id)])] : retained;
    });
    onUpdateTask(task.id, previous => setProgressTableSplitWaiting(previous, row.parentId, row.smallId, enabled));
  };
  useEffect(() => {
    if (!rowSettings) return;
    const previous = document.activeElement; settingsRef.current?.querySelector('input')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [rowSettings]);
  const copy = async () => { try { await navigator.clipboard.writeText(progressGridTsv(progressSummaryMatrix(displayed))); setNotice(`${displayed.length}行をコピーしました。`); } catch { setNotice('コピーできませんでした。ブラウザーのクリップボード許可を確認してください。'); } };
  const download = () => {
    const url = URL.createObjectURL(progressSummaryExcel(displayed)), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `進捗一覧_${String(task.title || 'タスク').replace(/[\\/:*?"<>|]/g, '_')}_${formatDate(new Date())}.xlsx`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice(`${displayed.length}行をExcel出力しました。`);
  };
  useEffect(() => {
    if (!draft) return;
    const previous = document.activeElement; dialogRef.current?.querySelector('textarea')?.focus();
    return () => previous?.focus();
  }, [draft]);
  return <section aria-label="進捗テーブル" className={`${active ? 'flex' : 'hidden'} flex-col flex-1 min-h-0 bg-white`}>
    <div className="flex flex-wrap gap-2 items-center border-b p-2 text-xs shrink-0">
      <label>ステータス<select aria-label="進捗テーブルのステータス" value={status} onChange={e => setStatus(e.target.value)} className="ml-1 rounded border p-1"><option value="all">すべて</option>{progressTableStatuses.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>並び順<select aria-label="進捗テーブルの並び順" value={sort} onChange={e => setSort(e.target.value)} className="ml-1 rounded border p-1">{[['default','登録順'],['status','ステータス'],['title','名前'],['updated','最終更新']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button type="button" aria-label="進捗テーブルの並び順を反転" onClick={() => setDescending(value => !value)} className="rounded border px-2 py-1">{descending ? '降順' : '昇順'}</button>
      <label><input type="checkbox" checked={onlyChecked} onChange={e => setOnlyChecked(e.target.checked)}/> チェックした行だけ</label>
      <button type="button" onClick={copy} className="rounded border px-2 py-1">テーブルをコピー</button>
      <button type="button" onClick={download} className="rounded border px-2 py-1">Excel出力</button>
      <span role="status">{notice || `${displayed.length}行 / ${rows.length}行`}</span>
    </div>
    <div className="overflow-auto flex-1 min-h-0">
      <table aria-label="進捗一覧" className="w-full border-collapse text-xs"><thead className="sticky top-0 bg-slate-100 z-10"><tr>
        <th className="border p-2"><input type="checkbox" aria-label="表示中の行をすべて選択" checked={displayed.length > 0 && displayed.every(row => checked.includes(row.id))} onChange={e => setChecked(previous => e.target.checked ? [...new Set([...previous, ...displayed.map(row => row.id)])] : previous.filter(id => !displayed.some(row => row.id === id)))}/></th>
        {['やるべきこと','小さいタスク','相手待ち','結論／最後のトーク','ステータス'].map(label => <th key={label} className="border p-2 text-left whitespace-nowrap">{label}</th>)}
      </tr></thead><tbody>{displayed.map(row => <tr key={row.id} data-progress-summary-row={row.id}>
        <td className="border p-2 align-top"><input type="checkbox" aria-label={`行を選択: ${row.smallTitle || row.waitingTitle}`} checked={checked.includes(row.id)} onChange={() => toggle(row.id)}/></td>
        <td className="border p-2 align-top min-w-24">{row.parentTitle}</td><td className="border p-2 align-top min-w-28"><span>{row.smallTitle}</span>{row.canSplit && <button type="button" aria-label={`行設定: ${row.smallTitle}`} title="相手待ちへの分割を設定" onClick={() => setRowSettings(row)} className="ml-1 rounded border bg-white p-1"><Settings size={13}/></button>}{row.splitSmall && <span className="mt-1 block text-[10px] text-gray-500">相手待ちに分割中</span>}</td><td className="border p-2 align-top min-w-28 whitespace-pre-wrap">{row.waitingTitle}</td>
        <td className="border p-2 align-top min-w-48">
          <div data-summary-conclusion={row.conclusions.length ? 'confirmed' : 'latest'} className={`whitespace-pre-wrap break-words ${row.conclusions.length ? 'text-black' : 'text-gray-400'}`}>{(row.conclusions.length ? row.conclusions : row.latest ? [row.latest] : []).map((entry, index) => <button key={entry.id} type="button" aria-label={`トークへ移動: ${entry.text || '添付のみのトーク'}`} onClick={() => onNavigate(entry)} className="block w-full text-left hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500">{index > 0 && '\n'}{entry.text || '添付のみのトーク'}</button>)}{!row.conclusions.length && !row.latest && 'トークなし'}</div>
          {!row.conclusions.length && <div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={!row.latest} onClick={() => onUpdateTask(task.id, previous => applyProgressTableConclusion(previous, row.id, '', true))} className="rounded border px-2 py-1 text-blue-700 disabled:opacity-30">このトークを結論にする</button><button type="button" onClick={() => { setConclusionText(''); setDraft(row); }} className="rounded border px-2 py-1 text-blue-700">別の結論を記入</button></div>}
        </td><td className="border p-2 align-top whitespace-nowrap"><span className={`rounded px-2 py-1 ${row.status === '結論済み' ? 'bg-blue-50 text-blue-700' : row.status === '相手待ち' ? 'bg-green-50 text-green-700' : row.status === '進捗中' ? 'bg-purple-50 text-purple-700' : 'bg-gray-100 text-gray-600'}`}>{row.status}</span></td>
      </tr>)}</tbody></table>
      {!displayed.length && <p className="p-6 text-center text-sm text-gray-500">条件に一致する行はありません。</p>}
    </div>
    {rowSettings && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"><section ref={settingsRef} role="dialog" aria-modal="true" aria-label="進捗テーブルの行設定" className="w-full max-w-md rounded-xl bg-white p-4 space-y-3" onKeyDown={e => {
      e.stopPropagation(); if (e.key === 'Escape' && !e.nativeEvent.isComposing) setRowSettings(null);
      if (e.key === 'Tab') { const items = [...settingsRef.current.querySelectorAll('input,button')]; if (e.shiftKey && e.target === items[0]) { e.preventDefault(); items.at(-1).focus(); } else if (!e.shiftKey && e.target === items.at(-1)) { e.preventDefault(); items[0].focus(); } }
    }}><h3 className="font-bold">行設定: {rowSettings.smallTitle}</h3><label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="相手待ちタスクに分割" checked={!!getProgressSmallTasks(getProgressSubtasks(task).find(parent => parent.id === rowSettings.parentId)).find(small => small.id === rowSettings.smallId)?.progressTableSplitWaiting} onChange={e => changeSplit(rowSettings, e.target.checked)}/>相手待ちタスクに分割</label><p className="text-xs text-gray-600">行の表示を相手待ちごとに分割し、元の小さいタスクとトークを保ちます。返信・結論の後も分割を維持します。分割した行の設定からオフにすると元の1行に戻ります。</p><div className="flex justify-end"><button type="button" onClick={() => setRowSettings(null)} className="rounded border px-3 py-2">閉じる</button></div></section></div>}
    {draft && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"><section ref={dialogRef} role="dialog" aria-modal="true" aria-label="進捗テーブルの結論を記入" className="w-full max-w-lg rounded-xl bg-white p-4 space-y-3" onKeyDown={e => {
      e.stopPropagation(); if (e.key === 'Escape' && !e.nativeEvent.isComposing) setDraft(null);
      if (e.key === 'Tab') { const items = [...dialogRef.current.querySelectorAll('textarea,button:not(:disabled)')]; if (e.shiftKey && e.target === items[0]) { e.preventDefault(); items.at(-1).focus(); } else if (!e.shiftKey && e.target === items.at(-1)) { e.preventDefault(); items[0].focus(); } }
    }}><h3 className="font-bold">結論を記入</h3><p className="text-xs text-gray-600">{draft.smallTitle || draft.waitingTitle}に結論コメントを追加します。</p><textarea aria-label="結論コメント" value={conclusionText} onChange={e => setConclusionText(e.target.value)} rows={6} className="w-full rounded border p-2"/><div className="flex justify-end gap-2"><button type="button" onClick={() => setDraft(null)} className="rounded border px-3 py-2">キャンセル</button><button type="button" disabled={!conclusionText.trim()} onClick={() => { onUpdateTask(task.id, previous => applyProgressTableConclusion(previous, draft.id, conclusionText)); setDraft(null); }} className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-30">結論コメントを追加</button></div></section></div>}
  </section>;
};
const ProgressThread = ({ task, onUpdateTask, smallTaskTarget, showResolvedWaiting = true, expandedComposer = false, tableView = false, onTableViewChange }) => {
  const [text, setText] = useState('');
  const [textLinks, setTextLinks] = useState([]);
  const [textFormats, setTextFormats] = useState([]);
  const [images, setImages] = useState([]);
  const [links, setLinks] = useState([]);
  const [mediaError, setMediaError] = useState('');
  const [mediaBusy, setMediaBusy] = useState(false);
  const mediaVersion = useRef(0);
  const mediaPending = useRef(0);
  useEffect(() => () => { mediaVersion.current += 1; }, []);
  const hasDraftContent = !!text.trim() || images.length > 0 || links.length > 0;
  const addImages = async files => {
    const selectedFiles = [...files];
    if (!selectedFiles.length) return;
    if (selectedFiles.some(file => !['image/png','image/jpeg','image/gif','image/webp','image/avif'].includes(file.type) || file.size > 10 * 1024 * 1024)) {
      setMediaError('画像はPNG・JPEG・GIF・WebP・AVIF形式、1枚10MBまで添付できます。'); return;
    }
    const version = mediaVersion.current;
    mediaPending.current += 1;
    setMediaError(''); setMediaBusy(true);
    try {
      const added = await Promise.all(selectedFiles.map(file => new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve({ id: createProgressId(), name: file.name, src: reader.result });
        reader.onerror = reject; reader.readAsDataURL(file);
      })));
      if (version === mediaVersion.current) setImages(previous => [...previous, ...added]);
    } catch { if (version === mediaVersion.current) setMediaError('画像を読み込めませんでした。'); }
    finally { if (version === mediaVersion.current) { mediaPending.current -= 1; setMediaBusy(mediaPending.current > 0); } }
  };
  const [selectedIds, setSelectedIds] = useState([]);
  const [addTodo, setAddTodo] = useState(false);
  const [addSmall, setAddSmall] = useState(false);
  const [smallTarget, setSmallTarget] = useState(null);
  const [dueDate, setDueDate] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [plainComment, setPlainComment] = useState(false);
  const [assumptionMemo, setAssumptionMemo] = useState(false);
  const neutralComment = plainComment || assumptionMemo;
  const [isConclusion, setIsConclusion] = useState(false);
  const [query, setQuery] = useState('');
  const [talkType, setTalkType] = useState('all');
  const [talkStatus, setTalkStatus] = useState('all');
  const filteringTalks = talkType !== 'all' || talkStatus !== 'all';
  const [filterId, setFilterId] = useState('');
  const [filterSmallId, setFilterSmallId] = useState('');
  const [filterOther, setFilterOther] = useState(false);
  const [otherExpanded, setOtherExpanded] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [conversionParentId, setConversionParentId] = useState('');
  const [editingStatusChanged, setEditingStatusChanged] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [editedReply, setEditedReply] = useState(undefined);
  const [selectingReply, setSelectingReply] = useState(false);
  const [quoteDetail, setQuoteDetail] = useState(null);
  const [jumpRequest, setJumpRequest] = useState(null);
  const [highlightedId, setHighlightedId] = useState(null);
  const [selectedEntryId, setSelectedEntryId] = useState(null);
  const selectedEntryRef = useRef(null);
  const [expandedSmallIds, setExpandedSmallIds] = useState([]);
  const [expandedTodoIds, setExpandedTodoIds] = useState([]);
  const [collapsedTodoIds, setCollapsedTodoIds] = useState([]);
  const historyRef = useRef(null);
  const historyContentRef = useRef(null);
  const followLatestRef = useRef(true);
  const allowFollowRef = useRef(true);
  const composerRef = useRef(null);
  const subtasks = getProgressSubtasks(task);
  // Hide old automatic logs without deleting saved data or user comments.
  const history = (task.progressHistory || []).filter(isVisibleProgressEntry);
  const otherIds = new Set(getProgressOtherTalks(task, history).map(entry => entry.id));
  useEffect(() => {
    const availableIds = new Set([...getCompletedProgressSmallIds(task), ...getProgressSubtasks(task).flatMap(getProgressSmallTasks).map(small => small.id)]);
    setExpandedSmallIds(ids => { const retained = ids.filter(id => availableIds.has(id)); return retained.length === ids.length ? ids : retained; });
  }, [task]);
  const editingEntry = history.find(entry => entry.id === editingId && entry.kind === 'comment');
  const editingTodo = editingEntry?.addedSubtask && !editingEntry.smallTaskId && editingEntry.subtaskIds?.length === 1
    ? subtasks.find(st => st.id === editingEntry.subtaskIds[0]) : null;
  const conversionParents = editingTodo ? subtasks.filter(st => st.id !== editingTodo.id) : [];
  const convertingTodo = !!editingTodo && addSmall;
  const conversionPreview = useMemo(() => convertingTodo
    ? convertProgressTodoToSmall(task, editingTodo.id, conversionParentId) : null, [task, convertingTodo, editingTodo?.id, conversionParentId]);
  const editedReplyChanged = !!editingId && editedReply !== undefined;
  const replyContext = editingId ? editedReplyChanged ? editedReply : editingEntry?.quote : replyTo;
  allowFollowRef.current = !editingId && !selectingReply;
  const selected = subtasks.filter(st => selectedIds.includes(st.id));
  const targetSubtask = subtasks.find(st => st.id === smallTarget?.subtaskId);
  const targetSmall = getProgressSmallTasks(targetSubtask).find(small => small.id === smallTarget?.smallTaskId);
  const scopeParent = subtasks.find(st => st.id === filterId || (!filterId && getProgressSmallTasks(st).some(small => small.id === filterSmallId)));
  const scopeSmall = getProgressSmallTasks(scopeParent).find(small => small.id === filterSmallId);
  const scopeDependencies = scopeSmall ? pendingProgressDependencies(task, scopeSmall) : [];
  const showEntry = entry => showResolvedWaiting || !isResolvedProgressWaiting(entry);
  const visibleHistory = history.filter(entry => ((!filterOther || otherIds.has(entry.id)) && (filteringTalks || (!(filterSmallId && entry.addedSmallTask && entry.smallTaskId === filterSmallId) && !(filterId && !filterSmallId && entry.addedSubtask && entry.subtaskIds?.includes(filterId)))) && showEntry(entry) && (!filterSmallId || entry.smallTaskId === filterSmallId || entry.completedSmallTaskId === filterSmallId || entry.quote?.smallTaskId === filterSmallId || (entry.isConclusion && progressConclusionTarget(entry).smallTaskId === filterSmallId)) && (!filterId || progressEntryParentIds(entry).includes(filterId))) && (!query.trim() || [entry.text, ...progressMediaItems(entry.textLinks).map(link => link.url), ...(entry.subtaskTitles || []), ...progressEntrySubtaskTitles(task, entry), entry.smallTaskTitle, ...progressMediaItems(entry.images).map(image => image.name), ...progressMediaItems(entry.links).flatMap(link => [link.label, link.url]), entry.createdAt, entry.dueDate, progressQuoteSearchText(entry.quote)].filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase())) && progressTalkMatchesFilters(entry, task, talkType, talkStatus));
  const scrollHistory = bottom => {
    followLatestRef.current = bottom;
    const element = historyRef.current;
    if (element) element.scrollTop = bottom ? element.scrollHeight : 0;
  };
  React.useLayoutEffect(() => { scrollHistory(true); }, [task.id, filterId, filterSmallId, filterOther, talkType, talkStatus, smallTaskTarget?.requestId]);
  React.useLayoutEffect(() => {
    if (followLatestRef.current && allowFollowRef.current) scrollHistory(true);
  }, [history.length, history[history.length - 1]?.id]);
  useEffect(() => {
    const follow = () => { if (followLatestRef.current && allowFollowRef.current) scrollHistory(true); };
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(follow);
    if (historyRef.current) observer.observe(historyRef.current);
    if (historyContentRef.current) observer.observe(historyContentRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (editingId) composerRef.current?.focus(); }, [editingId]);
  useEffect(() => {
    if (!jumpRequest) return;
    followLatestRef.current = false;
    const row = [...(historyRef.current?.querySelectorAll('[data-progress-entry-id]') || [])]
      .find(element => element.dataset.progressEntryId === String(jumpRequest.id));
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row?.focus({ preventScroll: true });
    setHighlightedId(jumpRequest.id);
    const timer = setTimeout(() => setHighlightedId(null), 1800);
    return () => clearTimeout(timer);
  }, [jumpRequest]);
  const revealEntryGroups = entry => {
    if (otherIds.has(entry.id)) setOtherExpanded(true);
    const smallIds = [entry.smallTaskId, entry.completedSmallTaskId].filter(Boolean);
    if (smallIds.length) setExpandedSmallIds(ids => [...new Set([...ids, ...smallIds])]);
    const todoGroups = getProgressTodoThreads(task, history);
    const parentIds = progressEntryParentIds(entry).filter(id => todoGroups.has(id));
    if (parentIds.length) setExpandedTodoIds(ids => [...new Set([...ids, ...parentIds])]);
  };
  const navigateQuote = quote => {
    if (history.some(entry => entry.id === quote.id)) {
      setTalkType('all'); setTalkStatus('all');
      chooseThreadScope();
      revealEntryGroups(history.find(entry => entry.id === quote.id));
      setJumpRequest({ id: quote.id, requestId: createProgressId() });
    } else setQuoteDetail(quote);
  };
  const scopeSmallTarget = (parentId, smallId) => {
    const parent = subtasks.find(st => st.id === parentId);
    const small = getProgressSmallTasks(parent).find(item => item.id === smallId) || history.find(entry => entry.smallTaskId === smallId);
    return smallId ? { subtaskId: parentId, smallTaskId: smallId, title: small?.title || small?.smallTaskTitle, subtaskTitle: parent?.title } : null;
  };
  const resetComposer = () => {
    mediaVersion.current += 1; mediaPending.current = 0; setImages([]); setLinks([]); setMediaError(''); setMediaBusy(false);
    const retained = !editingId && !replyTo && selectedEntryId ? selectedEntryRef.current : null;
    const parentId = retained?.subtaskIds?.[0] || filterId;
    setPlainComment(false); setAssumptionMemo(false); setText(''); setTextLinks([]); setTextFormats([]); setSelectedIds(parentId ? [parentId] : []); setAddTodo(false); setAddSmall(false);
    setSmallTarget(scopeSmallTarget(parentId, retained ? retained.smallTaskId : filterSmallId));
    setDueDate(''); setWaiting(false); setIsConclusion(false); setEditingId(null); setConversionParentId(''); setEditingStatusChanged(false); setReplyTo(null); setEditedReply(undefined); setSelectingReply(false);
  };
  const chooseThreadScope = (parentId = '', smallId = '', force = false) => {
    setQuery(''); setFilterId(parentId); setFilterSmallId(smallId); setFilterOther(false); setSelectedEntryId(null); selectedEntryRef.current = null;
    if (force || (!editingId && !replyTo)) {
      setSelectedIds(parentId ? [parentId] : []); setIsConclusion(false); setWaiting(false);
      if (!parentId) setAddSmall(false);
      setSmallTarget(scopeSmallTarget(parentId, smallId));
    }
  };
  const chooseOtherScope = () => { chooseThreadScope(); setFilterOther(true); };
  const missingDraftSource = !!((editingId && !editingEntry) || (replyTo && !findProgressReplySource(task, replyTo)));
  useEffect(() => { if (missingDraftSource) resetComposer(); }, [missingDraftSource]);
  React.useLayoutEffect(() => {
    if (!smallTaskTarget || smallTaskTarget.taskId !== task.id) { resetComposer(); setFilterId(''); setFilterSmallId(''); setFilterOther(false); return; }
    if (smallTaskTarget.filterOnly) {
      if (smallTaskTarget.clearComposer) resetComposer();
      chooseThreadScope(smallTaskTarget.subtaskId || '', smallTaskTarget.smallTaskId || '', smallTaskTarget.clearComposer);
      if (smallTaskTarget.otherTalks) setFilterOther(true);
    }
  }, [smallTaskTarget?.requestId]);
  useEffect(() => {
    if (smallTarget && !targetSmall && !editingId && !replyTo) resetComposer();
  }, [smallTarget?.smallTaskId, !!targetSmall, editingId, replyTo?.id]);
  const editComment = entry => {
    // Group headings substitute the current title for display. Edit the saved
    // record so a custom historical body and its link offsets are not lost.
    entry = history.find(saved => saved.id === entry.id) || entry;
    setSelectedEntryId(null);
    revealEntryGroups(entry);
    mediaVersion.current += 1; mediaPending.current = 0; setMediaBusy(false); setMediaError('');
    setImages(progressMediaItems(entry.images).map(image => ({ ...image }))); setLinks(progressMediaItems(entry.links).map(link => ({ ...link })));
    setReplyTo(null); setEditedReply(undefined); setSelectingReply(false);
    const todo = entry.addedSubtask && !entry.smallTaskId && entry.subtaskIds?.length === 1 ? subtasks.find(st => st.id === entry.subtaskIds[0]) : null;
    const titleMatch = todo && entry.text.match(/^[\s\S]*?までに【([\s\S]*)】$/);
    const draftText = todo && (titleMatch || entry.text === todo.title || entry.text === entry.subtaskTitles?.[0]) ? todo.title : entry.text;
    const titleOffset = titleMatch ? entry.text.length - titleMatch[1].length - 1 : 0;
    const draftLinks = todo ? (titleMatch?.[1] === draftText || entry.text === draftText
      ? progressAllTextLinks(entry.text, entry.textLinks).filter(link => link.start >= titleOffset && link.end <= titleOffset + draftText.length).map(link => ({ ...link, start: link.start - titleOffset, end: link.end - titleOffset }))
      : progressAllTextLinks(draftText, [])) : progressAllTextLinks(entry.text, entry.textLinks);
    setEditingId(entry.id); setText(draftText); setTextLinks(draftLinks); setTextFormats(entry.text.slice(titleOffset,titleOffset+draftText.length)===draftText ? progressSliceFormats(entry.text,entry.textFormats,titleOffset,titleOffset+draftText.length) : []); setPlainComment(!!entry.plainComment && !entry.assumptionMemo); setAssumptionMemo(!!entry.assumptionMemo);
    setSelectedIds(entry.subtaskIds || []);
    setWaiting(entry.status === 'waiting' && !entry.resolvedByReplyId); setIsConclusion(!!entry.isConclusion); setEditingStatusChanged(false);
    setAddTodo(!!todo); setAddSmall(false); setDueDate(todo?.dueDate || entry.dueDate || '');
    const parents = todo ? subtasks.filter(st => st.id !== todo.id) : [];
    setConversionParentId(parents.length === 1 ? parents[0].id : '');
    setSmallTarget(entry.smallTaskId ? { subtaskId: entry.subtaskIds?.[0], smallTaskId: entry.smallTaskId, title: entry.smallTaskTitle, subtaskTitle: entry.subtaskTitles?.[0] } : null);
    composerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const replyToComment = entry => {
    setSelectedEntryId(null);
    resetComposer();
    setReplyTo(createProgressQuote(entry));
    setSelectedIds(entry.subtaskIds || []);
    setSmallTarget(entry.smallTaskId ? { subtaskId: entry.subtaskIds?.[0], smallTaskId: entry.smallTaskId, title: entry.smallTaskTitle, subtaskTitle: entry.subtaskTitles?.[0] } : null);
    composerRef.current?.focus();
    composerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const chooseEditedReply = entry => {
    entry = entry ? history.find(saved => saved.id === entry.id) || entry : null;
    if (entry && progressReplyWouldCycle(task, editingId, entry)) return;
    setEditedReply(entry ? createProgressQuote(entry) : null);
    if (!editingEntry?.addedSubtask && !editingEntry?.addedSmallTask) {
      const source = entry || editingEntry;
      setSelectedIds(source?.subtaskIds || []);
      setSmallTarget(source?.smallTaskId ? scopeSmallTarget(source.subtaskIds?.[0], source.smallTaskId) : null);
    }
  };
  const composerBaseSmallTarget = () => {
    const source = replyTo || (editedReplyChanged && editedReply && !editingEntry?.addedSubtask && !editingEntry?.addedSmallTask ? editedReply : editingEntry) || (selectedEntryId ? selectedEntryRef.current : null);
    return source
      ? source.smallTaskId ? scopeSmallTarget(source.subtaskIds?.[0], source.smallTaskId) : null
      : scopeSmallTarget(filterId, filterSmallId);
  };
  const restoreComposerTarget = () => setSmallTarget(composerBaseSmallTarget());
  const deleteComment = id => {
    onUpdateTask(task.id, previous => {
      const entry = (previous.progressHistory || []).find(item => item.id === id);
      const deletesTodo = entry?.addedSubtask && !entry.smallTaskId && entry.subtaskIds?.length === 1;
      const retractsCompletion = !deletesTodo && entry?.kind === 'comment' && !progressEntryIsNote(entry) && entry.status === 'completed';
      const deletesSmall = entry?.addedSmallTask && entry.smallTaskId && !retractsCompletion;
      const next = deletesTodo ? removeProgressTodo(previous, entry.subtaskIds[0]) : retractsCompletion ? retractProgressCompletion(previous, entry)
        : deletesSmall ? removeProgressSmallTask(previous, entry.smallTaskId) : previous;
      return { ...next, deletedProgressEntryIds: [...new Set([...(next.deletedProgressEntryIds || []), id])],
        ...(deletesSmall ? { deletedSmallTaskOriginIds: [...new Set([...(previous.deletedSmallTaskOriginIds || []), entry.smallTaskId])] } : {}),
        progressHistory: (next.progressHistory || []).filter(item => item.id !== id) };
    });
    if (editingId === id || replyTo?.id === id) resetComposer();
  };
  const toggleConclusion = (entry, checked) => {
    onUpdateTask(task.id, previous => ({ ...previous, progressHistory: (previous.progressHistory || []).map(item => item.id === entry.id
      ? { ...item, isConclusion: checked, ...(checked ? { conclusionTarget: progressConclusionTarget(item) } : {}), editedAt: new Date().toISOString() } : item) }));
    if (editingId === entry.id) setIsConclusion(checked);
  };
  const toggleSmallCompletion = () => {
    onUpdateTask(task.id, previous => {
      const parent = getProgressSubtasks(previous).find(st => st.id === filterId || (!filterId && getProgressSmallTasks(st).some(small => small.id === filterSmallId)));
      const small = getProgressSmallTasks(parent).find(item => item.id === filterSmallId);
      if (!small || progressCompletionBlocked(previous, small)) return previous;
      if (small.completed) return reopenProgressSmallTask(previous, small.id);
      const finished = completeProgressSmallTask(previous, small.id);
      return { ...finished, subtasks: getProgressSubtasks(finished).map(st => st.id === parent.id
        ? { ...st, smallTasks: getProgressSmallTasks(st).map(item => {
          if (item.id !== small.id) return item;
          const next = { ...item, completedAt: new Date().toISOString(), completionManaged: true, completionSource: 'manual' };
          delete next.completionEntryId; delete next.completionConclusion;
          return next;
        }) } : st) };
    });
  };
  const send = (e, mode) => sendDraft(e, {
    plainComment: mode ? mode === 'plain' : plainComment,
    assumptionMemo: mode ? mode === 'premise' : assumptionMemo,
    waiting: mode ? mode === 'waiting' : waiting,
    addTodo: mode ? mode === 'todo' : addTodo,
    addSmall: mode ? mode === 'small' : addSmall,
    smallTarget: mode === 'todo' || mode === 'small' ? null : mode ? composerBaseSmallTarget() : smallTarget,
    editingStatusChanged: !!mode || editingStatusChanged
  });
  const sendDraft = (e, { plainComment, assumptionMemo, waiting, addTodo, addSmall, smallTarget, editingStatusChanged }) => {
    const neutralComment = plainComment || assumptionMemo;
    e.preventDefault();
    if (mediaBusy || (editingId && !editingEntry)) return;
    if (neutralComment && !hasDraftContent) return;
    if (replyContext && !hasDraftContent) return;
    if ((addTodo || addSmall) && !text.trim()) return;
    const convertTodo = !!editingTodo && addSmall && !neutralComment;
    const preview = convertTodo ? convertProgressTodoToSmall(task, editingTodo.id, conversionParentId) : null;
    if (preview?.error) return;
    if (editedReplyChanged && editedReply && (!findProgressReplySource(task, editedReply) || progressReplyWouldCycle(task, editingId, editedReply))) return;
    if (addSmall && selected.length !== 1) return;
    if (smallTarget && !targetSmall && !editingId && !replyTo) return;
    if (!hasDraftContent && !waiting) return;
    const commentText = text.trim() || (images.length || links.length ? '' : '相手待ちにしました。');
    const newId = addTodo || addSmall ? createProgressId() : null;
    onUpdateTask(task.id, previous => {
      const original = editingId ? (previous.progressHistory || []).find(entry => entry.id === editingId && entry.kind === 'comment') : null;
      if (editingId && !original) return previous;
      const replySourceQuote = replyTo || (editedReplyChanged ? editedReply : null);
      const replySource = replySourceQuote ? findProgressReplySource(previous, replySourceQuote) : null;
      if (replySourceQuote && (!replySource || progressReplyWouldCycle(previous, editingId, replySource))) return previous;
      if (convertTodo) {
        const timestamp = new Date().toISOString(), trimStart = text.length - text.trimStart().length;
        const edited = { ...original, text: commentText, editedAt: timestamp,
          textFormats: progressSliceFormats(text,textFormats,trimStart,text.trimEnd().length),
          textLinks: progressTextLinks(text, textLinks).filter(link => link.start >= trimStart && link.end <= text.trimEnd().length).map(link => ({ ...link, start: link.start - trimStart, end: link.end - trimStart })),
          images: images.map(image => ({ ...image })), links: links.map(link => ({ ...link })), plainComment, assumptionMemo,
          isConclusion: isConclusion && hasDraftContent, status: editingStatusChanged ? waiting ? 'waiting' : 'active' : original.status,
          quote: editedReplyChanged ? replySource ? createProgressQuote(replySource) : null : original.quote };
        let base = previous;
        if (original.status === 'completed' && editingStatusChanged && edited.status !== 'completed') base = retractProgressCompletion(base, original, waiting);
        if (editingStatusChanged) base = { ...base, subtasks: getProgressSubtasks(base).map(st => st.id === editingTodo.id ? { ...st, waiting } : st) };
        const converted = convertProgressTodoToSmall(base, editingTodo.id, conversionParentId, { title: text.trim(), origin: edited }).task;
        return converted ? editedReplyChanged ? syncEditedProgressReply(converted, edited.id) : converted : previous;
      }
      const previousSubtasks = getProgressSubtasks(previous);
      const existingTodo = original?.addedSubtask && !original.smallTaskId && original.subtaskIds?.length === 1 ? previousSubtasks.find(st => st.id === original.subtaskIds[0]) : null;
      const existingSmall = original?.addedSmallTask ? previousSubtasks.flatMap(getProgressSmallTasks).find(small => small.id === original.smallTaskId) : null;
      const addedId = addTodo && existingTodo ? existingTodo.id : addSmall && existingSmall ? existingSmall.id : newId;
      const currentSelected = previousSubtasks.filter(st => selectedIds.includes(st.id));
      if (addSmall && currentSelected.length !== 1) return previous;
      const currentTargetParent = previousSubtasks.find(st => st.id === smallTarget?.subtaskId);
      const currentTarget = getProgressSmallTasks(currentTargetParent).find(small => small.id === smallTarget?.smallTaskId);
      if (smallTarget && !currentTarget && !original && !replySource) return previous;
      const desiredStatus = neutralComment ? 'note' : waiting ? 'waiting' : 'active';
      const sameSelection = original && [...(original.subtaskIds || [])].sort().join('\0') === [...selectedIds].sort().join('\0');
      const sameReplySelection = replySource && [...(replySource.subtaskIds || [])].sort().join('\0') === [...selectedIds].sort().join('\0');
      // Editing just the message must not replay an old status over later work.
      // Changed checkboxes apply to the currently selected targets, without
      // rewinding the state of targets that were removed from the selection.
      const sameTarget = original && (original.smallTaskId || null) === (smallTarget?.smallTaskId || null);
      const status = original && !editingStatusChanged && ((sameSelection && sameTarget) || editedReplyChanged) ? original.status || 'active' : desiredStatus;
      const addingInReply = !!replySource && (addTodo || addSmall);
      const applyStatus = !addingInReply && !neutralComment && !addSmall && !addTodo && (editingStatusChanged || !original || !sameSelection || !sameTarget);
      // Only an actual waiting reply (or an explicit status edit) clears a wait.
      const clearsWaiting = replySource?.status === 'waiting' || (original?.status === 'waiting' && editingStatusChanged);
      const updateStatus = item => ({ ...item, waiting: waiting ? true : clearsWaiting ? false : !!item.waiting });
      let nextSubtasks = previousSubtasks.map(st => {
        if (addTodo && existingTodo?.id === st.id) return { ...(editingStatusChanged ? updateStatus(st) : st), title: text.trim(), dueDate: dueDate || previous.dueDate || '' };
        if (addSmall && st.id === currentSelected[0].id) return { ...st, smallTasks: existingSmall
          ? getProgressSmallTasks(st).map(small => small.id === existingSmall.id ? { ...(editingStatusChanged ? updateStatus(small) : small), title: text.trim() } : small)
          : [...getProgressSmallTasks(st), { id: addedId, title: text.trim(), completed: false, waiting: !addingInReply && waiting }] };
        if (smallTarget) {
          if (!applyStatus || st.id !== smallTarget.subtaskId || !currentTarget) return st;
          return { ...st, smallTasks: getProgressSmallTasks(st).map(small => small.id === smallTarget.smallTaskId ? updateStatus(small) : small) };
        }
        if (!applyStatus || !selectedIds.includes(st.id)) return st;
        return updateStatus(st);
      });
      if (addTodo && !existingTodo) nextSubtasks.push({ id: addedId, title: text.trim(), dueDate: dueDate || previous.dueDate || '', completed: false, waiting: !addingInReply && waiting, order: Date.now() });
      if (addTodo && !existingTodo) {
        const source = filterSmallId && scopeParent ? { kind: 'small', parentId: scopeParent.id, id: filterSmallId }
          : filterId ? { kind: 'subtask', id: filterId } : null;
        nextSubtasks = addProgressTodoDependency(nextSubtasks, source, { id: addedId, title: text.trim() });
      }
      const timestamp = new Date().toISOString();
      const trimStart = text.length - text.trimStart().length;
      const prefix = addTodo ? progressTodoOriginText('', dueDate || previous.dueDate).indexOf('【') + 1 : 0;
      const savedTextLinks = progressTextLinks(text, textLinks).filter(link => link.start >= trimStart && link.end <= text.trimEnd().length)
        .map(link => ({ ...link, start: link.start - trimStart + prefix, end: link.end - trimStart + prefix }));
      const entry = { ...(original || {}), id: original?.id || createProgressId(), kind: 'comment', createdAt: original?.createdAt || timestamp,
        ...(original ? { editedAt: timestamp } : {}), text: addTodo ? progressTodoOriginText(text.trim(), dueDate || previous.dueDate) : commentText,
        ...(savedTextLinks.length || original?.textLinks ? { textLinks: savedTextLinks } : {}),
        textFormats: progressSliceFormats(text,textFormats,trimStart,text.trimEnd().length,prefix),
        ...(images.length || original?.images ? { images: images.map(image => ({ ...image })) } : {}),
        ...(links.length || original?.links ? { links: links.map(link => ({ ...link })) } : {}),
        subtaskIds: addTodo ? [addedId] : sameSelection ? original.subtaskIds : sameReplySelection ? replySource.subtaskIds : currentSelected.map(st => st.id),
        subtaskTitles: addTodo ? [text.trim()] : sameSelection ? original.subtaskTitles : sameReplySelection ? replySource.subtaskTitles : currentSelected.map(st => st.title), status, plainComment, assumptionMemo,
        addedSubtask: addTodo || !!(!addSmall && original?.addedSubtask && sameSelection && sameTarget),
        ...(addTodo ? { dueDate: dueDate || previous.dueDate || '' } : {}),
        smallTaskId: addSmall ? addedId : smallTarget?.smallTaskId,
        smallTaskTitle: addSmall ? text.trim() : sameTarget ? original.smallTaskTitle : currentTarget?.title || smallTarget?.title,
        addedSmallTask: !neutralComment && (addSmall || !!(original?.addedSmallTask && sameSelection && sameTarget)),
        quote: editedReplyChanged ? replySource ? createProgressQuote(replySource) : null : replySource ? createProgressQuote(replySource) : original?.quote };
      if (isConclusion || original?.isConclusion !== undefined) entry.isConclusion = isConclusion && hasDraftContent;
      if (entry.isConclusion) entry.conclusionTarget = progressConclusionTarget({ ...entry,
        conclusionTarget: sameSelection && sameTarget ? original?.conclusionTarget : undefined });
      let progressHistory = previous.progressHistory || [];
      if (original) progressHistory = progressHistory.filter(item => item.id !== original.id);

      // Keep an edited ordinary message in its original place in the timeline.
      progressHistory = original
        ? (previous.progressHistory || []).map(item => item.id === original.id ? entry : item)
        : [...progressHistory, entry];
      if (!neutralComment && replySource?.status === 'waiting') {
        entry.quote = { ...entry.quote, resolvedByReplyId: entry.id };
        progressHistory = progressHistory.map(item => item.id === replySource.id ? { ...item, resolvedByReplyId: item.resolvedByReplyId || entry.id } : item);
      }
      // The reply updates the source's wait; added work starts independently.
      if (addingInReply && !neutralComment) {
        nextSubtasks.forEach((st, index) => {
          if (!replySource.subtaskIds?.includes(st.id)) return;
          nextSubtasks[index] = replySource.smallTaskId
            ? { ...st, smallTasks: getProgressSmallTasks(st).map(small => small.id === replySource.smallTaskId ? updateStatus(small) : small) }
            : updateStatus(st);
        });
      }
      let updated = { ...previous, subtasks: nextSubtasks,
        ...(addingInReply && !neutralComment && !replySource.smallTaskId && !replySource.subtaskIds?.length ? { waiting: updateStatus(previous).waiting } : {}),
        ...(applyStatus && !smallTarget && !selectedIds.length ? { waiting: updateStatus(previous).waiting } : {}), progressHistory };
      if (original && (editedReplyChanged || (original.quote && progressEntryIsNote(original) !== neutralComment))) updated = syncEditedProgressReply(updated, entry.id);
      if (original?.status === 'completed' && editingStatusChanged && status !== 'completed') {
        return retractProgressCompletion(updated, original, !neutralComment && waiting);
      }
      return updated;
    });
    if (!editingId) followLatestRef.current = true;
    resetComposer();
    if (preview?.task) {
      setExpandedTodoIds(ids => [...new Set([...ids, preview.parentId])]);
      setExpandedSmallIds(ids => [...new Set([...ids, preview.smallId])]);
      if (filterId === editingTodo.id) chooseThreadScope(preview.parentId, filterSmallId || preview.smallId, true);
    }
  };
  const canSend = mediaBusy ? false : neutralComment && !hasDraftContent ? false : (replyContext && !hasDraftContent) || (replyTo && !findProgressReplySource(task, replyTo)) ? false
    : editedReplyChanged && editedReply && (!findProgressReplySource(task, editedReply) || progressReplyWouldCycle(task, editingId, editedReply)) ? false
    : smallTarget && !targetSmall && !editingId && !replyTo ? false
    : convertingTodo ? !!text.trim() && !conversionPreview?.error
    : addSmall ? !!text.trim() && selected.length === 1
    : addTodo ? !!text.trim() : hasDraftContent || waiting;
  const smallThreads = getProgressSmallThreads(task, history);
  const todoThreads = getProgressTodoThreads(task, history);
  const smallRows = (entries, parentId) => {
    const result = [], seen = new Set();
    entries.forEach(entry => {
      const own = smallThreads.get(entry.smallTaskId), target = smallThreads.get(entry.completedSmallTaskId);
      const group = !filterSmallId && (own?.parentId === parentId ? own : target?.parentId === parentId ? target : null);
      if (!group) result.push({ entry });
      else if (!seen.has(group.id)) { seen.add(group.id); result.push({ group }); }
    });
    smallThreads.forEach(group => {
      if (group.parentId === parentId && !seen.has(group.id)
        && (!query.trim() || (group.origin.smallTaskTitle || group.origin.text || '').toLowerCase().includes(query.trim().toLowerCase()))) result.push({ group });
    });
    return result;
  };
  const memoFirst = entries => [...entries].sort((a, b) => Number(!!b.assumptionMemo) - Number(!!a.assumptionMemo));
  const rows = [];
  const seenGroups = new Set();
  const otherEntries = visibleHistory.filter(entry => otherIds.has(entry.id));
  const groupOther = !filteringTalks && !filterId && !filterSmallId && !filterOther && todoThreads.size > 0;
  if (groupOther && (!query.trim() || otherEntries.length)) rows.push({ otherGroup: true });
  if (filteringTalks) rows.push(...visibleHistory.map(entry => ({ entry })));
  else if (filterId && !filterSmallId) rows.push(...smallRows(visibleHistory, filterId));
  else visibleHistory.forEach(entry => {
    const parentId = progressEntryParentIds(entry).find(id => todoThreads.has(id));
    const todoGroup = !filterSmallId && todoThreads.get(parentId);
    if (todoGroup) {
      if (!seenGroups.has(`todo:${todoGroup.id}`)) { seenGroups.add(`todo:${todoGroup.id}`); rows.push({ todoGroup }); }
    } else if (!groupOther || !otherIds.has(entry.id)) rows.push({ entry });
  });
  if (!filteringTalks && !filterId && !filterSmallId && !filterOther) todoThreads.forEach(group => {
    if (!seenGroups.has(`todo:${group.id}`) && (!filterId || group.id === filterId)
      && (!query.trim() || group.title.toLowerCase().includes(query.trim().toLowerCase()))) rows.push({ todoGroup: group });
  });
  const selectCommentTarget = (entry, event) => {
    if (editingId || event.target.closest('button,a,input,label,[contenteditable]')) return;
    event.stopPropagation();
    const parentId = entry.subtaskIds?.[0] || '';
    setSelectedIds(parentId ? [parentId] : []);
    const smallId = getProgressSmallTasks(subtasks.find(st => st.id === parentId)).some(small => small.id === entry.smallTaskId) ? entry.smallTaskId : null;
    setSmallTarget(scopeSmallTarget(parentId, smallId));
    setReplyTo(null); selectedEntryRef.current = { ...entry, smallTaskId: smallId }; setSelectedEntryId(entry.id);
  };
  const renderHistoryEntry = (entry, { extra = null, virtual = false, tone = null, synthetic = false } = {}) => <div key={entry.id} data-progress-entry-id={synthetic ? undefined : entry.id} tabIndex={0} onClick={e => selectCommentTarget(entry, e)} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); selectCommentTarget(entry, e); } }} aria-current={selectedEntryId === entry.id ? 'true' : undefined} className={`flex flex-col items-stretch ${selectedEntryId === entry.id ? 'ring-2 ring-slate-300 ring-offset-2 rounded-xl' : ''} ${highlightedId === entry.id ? 'ring-2 ring-blue-400 rounded-xl' : ''}`}>
        {Number.isFinite(Date.parse(entry.createdAt)) ? <time dateTime={entry.createdAt} className="text-[10px] text-gray-500 px-1 mb-1">{new Date(entry.createdAt).toLocaleString('ja-JP')}</time> : <span className="text-[10px] text-gray-500 px-1 mb-1">日時未記録</span>}
        <div className={`progress-talk-bubble w-full rounded-xl border px-3 py-2 text-sm shadow-sm ${tone ? progressToneClasses(tone) : progressEntryClasses(entry, task)}`}>
          <p className="text-[10px] font-bold text-gray-400 mb-1">{entry.kind === 'comment' ? (entry.assumptionMemo ? '前提メモ' : progressEntryIsNote(entry) ? 'コメント' : entry.addedSubtask ? 'やるべきことの追加' : entry.addedSmallTask ? '小さいタスクの追加' : '進捗記録') : '期限変更'}</p>
          {entry.quote && <ProgressQuote quote={entry.quote} onNavigate={navigateQuote} task={task}/>}
          <div className="whitespace-pre-wrap break-words"><ProgressText value={entry.text} textLinks={entry.textLinks} textFormats={entry.textFormats}/></div>
          <ProgressAttachments images={entry.images} links={entry.links}/>
          {entry.isConclusion && <p className="mt-1 text-xs font-bold">結論</p>}
          {progressEntrySubtaskTitles(task, entry).length > 0 && <div className="flex flex-wrap gap-1 mt-2">{progressEntrySubtaskTitles(task, entry).map((title, i) => <span key={`${entry.subtaskIds?.[i]}-${i}`} data-progress-subtask-label={entry.subtaskIds?.[i]} className="text-[10px] rounded px-1.5 py-0.5 bg-black/10 break-all">{title}</span>)}</div>}
          {entry.smallTaskTitle && <p className="mt-1 text-xs text-gray-500 break-words">小さいタスク: {entry.smallTaskTitle}</p>}
          {entry.status && !progressEntryIsNote(entry) && entry.kind === 'comment' && <p className="text-[10px] mt-1 opacity-80">{progressEntryLabel(entry, task, tone)}</p>}
          {!virtual && <div className="flex items-center justify-end gap-2 mt-2 text-[11px]">
            {entry.kind === 'comment' && <>
              {entry.editedAt && <span title={`編集日時: ${new Date(entry.editedAt).toLocaleString('ja-JP')}`}>編集済み</span>}
              <label className="flex items-center gap-1"><input type="checkbox" aria-label="このコメントを結論にする" checked={!!entry.isConclusion} onChange={e => toggleConclusion(entry, e.target.checked)}/>結論</label>
              <button type="button" aria-label={selectingReply ? `返信元に選択: ${entry.text || '本文なし'}` : 'コメントに返信'} disabled={selectingReply && progressReplyWouldCycle(task, editingId, entry)}
                title={selectingReply && progressReplyWouldCycle(task, editingId, entry) ? '自分自身・このコメントへの返信は選択できません' : undefined}
                onClick={() => { if (selectingReply) { chooseEditedReply(entry); setSelectingReply(false); } else replyToComment(entry); }} className="rounded px-2 py-1 text-blue-700 hover:bg-blue-50 underline disabled:opacity-40">{selectingReply ? '返信元にする' : '返信'}</button>
              <button type="button" aria-label="コメントを編集" onClick={() => editComment(entry)} className="rounded px-2 py-1 text-blue-700 hover:bg-blue-50 underline">編集</button>
            </>}
            <button type="button" aria-label="コメントを削除" title={entry.addedSubtask && !entry.smallTaskId ? '追加コメントと対応するやるべきことのカードを削除します。ほかのトーク・引用は保持します。' : entry.status === 'completed' && !progressEntryIsNote(entry) ? 'この完了記録を削除し、完了した対象を未完了に戻します。保存済みの引用は残ります。' : entry.addedSmallTask ? 'この追加コメントと、ひも付く小さいタスクを削除します。保存済みの引用は残ります。' : 'コメントだけを削除します。保存済みの引用は残ります。'} onClick={() => deleteComment(entry.id)} className="rounded px-2 py-1 text-red-700 hover:bg-red-50 underline">削除</button>
          </div>}
          {extra}
        </div>
      </div>;
  const renderConclusions = (group, kind) => group.conclusions.length > 0 && <section aria-label="結論のまとめ" className="space-y-2">
    <p className="text-xs font-bold">結論</p>
    <div data-small-task-conclusion={kind === 'small' ? group.id : undefined} data-todo-task-conclusion={kind === 'todo' ? group.id : undefined} className="whitespace-pre-wrap break-words">
      {group.conclusions.map((entry, index) => <React.Fragment key={entry.id}>{index > 0 && '\n'}<ProgressText value={entry.text} textLinks={entry.textLinks} textFormats={entry.textFormats}/><ProgressAttachments images={entry.images} links={entry.links}/></React.Fragment>)}
    </div>
    <div className="flex flex-wrap gap-3 text-xs">{group.conclusions.map((entry, index) => <button key={entry.id} type="button" onClick={() => editComment(entry)} className="underline">{group.conclusions.length === 1 ? '結論を編集' : `結論${index + 1}を編集`}</button>)}</div>
  </section>;
  const renderSmallRow = row => {
        if (!row.group) return renderHistoryEntry(row.entry, { virtual: row.virtual, synthetic: row.synthetic });
        const group = row.group;
        const expanded = expandedSmallIds.includes(group.id) || !!query.trim();
        const hiddenOrigin = !showEntry(group.origin);
        const separateWaitingOrigin = !group.completed && group.origin.status === 'waiting' && !!group.origin.resolvedByReplyId;
        const summaryOrigin = hiddenOrigin || separateWaitingOrigin;
        const origin = summaryOrigin ? { ...group.origin, id: `small-summary:${group.id}`, text: group.origin.smallTaskTitle || '小さいタスク', images: [], links: [], quote: null } : group.origin;
        const entries = group.entries.filter(showEntry);
        if (separateWaitingOrigin && !hiddenOrigin) entries.unshift(group.origin);
        return <div key={`completed-thread:${group.id}`} data-small-thread-id={group.id} data-completed-small-task-id={group.completed ? group.id : undefined} className="rounded-xl">
          {renderHistoryEntry(origin, { virtual: group.virtual || summaryOrigin, synthetic: group.virtual || summaryOrigin, tone: progressStatusTone(group.status), extra: <div className="mt-3 border-t border-black pt-3 space-y-2">
            {renderConclusions(group, 'small')}
            <div className="flex gap-3 flex-wrap text-xs">
              <button type="button" aria-label={`${group.origin.smallTaskTitle || group.origin.text}の${group.completed ? '完了済み' : ''}トークを${expanded ? '折りたたむ' : '展開'}`} aria-expanded={expanded} aria-controls={`completed-talks-${group.id}`}
                onClick={() => { if (query.trim()) setQuery(''); setExpandedSmallIds(ids => expanded ? ids.filter(id => id !== group.id) : [...ids, group.id]); }} className="rounded-lg border border-black px-3 py-1.5 font-bold">{expanded ? '履歴を折りたたむ' : '履歴を展開'}（{entries.length}件）</button>
            </div>
          </div> })}
          {expanded && <div id={`completed-talks-${group.id}`} data-small-talks={group.id} data-completed-small-talks={group.completed ? group.id : undefined} className="border-l border-slate-300 pl-3 space-y-3 mt-3">
            {entries.length ? memoFirst(entries).map(entry => renderHistoryEntry(entry)) : <p className="text-xs text-blue-700">追加後のトークはありません。</p>}
          </div>}
        </div>;
  };
  const renderRow = row => {
    if (row.otherGroup) {
      const expanded = otherExpanded || !!query.trim();
      return <section key="other-talks" aria-label="その他のトークカード" data-other-thread-id={task.id} className="rounded-xl border border-black bg-white p-3 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <button type="button" aria-label="その他のトークだけを表示" onClick={chooseOtherScope} className="flex items-center gap-2 text-left font-bold text-sm hover:underline"><MessageSquare size={16}/>その他のトーク</button>
          <span className="text-xs text-gray-500">{otherEntries.length}件</span>
        </div>
        <p className="mt-1 text-xs text-gray-500">やるべきことに属さないトーク</p>
        <button type="button" aria-label={`その他のトークを${expanded ? '折りたたむ' : '展開'}`} aria-expanded={expanded} aria-controls={`other-talks-${task.id}`} onClick={() => { if (query.trim()) setQuery(''); setOtherExpanded(!expanded); }} className="mt-3 rounded-lg border border-black px-3 py-1.5 text-xs font-bold">{expanded ? '履歴を折りたたむ' : '履歴を展開'}</button>
        {expanded && <div id={`other-talks-${task.id}`} data-other-talks={task.id} className="mt-3 border-l border-slate-300 pl-3 space-y-3">
          {otherEntries.length ? memoFirst(otherEntries).map(entry => renderHistoryEntry(entry)) : <p className="text-xs text-gray-500">その他のトークはまだありません。</p>}
        </div>}
      </section>;
    }
    if (!row.todoGroup) return renderSmallRow(row);
    const group = row.todoGroup;
    const expanded = expandedTodoIds.includes(group.id) || !!query.trim() || (!!group.virtual && !collapsedTodoIds.includes(group.id));
    const status = task.completed ? 'completed' : group.subtask ? progressItemStatus(group.subtask, task)
      : group.origin.status === 'completed' ? 'completed' : group.origin.status === 'waiting' ? 'waiting' : 'active';
    const tone = progressStatusTone(status);
    const title = group.subtask?.title || group.origin.subtaskTitles?.[0] || 'やるべきこと';
    const hiddenOrigin = !showEntry(group.origin);
    const origin = { ...group.origin, ...(hiddenOrigin ? { id: `todo-summary:${group.id}`, images: [], links: [], quote: null } : {}), text: group.title };
    const entries = group.entries.filter(showEntry).filter(entry => !query.trim() || visibleHistory.some(item => item.id === entry.id));
    const childRows = smallRows(memoFirst(entries), group.id);
    return <div key={`todo-thread:${group.id}`} data-todo-thread-id={group.id} className="rounded-xl">
      {renderHistoryEntry(origin, { virtual: group.virtual || hiddenOrigin, synthetic: group.virtual, tone, extra: <div className="mt-3 pt-3 border-t border-black space-y-2">
        {renderConclusions(group, 'todo')}
        <button type="button" aria-label={`${title}のトークを${expanded ? '折りたたむ' : '展開'}`} aria-expanded={expanded} aria-controls={`todo-talks-${group.id}`}
          onClick={() => { if (query.trim()) setQuery(''); setExpandedTodoIds(ids => expanded ? ids.filter(id => id !== group.id) : [...ids, group.id]); setCollapsedTodoIds(ids => expanded ? [...new Set([...ids, group.id])] : ids.filter(id => id !== group.id)); }}
          className="rounded-lg border border-black px-3 py-1.5 text-xs font-bold">{expanded ? '履歴を折りたたむ' : '履歴を展開'}（{entries.length}件）</button>
      </div> })}
      {expanded && <div id={`todo-talks-${group.id}`} data-todo-talks={group.id} className="border-l border-slate-300 pl-3 mt-3 space-y-3">
        {childRows.length ? childRows.map(renderSmallRow) : <p className="text-xs opacity-70">追加後のトークはありません。</p>}
      </div>}
    </div>;
  };
  const threadTitle = filterOther ? 'その他のトーク' : filterSmallId ? scopeSmall?.title || smallThreads.get(filterSmallId)?.origin.smallTaskTitle || '小さいタスク'
    : filterId ? scopeParent?.title || todoThreads.get(filterId)?.origin.subtaskTitles?.[0] || 'やるべきこと' : task.title;
  const completionHint = scopeSmall?.waiting ? '相手待ちを解除すると完了できます。'
    : scopeDependencies.length ? `タスク待ち: ${scopeDependencies.map(ref => progressDependencyTitle(task, ref)).join('、')}` : '';
  const draftTargetTitle = smallTarget?.title || selected.map(st => st.title).join('、') || (filterOther ? 'その他のトーク' : task.title);
  const tableOnly = expandedComposer && tableView;
  const sideComposer = expandedComposer && !tableView;
  return <div className={`${sideComposer ? 'grid gap-4' : 'flex flex-col'} flex-1 min-h-0 min-w-0`} style={sideComposer ? { gridTemplateColumns: 'minmax(380px, 1fr) minmax(380px, 1.2fr)', gridTemplateRows: 'minmax(0, 1fr)' } : undefined} data-progress-thread="">
    <section aria-label="トーク履歴ボード" className={`flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden ${expandedComposer ? 'rounded-2xl border bg-white' : ''}`}>
    <header aria-label="トーク操作" className="flex items-center gap-2 px-3 py-2 border-b bg-white shrink-0 min-w-0">
      <h2 className="text-sm font-black shrink-0">進捗リストボード</h2>
      <label className="flex items-center gap-1 min-w-0 flex-1 border rounded-lg px-2 bg-gray-50"><Search size={13} className="text-gray-400 shrink-0"/><input aria-label="履歴を検索" placeholder="検索" value={query} onChange={e => setQuery(e.target.value)} className="py-1.5 text-xs bg-transparent min-w-0 w-full outline-none"/></label>
      <div className="flex gap-1 shrink-0">
        <button type="button" aria-label="トークの一番上へ" title="一番上へ" onClick={() => scrollHistory(false)} className="rounded-lg border p-1.5 text-slate-500 hover:bg-slate-50"><ChevronDown size={14} className="rotate-180"/></button>
        <button type="button" aria-label="トークの一番下へ" title="一番下へ" onClick={() => scrollHistory(true)} className="rounded-lg border p-1.5 text-slate-500 hover:bg-slate-50"><ChevronDown size={14}/></button>
      </div>
      <details className="relative shrink-0 text-xs"><summary aria-label="送信ショートカットの説明" className="cursor-pointer text-blue-700">キー操作</summary>
        <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-lg border border-black bg-white p-3 shadow-lg text-gray-900">
          <p className="font-bold mb-2">入力欄の送信ショートカット</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
            {[['Enter', '改行'], ['Ctrl+Enter', '現在のチェック内容で送信'], ['Alt+Enter', '相手待ちで送信'], ['Shift+Enter', 'ただのコメントで送信'], ['Ctrl+Shift+Enter', '小さいタスクを追加'], ['Ctrl+Alt+Enter', 'やるべきことを追加'], ['Ctrl+Shift+Alt+Enter', '前提メモで送信']].map(([keys, action]) => <React.Fragment key={keys}><dt><kbd>{keys}</kbd></dt><dd>{action}</dd></React.Fragment>)}
          </dl>
          <p className="mt-2 text-[10px] text-gray-600">小さいタスクの追加は親を選択してから使用できます。変換中は送信しません。</p>
        </div>
      </details>
      {scopeSmall && <button type="button" aria-label={scopeSmall.completed ? `${scopeSmall.title}の完了を取り消す` : `${scopeSmall.title}を完了`}
        title={completionHint || (scopeSmall.completed ? '完了を取り消す' : '小さいタスクを完了')}
        disabled={!scopeSmall.completed && (scopeSmall.waiting || scopeDependencies.length > 0)} onClick={toggleSmallCompletion}
        className="shrink-0 rounded-lg bg-blue-600 px-2 py-1.5 text-xs text-white font-bold disabled:opacity-40">{scopeSmall.completed ? '完了を取り消す' : '完了'}</button>}
    </header>
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-white shrink-0 min-w-0">
      <div aria-label="トークのタイトル" className="min-w-0 flex-1"><h3 className="text-sm font-bold text-gray-900 truncate" title={threadTitle}>{threadTitle}</h3></div>
    <div role="group" aria-label="進捗リストの表示切替" className="flex gap-1 shrink-0 text-xs">
      {!tableView && <details data-talk-filters className="relative" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}>
        <summary aria-label="トークの絞り込みを開閉" className={`flex cursor-pointer list-none items-center gap-1 rounded border px-2 py-0.5 ${filteringTalks ? 'bg-blue-50 text-blue-700' : ''}`}><Filter size={12}/>絞り込み{filteringTalks && <span aria-label="絞り込み中" className="h-1.5 w-1.5 rounded-full bg-blue-600"/>}</summary>
        <div role="group" aria-label="トークの絞り込み" className="absolute right-0 top-full z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border bg-white p-3 shadow-lg space-y-3">
          <label className="flex items-center gap-2">内容<select aria-label="トークの内容で絞り込み" value={talkType} onChange={e => setTalkType(e.target.value)} className="min-w-0 flex-1 rounded border bg-white px-2 py-1">{progressTalkTypes.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="flex items-center gap-2">ステータス<select aria-label="トークのステータスで絞り込み" value={talkStatus} onChange={e => setTalkStatus(e.target.value)} className="min-w-0 flex-1 rounded border bg-white px-2 py-1">{progressTalkStatuses.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <div className="flex flex-wrap justify-between gap-2"><span role="status" aria-label="絞り込み対象のトーク件数" className="text-gray-500">{visibleHistory.length}件</span>
            {filteringTalks && <button type="button" onClick={() => { setTalkType('all'); setTalkStatus('all'); }} className="text-blue-700 underline">種類・ステータスを解除</button>}
          </div>
        </div>
      </details>}
      <button type="button" aria-pressed={!tableView} onClick={() => onTableViewChange(false)} className={`rounded border px-2 py-0.5 ${!tableView ? 'bg-blue-50 text-blue-700' : ''}`}>トーク表示</button>
      <button type="button" aria-pressed={tableView} onClick={() => { if (filterOther) chooseThreadScope(); else if (filterSmallId) chooseThreadScope(scopeParent?.id || '', ''); setSelectingReply(false); onTableViewChange(true); }} className={`rounded border px-2 py-0.5 ${tableView ? 'bg-blue-50 text-blue-700' : ''}`}>テーブル表示</button>
    </div>
    </div>
    <ProgressSummaryTable active={tableView} task={task} parentId={filterId} query={query} onUpdateTask={onUpdateTask} onNavigate={entry => { onTableViewChange(false); navigateQuote(entry); }}/>
    {selectingReply && <section aria-label="返信元の選択" className="shrink-0 flex flex-wrap items-center gap-2 border-b bg-blue-50 px-3 py-2 text-xs text-blue-800"><p className="flex-1">表示中のトークの「返信元にする」を押してください。</p><button type="button" className="rounded border bg-white px-2 py-1" onClick={() => setSelectingReply(false)}>選択を終了</button></section>}
    <div ref={historyRef} role="log" aria-label="進捗履歴" onScroll={e => { const el = e.currentTarget; if (el.scrollHeight - el.clientHeight - el.scrollTop <= 8) followLatestRef.current = true; }} onWheel={e => { if (e.deltaY < 0) followLatestRef.current = false; }} onPointerDown={() => { followLatestRef.current = false; }} onTouchStart={() => { followLatestRef.current = false; }} onKeyDown={e => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) followLatestRef.current = false; }} onLoadCapture={() => { if (followLatestRef.current && allowFollowRef.current) scrollHistory(true); }} className={`${tableView ? 'hidden' : ''} flex-1 overflow-y-auto min-h-0 p-4 bg-slate-100`}>
      <div ref={historyContentRef} className="space-y-4">
      {!rows.length && <p className="text-center text-sm text-gray-400 py-8">{filteringTalks ? '条件に一致するトークはありません。' : query.trim() ? '一致する履歴はありません。' : 'この範囲のコメントはまだありません。'}</p>}
      {[...rows].sort((a, b) => Number(!!b.entry?.assumptionMemo) - Number(!!a.entry?.assumptionMemo)).map(renderRow)}
      </div>
    </div>
    </section>
    <form aria-label="トーク送信" onSubmit={send} onKeyDown={e => {
      if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.target === composerRef.current && (e.ctrlKey || e.altKey || e.shiftKey)) {
        e.preventDefault();
        const mode = e.ctrlKey && e.shiftKey && e.altKey ? 'premise' : e.ctrlKey && e.shiftKey ? 'small' : e.ctrlKey && e.altKey ? 'todo' : e.altKey ? 'waiting' : e.shiftKey ? 'plain' : null;
        send(e, mode);
      }
      if (e.key === 'Escape' && (editingId || replyTo) && !e.nativeEvent.isComposing) { e.preventDefault(); resetComposer(); }
    }} hidden={tableOnly} className={`px-3 py-2 bg-white space-y-2 ${tableOnly ? 'hidden' : expandedComposer ? 'flex flex-col min-h-0 min-w-0 rounded-2xl border overflow-y-auto' : 'border-t shrink-0 max-h-[45%] overflow-y-auto'}`}>
      {expandedComposer && <header aria-label="コメント入力パネル" className="shrink-0 border-b pb-2"><h2 className="text-sm font-black">コメント入力</h2><p className="mt-1 truncate text-xs text-gray-600" title={draftTargetTitle}>{draftTargetTitle}</p></header>}
      {!editingId && selectedEntryId && <div role="status" aria-label="コメントの送信先" className="flex items-center gap-2 text-xs font-bold"><span className="flex-1 truncate">送信先: {draftTargetTitle}</span><button type="button" className="underline" onClick={() => chooseThreadScope(filterId, filterSmallId, true)}>表示中の範囲に戻す</button></div>}
      {editingId && <div className="flex items-center gap-2 text-xs text-blue-700"><p role="status" className="flex-1 truncate" title={draftTargetTitle}>編集中: {draftTargetTitle}</p><button type="button" onClick={resetComposer} className="shrink-0 underline">編集をキャンセル</button></div>}
      {editingId && <div className="flex flex-wrap items-center gap-3 text-xs text-blue-700"><button type="button" onClick={() => { onTableViewChange(false); setSelectingReply(value => !value); }} className="underline">返信元を変更</button>{replyContext && <button type="button" onClick={() => chooseEditedReply(null)} className="underline">返信を解除</button>}</div>}
      {replyContext && <section role="region" aria-label="返信先" className="max-h-24 overflow-y-auto rounded-lg border border-black px-2 py-1 text-xs">
        <ProgressQuote quote={replyContext} onNavigate={navigateQuote} task={task}/>
        {replyTo && <button type="button" aria-label="返信をキャンセル" onClick={() => { setReplyTo(null); setSelectedIds(filterId ? [filterId] : []); setSmallTarget(scopeSmallTarget(filterId, filterSmallId)); setWaiting(false); if (!filterId) setAddSmall(false); }} className="text-blue-700 underline">返信をキャンセル</button>}
      </section>}
      {editedReplyChanged && editedReply && !findProgressReplySource(task, editedReply) && <p role="alert" className="text-xs text-red-700">選択した返信元が削除されています。返信元を選び直すか、返信を解除してください。</p>}
      {smallTarget && !targetSmall && <p className="text-xs text-gray-500">対象は削除されています。保存済みコメントの編集・返信ができます。</p>}
      <div role="group" aria-label="送信オプション" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <label className="inline-flex items-center gap-1 whitespace-nowrap" title="本文をやるべきこととして追加"><input type="checkbox" disabled={neutralComment} checked={addTodo} onChange={e => { setAddTodo(e.target.checked); if (e.target.checked) { setAddSmall(false); setSmallTarget(null); } else restoreComposerTarget(); }}/>やるべきことの追加</label>
        <label className="inline-flex items-center gap-1 whitespace-nowrap" title={editingTodo ? 'このやるべきことを小さいタスクへ変換' : selected.length === 1 ? `「${selected[0].title}」に追加` : 'やるべきことを開くと追加できます'}><input type="checkbox" disabled={neutralComment || (!editingTodo && selected.length !== 1)} checked={addSmall} onChange={e => { setAddSmall(e.target.checked); if (e.target.checked) { setAddTodo(false); setSmallTarget(null); } else restoreComposerTarget(); }}/>小さいタスクの追加</label>
        <label className="inline-flex items-center gap-1 whitespace-nowrap"><input type="checkbox" disabled={neutralComment} checked={waiting} onChange={e => { setEditingStatusChanged(true); setWaiting(e.target.checked); }}/>相手待ち</label>
        <label className="inline-flex items-center gap-1 whitespace-nowrap" title="折りたたみ時に表示する結論として残します"><input type="checkbox" checked={isConclusion} onChange={e => setIsConclusion(e.target.checked)}/>結論</label>
        <label className="inline-flex items-center gap-1 whitespace-nowrap"><input type="checkbox" checked={plainComment} onChange={e => { setEditingStatusChanged(true); setPlainComment(e.target.checked); setAssumptionMemo(false); if (e.target.checked) { setWaiting(false); setAddTodo(false); setAddSmall(false); restoreComposerTarget(); } }}/>ただのコメント</label>
        <label className="inline-flex items-center gap-1 whitespace-nowrap" title="レポートの背景・前提情報として残します"><input type="checkbox" checked={assumptionMemo} onChange={e => { setEditingStatusChanged(true); setAssumptionMemo(e.target.checked); setPlainComment(false); if (e.target.checked) { setWaiting(false); setAddTodo(false); setAddSmall(false); restoreComposerTarget(); } }}/>前提メモ</label>
      </div>
      {convertingTodo && <div className="space-y-1 rounded-lg border bg-slate-50 p-2 text-xs">
        <label className="flex items-center gap-2">変換先のやるべきこと<select aria-label="変換先のやるべきこと" value={conversionParentId} onChange={event => setConversionParentId(event.target.value)} className="min-w-0 flex-1 rounded border bg-white px-2 py-1">
          <option value="">選択してください</option>{conversionParents.map(st => <option key={st.id} value={st.id}>{st.title}</option>)}
        </select></label>
        <p className="text-slate-600">元のカードを小さいタスクへ変換し、トーク履歴・添付・完了状態を引き継ぎます。{getProgressSmallTasks(editingTodo).length > 0 ? '既存の小さいタスクも、同じ変換先へ移します。' : ''}</p>
        {conversionPreview?.error && <p role="alert" className="text-red-700">{conversionParents.length ? conversionPreview.error : '変換先になる別のやるべきことを、先に追加してください。'}</p>}
      </div>}
      {addTodo && <label className="flex items-center gap-2 text-xs text-gray-600">追加するやるべきことの期限<input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="border rounded-md px-2 py-1 min-w-0" title={`未入力時: ${task.dueDate || '期限なし'}`}/></label>}
      <div className={`${expandedComposer ? 'flex-col flex-1 min-h-48 items-stretch' : 'items-end'} flex gap-2`}>
        <div className={`${expandedComposer ? 'flex flex-col min-h-0' : ''} flex-1 min-w-0 rounded-xl border focus-within:ring-2 focus-within:ring-blue-400`}>
          <ProgressComposer text={text} textLinks={textLinks} textFormats={textFormats} onChange={draft => { setText(draft.text); setTextLinks(draft.textLinks || []); setTextFormats(draft.textFormats || []); }}
            onPasteImages={addImages} editorRef={composerRef} editing={!!editingId} expanded={expandedComposer}/>
          {(images.length > 0 || links.length > 0) && <div className="px-2 pb-2" aria-label="本文の添付プレビュー"><ProgressAttachments images={images} links={links} onRemoveImage={id => setImages(previous => previous.filter(image => image.id !== id))} onRemoveLink={id => setLinks(previous => previous.filter(link => link.id !== id))}/></div>}
        </div>
        <button type="submit" disabled={!canSend} className={`${expandedComposer ? 'self-end' : ''} shrink-0 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg px-3 py-2 text-xs font-bold`}>{editingId ? '編集を保存' : '送信'}</button>
      </div>
      {mediaBusy && <p role="status" className="text-xs text-gray-500">画像を読み込み中…</p>}
      {mediaError && <p role="alert" className="text-xs text-red-700">{mediaError}</p>}
    </form>
    {quoteDetail && <QuoteSourceModal quote={quoteDetail} task={task} onClose={() => setQuoteDetail(null)}/>}
  </div>;
};

class ProgressThreadBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Progress thread could not be displayed', error, info.componentStack); }
  componentDidUpdate(previous) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <div role="alert" className="p-4 space-y-3 text-sm">
      <p className="font-bold text-red-700">このトークを表示できませんでした。</p>
      <p>別のカードを選択できます。保存済みのデータは変更していません。</p>
      <details><summary className="cursor-pointer underline">エラーの詳細</summary><pre className="mt-2 whitespace-pre-wrap break-words rounded border bg-gray-50 p-2 select-text">{String(this.state.error?.message || this.state.error)}</pre></details>
      <button type="button" onClick={() => this.setState({ error: null })} className="rounded-lg border px-3 py-2">もう一度表示する</button>
    </div>;
  }
}

const ProgressPage = ({ tasks, onUpdateTask, onAddTask }) => {
  const [showResolvedWaiting, setShowResolvedWaiting] = useState(() => {
    try { return localStorage.getItem('taskmatrix.progress.resolvedWaiting') !== 'hide'; } catch { return true; }
  });
  const changeResolvedWaiting = value => {
    setShowResolvedWaiting(value !== 'hide');
    try { localStorage.setItem('taskmatrix.progress.resolvedWaiting', value); } catch { /* The current view still works when storage is unavailable. */ }
  };
  const [hideTodo, setHideTodo] = useState(() => { try { return localStorage.getItem('taskmatrix.progress.hideTodo') === 'true'; } catch { return false; } });
  const [tableView, setTableView] = useState(false);
  const [taskHome, setTaskHome] = useState(true);
  const toggleTodo = () => setHideTodo(previous => {
    const next = !previous; try { localStorage.setItem('taskmatrix.progress.hideTodo', String(next)); } catch { /* Keep the current session usable. */ }
    return next;
  });
  const [selectedId, setSelectedId] = useState(null);
  const doingListRef = useRef(null);
  const tileScrollTargetRef = useRef(null);
  React.useLayoutEffect(() => {
    if (taskHome || !tileScrollTargetRef.current) return;
    // Wait for detail cards to replace the tile grid, then move this board only.
    const frame = requestAnimationFrame(() => {
      const list = doingListRef.current;
      const card = list && [...list.querySelectorAll('[data-progress-task-id]')].find(item => item.dataset.progressTaskId === tileScrollTargetRef.current);
      if (card) {
        const padding = parseFloat(getComputedStyle(list).paddingTop) || 0;
        list.scrollTop += card.getBoundingClientRect().top - list.getBoundingClientRect().top - padding;
      }
      tileScrollTargetRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [taskHome, selectedId]);
  const [smallTaskTarget, setSmallTaskTarget] = useState(null);
  const [settings, setSettings] = useState(null);
  const [dependencyTarget, setDependencyTarget] = useState(null);
  const [waitingTarget, setWaitingTarget] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [boardQuery, setBoardQuery] = useState('');
  const [completionMonth, setCompletionMonth] = useState('');
  const [showCompletionPeriod, setShowCompletionPeriod] = useState(false);
  const tracked = tasks.filter(task => task.progressEnabled);
  const query = boardQuery.trim().toLowerCase();
  const boardMatches = task => !query || [task.title, task.memo, task.completionNote, task.richResult,
    ...(task.urls || []), ...getProgressSubtasks(task).flatMap(st => [st.title, ...getProgressSmallTasks(st).map(small => small.title)]),
    ...(task.progressHistory || []).flatMap(entry => [entry.text, progressQuoteSearchText(entry.quote),
      ...progressMediaItems(entry.images).map(image => image.name), ...progressMediaItems(entry.links).flatMap(link => [link.label, link.url]),
      ...progressMediaItems(entry.textLinks).map(link => link.url)])].filter(Boolean).join(' ').toLowerCase().includes(query);
  const selectedTask = tracked.find(task => task.id === selectedId);
  const settingsTask = tracked.find(task => task.id === settings?.id);
  const startTask = task => setSettings({ id: task.id, starting: true });
  const selectTask = task => { setTaskHome(false); setSelectedId(task.id); setSmallTaskTarget({ taskId: task.id, filterOnly: true, clearComposer: !(taskHome && task.id === selectedId), requestId: createProgressId() }); };
  const deleteSmallTask = (task, id) => {
    onUpdateTask(task.id, previous => removeProgressSmallTask(previous, id));
  };
  const filterThread = (task, subtaskId, smallTaskId, otherTalks = false) => {
    if (tableView && smallTaskId) return;
    if (otherTalks) setTableView(false);
    setTaskHome(false); setSelectedId(task.id);
    setSmallTaskTarget({ taskId: task.id, subtaskId, smallTaskId, otherTalks, filterOnly: true, requestId: createProgressId() });
  };
  const completeSubtask = (task, id) => {
    onUpdateTask(task.id, previous => {
      const parent = getProgressSubtasks(previous).find(st => st.id === id);
      if (!parent || parent.completed || progressCompletionBlocked(previous, parent)) return previous;
      const now = new Date().toISOString();
      return { ...previous, subtasks: getProgressSubtasks(previous).map(st => {
        if (st.id !== id) return st;
        const next = { ...st, completed: true, waiting: false, completedAt: now, completionManaged: true, completionSource: 'manual' };
        delete next.completionEntryId; delete next.completionConclusion;
        return next;
      }) };
    });
  };
  const completeTask = task => {
    onUpdateTask(task.id, previous => {
      if (!canCompleteProgressTask(previous)) return previous;
      const completed = { ...previous, completed: true, waiting: false, completedAt: new Date().toISOString(), completionManaged: true, completionSource: 'manual' };
      delete completed.completionEntryId; delete completed.completionConclusion;
      return completed;
    });
  };
  const reopenTask = task => onUpdateTask(task.id, previous => {
    if (!previous.completed) return previous;
    const reopened = { ...previous, completed: false };
    delete reopened.completedAt; delete reopened.completionEntryId; delete reopened.completionConclusion;
    return reopened;
  });
  const reorderSubtask = (taskId, sourceId, targetId, after) => {
    if (sourceId === targetId) return;
    onUpdateTask(taskId, previous => {
      const items = getProgressSubtasks(previous), source = items.find(st => st.id === sourceId);
      if (!source || !items.some(st => st.id === targetId)) return previous;
      const next = items.filter(st => st.id !== sourceId);
      next.splice(next.findIndex(st => st.id === targetId) + (after ? 1 : 0), 0, source);
      const orders = items.map(st => st.order).filter(Number.isFinite);
      const base = orders.length ? Math.min(...orders) : Date.now();
      return { ...previous, subtasks: next.map((st, index) => ({ ...st, order: base + index })) };
    });
  };
  const reorderSmallTask = (taskId, parentId, sourceId, targetId, after) => {
    if (sourceId === targetId) return;
    onUpdateTask(taskId, previous => ({ ...previous, subtasks: getProgressSubtasks(previous).map(st => {
      if (st.id !== parentId) return st;
      const items = getProgressSmallTasks(st), source = items.find(small => small.id === sourceId);
      if (!source || !items.some(small => small.id === targetId)) return st;
      const next = items.filter(small => small.id !== sourceId);
      next.splice(next.findIndex(small => small.id === targetId) + (after ? 1 : 0), 0, source);
      return { ...st, smallTasks: next.map((small, index) => ({ ...small, order: index + 1 })) };
    }) }));
  };
  const dropTask = (e, stage) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('application/x-taskmatrix-progress') || draggingId;
    const task = tracked.find(item => item.id === id);
    setDraggingId(null);
    if (!task || (task.progressStage || 'todo') === stage) return;
    if (stage === 'doing') startTask(task);
    else onUpdateTask(task.id, previous => ({ ...previous, progressStage: 'todo' }));
  };
  return <div className="h-full min-h-0 flex flex-col overflow-hidden" data-progress-page="">
    <style>{`
      [data-progress-page] *, [data-progress-page] *::before, [data-progress-page] *::after { border-color: #cbd5e1 !important; }
      [data-progress-page] [data-progress-task-id], [data-progress-page] [data-progress-subtask-id],
      [data-progress-page] [data-progress-small-task-id], [data-progress-page] .progress-talk-bubble { border-color: #64748b !important; }
      [data-progress-page] .progress-talk-bubble { box-shadow: 0 1px 3px rgba(15, 23, 42, .06); }
    `}</style>
    <div className="px-4 py-2 bg-white/70 border-b flex items-center justify-between gap-3 shrink-0">
      <label className="text-xs flex items-center gap-2">返信済みの相手待ち<select aria-label="返信済みの相手待ちの表示" value={showResolvedWaiting ? 'show' : 'hide'} onChange={e => changeResolvedWaiting(e.target.value)} className="border rounded-lg bg-white px-2 py-1.5"><option value="show">青色で残す</option><option value="hide">非表示</option></select></label>
      <button type="button" aria-label={hideTodo ? '未着手ボードを表示' : '未着手ボードを非表示'} aria-pressed={hideTodo} onClick={toggleTodo} className="rounded-lg border bg-white px-3 py-1.5 text-xs font-bold">{tableView ? hideTodo ? '通常の幅に戻す' : 'テーブルを拡大表示' : hideTodo ? '入力欄を下に戻す' : '入力欄を右に表示'}</button>
      <details className="relative text-xs shrink-0"><summary className="cursor-pointer text-gray-600">色の説明</summary>
        <div className="absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border bg-white p-3 shadow-lg space-y-3">
          <p className="text-gray-600">ボードのカードを選ぶと、その範囲のトークを表示・入力できます。</p>
          <div className="flex flex-wrap gap-3"><span className="text-purple-700">● 進行可能</span><span className="text-blue-700">● 完了・進捗トーク</span><span className="text-green-700">● 相手待ち</span><span className="text-yellow-700">● タスク待ち</span><span className="text-red-700">● 期限超過</span><span className="text-gray-600">● ただのコメント</span></div>
        </div>
      </details>
    </div>
    <div className="flex-1 min-h-0 overflow-x-auto p-4 md:p-6">
      <div className="grid gap-4 h-full min-h-0" style={{ gridTemplateColumns: hideTodo ? 'minmax(240px, 0.65fr) minmax(776px, 2.35fr)' : 'minmax(240px, 1fr) minmax(240px, 1fr) minmax(380px, 1.6fr)', minWidth: hideTodo ? 1040 : 920 }}>
        {[{ stage: 'todo', title: '未着手ボード' }, { stage: 'doing', title: '着手中ボード' }].filter(({ stage }) => !hideTodo || stage !== 'todo').map(({ stage, title }) => {
          const items = tracked.filter(task => stage === 'doing' && showCompleted
            ? task.completed && boardMatches(task) && (!completionMonth || (Number.isFinite(reportEntryDate(task.completedAt).getTime()) && formatDate(reportEntryDate(task.completedAt)).slice(0, 7) === completionMonth))
            : !task.completed && (task.progressStage || 'todo') === stage && (stage !== 'doing' || boardMatches(task)));
          if (stage === 'doing' && showCompleted) items.sort((a, b) => (reportEntryDate(b.completedAt).getTime() || 0) - (reportEntryDate(a.completedAt).getTime() || 0));
          return <section key={stage} aria-label={title} data-progress-stage={stage} onDragOver={e => { if (stage === 'doing' && showCompleted) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }} onDrop={e => { if (stage === 'doing' && showCompleted) { e.preventDefault(); return; } dropTask(e, stage); }} className={`rounded-2xl border flex flex-col min-h-0 overflow-hidden ${draggingId ? 'border-black bg-blue-50' : 'border-black bg-gray-50'}`}>
            <header className="p-4 border-b flex items-center justify-between bg-white shrink-0">{stage === 'doing' && <button type="button" aria-label="大タスクのホーム" title="大タスクのタイル表示に戻る" aria-pressed={taskHome} onClick={() => setTaskHome(true)} className="mr-2 rounded-lg border bg-white p-1.5 text-blue-700"><Home size={18}/></button>}<h2 className="text-sm font-black flex items-center gap-2">{title}<span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{items.length}</span></h2>{stage === 'todo' && <button onClick={onAddTask} aria-label="未着手タスクを追加" className="p-1.5 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100"><Plus size={18}/></button>}</header>
            {stage === 'doing' && <div className="shrink-0 border-b bg-white px-3 py-2 space-y-2">
              <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-bold">
                {[false, true].map(completed => <button type="button" key={String(completed)} aria-label={completed ? '完了済みタスクを表示' : '未完了タスクを表示'} aria-pressed={showCompleted === completed} onClick={() => setShowCompleted(completed)} className={`flex-1 rounded-md px-2 py-1.5 ${showCompleted === completed ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'}`}>{completed ? '完了済み' : '未完了'}</button>)}
              </div>
              <div className="flex items-center gap-1.5">
                <label className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border px-2 py-1.5"><Search size={13} className="shrink-0 text-slate-400"/><input aria-label="ボードのタスクを検索" placeholder="タスク・トークを検索" value={boardQuery} onChange={e => setBoardQuery(e.target.value)} className="min-w-0 w-full text-xs outline-none"/></label>
                <button type="button" aria-label="完了時期で絞り込み" title="完了した年月で絞り込み" disabled={!showCompleted} aria-expanded={showCompleted && showCompletionPeriod} aria-controls="progress-completion-period" onClick={() => setShowCompletionPeriod(value => !value)} className={`rounded-lg border p-2 disabled:opacity-30 ${completionMonth ? 'bg-blue-50 text-blue-700' : 'text-slate-500'}`}><CalendarDays size={16}/></button>
              </div>
              {showCompleted && showCompletionPeriod && <div id="progress-completion-period" className="space-y-1.5 rounded-lg border bg-slate-50 p-2 text-xs">
                <label className="flex flex-wrap items-center gap-1.5">完了した年月<input aria-label="完了した年月" type="month" value={completionMonth} onChange={e => setCompletionMonth(e.target.value)} className="min-w-0 rounded border bg-white px-2 py-1"/></label>
                <button type="button" disabled={!completionMonth} onClick={() => setCompletionMonth('')} className="underline text-slate-500 disabled:opacity-40">年月指定を解除</button>
              </div>}
            </div>}
            <div ref={stage === 'doing' ? doingListRef : undefined} className="overflow-y-auto p-3 space-y-3 flex-1 min-h-0">
              {stage === 'doing' && taskHome && <div aria-label="大タスクのタイル" className="grid grid-cols-2 gap-3">{items.map(task => <article key={task.id} data-progress-task-id={task.id} data-status={progressItemStatus(task)} className={`rounded-xl border shadow-sm ${progressStatusClasses(progressItemStatus(task))}`}><button type="button" aria-label={task.title} onClick={() => { tileScrollTargetRef.current = task.id; selectTask(task); }} className="min-h-28 w-full rounded-xl p-3 text-left hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500">
                <span className="block break-words text-sm font-bold">{task.title}</span><span className="mt-3 block text-xs">期限: {task.dueDate || '未設定'}</span>
              </button></article>)}</div>}
              {(stage === 'doing' && taskHome ? [] : items).map(task => <ProgressTaskCard key={task.id} task={task} tableView={tableView} selected={selectedId === task.id} onSelect={() => selectTask(task)} onSettings={() => setSettings({ id: task.id, starting: false })} onStart={() => startTask(task)} onCompleteTask={() => completeTask(task)} onReopenTask={() => reopenTask(task)} onDeleteSmallTask={id => deleteSmallTask(task, id)} onFilter={(subtaskId, smallTaskId) => filterThread(task, subtaskId, smallTaskId)} onOtherTalks={() => filterThread(task, '', '', true)} onReorderSmallTask={(parent, source, target, after) => reorderSmallTask(task.id, parent, source, target, after)} onReorderSubtask={(source, target, after) => reorderSubtask(task.id, source, target, after)} onCompleteSubtask={id => completeSubtask(task, id)} onDependency={target => setDependencyTarget({ taskId: task.id, ...target })} onWaiting={scope => setWaitingTarget({ taskId: task.id, scope })} onDragStart={(e, id) => { if (task.completed) { e.preventDefault(); return; } setDraggingId(id); e.dataTransfer.setData('application/x-taskmatrix-progress', id); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.addEventListener('dragend', () => setDraggingId(null), { once: true }); }}/>) }
              {!items.length && <p className="border-2 border-dashed border-black rounded-xl p-5 text-xs text-gray-400 text-center leading-relaxed">{stage === 'todo' ? 'ボードの「進捗ページに表示」にチェックするか、＋からタスクを追加してください。' : showCompleted || query ? '条件に一致するタスクはありません。' : '未着手のカードをここへドラッグするか、「着手する」を押してください。'}</p>}
            </div>
          </section>;
        })}
        <section aria-label="進捗リストボード" className={`${hideTodo && selectedTask ? '' : 'rounded-2xl border border-black bg-white overflow-hidden'} flex flex-col min-h-0 min-w-0`}>
          {!selectedTask && <header className="px-3 py-2 border-b shrink-0"><h2 className="text-sm font-black">進捗リストボード</h2></header>}
          {selectedTask ? <ProgressThreadBoundary key={selectedTask.id} resetKey={smallTaskTarget?.requestId}><ProgressThread task={selectedTask} onUpdateTask={onUpdateTask} smallTaskTarget={smallTaskTarget} showResolvedWaiting={showResolvedWaiting} expandedComposer={hideTodo} tableView={tableView} onTableViewChange={setTableView}/></ProgressThreadBoundary> : <div className="flex-1 flex flex-col items-center justify-center gap-3 text-gray-400 p-6 text-sm text-center"><List size={32}/><p>カードをクリックすると、<br/>進捗と変更履歴が表示されます。</p></div>}
        </section>
      </div>
    </div>
    {waitingTarget && tracked.some(task => task.id === waitingTarget.taskId) && <ProgressWaitingModal task={tracked.find(task => task.id === waitingTarget.taskId)} scope={waitingTarget.scope} onClose={() => setWaitingTarget(null)}/>}
    {dependencyTarget && tracked.some(task => task.id === dependencyTarget.taskId) && <ProgressDependencyModal key={`${dependencyTarget.taskId}-${progressDependencyKey(dependencyTarget)}`} task={tracked.find(task => task.id === dependencyTarget.taskId)} target={dependencyTarget} onClose={() => setDependencyTarget(null)} onSave={dependencies => {
      onUpdateTask(dependencyTarget.taskId, previous => {
        if (!getProgressDependencyNode(previous, dependencyTarget) || progressDependencyError(previous, dependencyTarget, dependencies)) return previous;
        return { ...previous, subtasks: getProgressSubtasks(previous).map(st => dependencyTarget.kind === 'subtask'
          ? st.id === dependencyTarget.id ? { ...st, dependencies } : st
          : st.id === dependencyTarget.parentId ? { ...st, smallTasks: getProgressSmallTasks(st).map(small => small.id === dependencyTarget.id ? { ...small, dependencies } : small) } : st) };
      }); setDependencyTarget(null);
    }}/>}
    {settingsTask && <ProgressSettingsModal key={`${settingsTask.id}-${settings.starting}`} task={settingsTask} starting={settings.starting} onClose={() => setSettings(null)} onSave={(patch, reason) => { onUpdateTask(settingsTask.id, previous => ({ ...previous, ...patch }), { reason }); if (settings.starting) { setTaskHome(false); setSelectedId(settingsTask.id); } setSettings(null); }}/>}
  </div>;
};

const reportDateIsValid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && formatDate(getLocalDate(value)) === value;
const reportEntryDate = value => value == null || value === '' ? new Date(NaN)
  : /^\d{4}-\d{2}-\d{2}$/.test(value) ? getLocalDate(value) : new Date(value);
const reportTimestamp = value => {
  const date = reportEntryDate(value);
  return Number.isFinite(date.getTime())
    ? `${formatDate(date)} ${[date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')}`
    : '日時未記録';
};
const reportCompletionUsesDueDate = task => !Number.isFinite(reportEntryDate(task.completedAt).getTime()) && reportDateIsValid(task.dueDate);
const reportCompletionDate = task => reportCompletionUsesDueDate(task) ? getLocalDate(task.dueDate) : reportEntryDate(task.completedAt);
const reportTaskCompletedInPeriod = (task, startDate, endDate) => {
  const completedAt = reportCompletionDate(task).getTime();
  return !!task.completed && completedAt >= getLocalDate(startDate).getTime()
    && completedAt < addDays(getLocalDate(endDate), 1).getTime();
};
const reportTaskIsEligible = (task, startDate, endDate) => {
  if (!reportDateIsValid(startDate) || !reportDateIsValid(endDate) || startDate > endDate) return false;
  if (task.completed) return reportTaskCompletedInPeriod(task, startDate, endDate);
  return !task.isRecurringOccurrence || (task.date >= startDate && task.date <= endDate);
};
const reportPeriodEntries = (task, startDate, endDate) => {
  const start = getLocalDate(startDate).getTime();
  const end = addDays(getLocalDate(endDate), 1).getTime();
  return (task.progressHistory || []).filter(entry => {
    const time = reportEntryDate(entry.createdAt).getTime();
    return isVisibleProgressEntry(entry) && time >= start && time < end;
  }).sort((a, b) => reportEntryDate(a.createdAt) - reportEntryDate(b.createdAt));
};
const reportRichText = html => {
  if (!html) return '';
  // Template contents stay inert; no saved scripts or image resources are loaded.
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script,style,noscript').forEach(el => el.remove());
  template.content.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
  template.content.querySelectorAll('img').forEach(el => el.replaceWith(el.alt ? `[画像: ${el.alt}]` : '[添付画像]'));
  template.content.querySelectorAll('a[href]').forEach(el => {
    const href = el.getAttribute('href');
    if (/^https?:\/\//i.test(href) && !el.textContent.includes(href)) el.append(` (${href})`);
  });
  template.content.querySelectorAll('p,div,li,h1,h2,h3,h4,tr').forEach(el => el.append('\n'));
  return template.content.textContent.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
};
const reportWritingPrompt = [
  '以下の記録を素材に、対象期間の週報を日本語で作成してください。読み手は課長です。',
  '課長が短時間で「何のための案件か」「どういう結論・現状か」「何が残り、いつ何をするか」を把握できる文章にしてください。',
  '案件名を見出しにし、結論や現状を先に示してください。記録にある前提・背景は理解に必要な範囲で1文程度に要約し、関連する結論の補足として添えてください。経緯の羅列やトークの逐語転載は避けてください。',
  '1つの箇条書きは1つの要点に絞り、決定事項・方針変更・主要な期限や数値・重大な懸念など、判断に直結する箇所だけを太字にしてください。全文を太字にはしません。',
  'Wordに貼り付ける本文は、実際の箇条書き・階層・太字で読みやすくしてください。Markdownで返す場合は階層付き箇条書きと **太字** を使ってください。', '',
  '### 案件ごとに書き方を自動選択',
  '以下の4パターンから、AIが案件の目的と実際の記録内容を見て最も適した1つを選んでください。タスク名だけで判断せず、案件ごとに選び、週報全体を同じ型に統一する必要はありません。',
  '判断の軸が異なる話題が1案件に混在するときだけ話題を分け、それぞれに適した型を使ってください。同じ情報を複数の型で重複掲載しないでください。',
  '部品・評価結果の比較や移行可否が主題なら1、進め方や意思決定・プロジェクト全体の進捗が主題なら2、単純な作業なら3、複数の依頼先への連絡・確認の管理が主題なら4を選んでください。',
  '複数社が登場しても、主題が部品評価なら1、意思決定なら2を優先し、依頼先別に整理することが読み手の理解に役立つ場合に4を使ってください。パターン名・番号・分類理由は週報本文に載せず、完成した週報本文を出力してください。', '',
  '### 1. 部品・評価系',
  '部品や評価ごとにまとめ、色・仕様・評価条件によって結果が異なる場合は、その違いが分かる単位に分けてください。',
  '各項目は「現在のステータス・結論 → 残件 → 予定」の順に、短い箇条書きで記載してください。合否・量産移行可否・承認やGOの発行／取り消しなど、判断結果があれば現状の先頭に示してください。',
  '不具合は現象、判明している原因または未特定であること、対策、再評価後の判断事項を必要な範囲で残してください。残件と予定は対応させ、記録がある日付・担当・判定条件を添えてください。',
  '構成例（角括弧の中は記録で置き換え、例の内容を事実として使わない）：',
  '・[部品名／評価項目]',
  '  ・現状・結論：[現在の判定・確認結果・重要な変更]',
  '  ・残件：[未解決の確認事項・対策・再評価の要否]',
  '  ・予定：[実施日・次の作業・結果確認後に判断する内容]', '',
  '### 2. 進め方確認・プロジェクト進捗系',
  '冒頭は「結論」の箇条書きから始めてください。上位の箇条書きは決まったこと・確認できたこと・現在の方針とし、背景・理由・条件・補足は、その結論の下位の箇条書きにしてください。',
  '重要な決定、変更点、主要な期日・数値、未解決で判断や日程に影響する事項は、該当する要点を太字にしてください。未合意・未確認の事項を決定済みの結論として書かないでください。',
  '主な残課題や懸念がある場合は、結論の後に簡潔にまとめ、次の対応・担当・期限を記録の範囲で添えてください。課長への判断依頼が記録されている場合は、依頼内容と必要時期を明示してください。',
  '自分側と相手側の両方にTodoがある場合は、結論の後に「自分側のTodo」「相手側のTodo」の見出しを設け、それぞれ独立した別の表にまとめてください。会社・部署名が記録から分かる場合は、その名称を見出しに使ってください。',
  '相手先が複数ある場合は、相手先ごとにTodoの表を分けてください。Todoを1行ずつ記載し、現在の状況・次の対応・担当・期限など、記録にある必要な情報を簡潔に添えてください。対応主体が不明なものは「担当未確認」と明示し、推測で振り分けないでください。',
  '構成例：',
  '【結論】',
  '・[結論・決定事項・現在の方針]',
  '  ・[その背景・理由・条件・補足]',
  '【主な残課題／Todo】（該当する場合）',
  '自分側と相手側の両方にTodoがある場合：',
  '【自分側のTodo】',
  '[自分側のTodoを1行ずつまとめた表]',
  '【相手側：[相手先名]のTodo】',
  '[その相手先のTodoを1行ずつまとめた別の表。相手先が複数なら表を分ける]',
  '対応主体が1つの場合は、その残課題を簡潔にまとめてください。',
  '【懸念】（該当する場合）',
  '・[判断や日程への影響・対応方針]', '',
  '### 3. シンプルなタスク系',
  '「進捗」と「予定」だけのシンプルな構成にし、それぞれ短い箇条書きで記載してください。背景が必要なら進捗の最初の箇条書きに短く織り込み、独立した背景・結論・課題の見出しを増やさないでください。',
  '進捗には今回実施したことと到達点、予定には残作業と次の実施日・期限を記録の範囲で記載してください。',
  '構成例：',
  '【進捗】',
  '・[目的に必要な短い背景と、実施内容・到達点]',
  '【予定】',
  '・[残作業・次の対応・実施日や期限]', '',
  '### 4. 複数パートナーへの依頼・確認系',
  '複数の依頼先がある案件は、パートナーごとに見出しを分けてください。各パートナーへの依頼事項・確認事項・進捗を短い箇条書きでまとめ、依頼済み・受領済み・回答待ち・確認中などの違いを明確にしてください。',
  '回答で解消した依頼と、まだ回答が必要な事項を整理し、次の対応や回答予定日が記録されていれば同じ項目に添えてください。共通事項を各社の欄へ重複転載しないでください。',
  '構成例：',
  '【[パートナー名]】',
  '・[依頼／確認事項と、その現在の進捗]',
  '・[次の確認・対応・回答予定日や期限（記録がある場合）]', '',
  '### 画像・図・リンクの活用（全パターン共通）',
  '提供された画像・図・資料リンクは、週報を分かりやすくする材料として積極的に活用してください。本文だけでも結論と次の対応が分かる短い要約を残し、画像や資料で具体的な理解を補ってください。',
  '画像・図は、対応する部品・評価結果・不具合・変更点・結論・Todoの説明のすぐ近くに挿入してください。記録にある対象や確認箇所、何を説明する画像かが分かる短いキャプションを添えてください。',
  'リンクは、提供された資料名と正しいURLを保持し、資料の内容や用途が分かる名称のクリック可能なハイパーリンクとして、関連する結論・確認事項・Todoの近くに添えてください。根拠資料や評価結果へ読み手がすぐたどれるようにしてください。',
  '判断に役立つ画像・資料を選び、同じ画像やリンクの重複掲載は避けてください。提供されていない画像・資料・URLを作らず、画像だけから未記録の原因や合否を断定しないでください。', '',
  '### 根拠・期間・予定の扱い（全パターン共通）',
  '実施内容・成果は「期間内の記録」を根拠にしてください。記録のない実施・完了・理由は推測せず、必要な箇所で未記録としてください。書式例の内容を実際の案件の事実として使わないでください。',
  '「現在の状態」は出力時点の参考情報で、対象期間末の状態や期間内の実績とは限りません。日時のない結果メモも同様です。参照する場合は期間内の実績と区別してください。',
  '「タスク全体の完了日／日時」が対象期間内の場合は、その完了記録を参照してください。過去の完了日時未記録タスクは、利用者の指定により期限日を完了日として扱います。代用である旨は残してください。',
  '記録は投稿日時で抽出します。編集済みの本文は現在の保存内容であり、期間当時の本文を復元したものではありません。',
  '前提メモは目的・背景・仮定です。進捗・成果・完了の実績として数えず、記載された前提が検証済みとも推測しないでください。期間外の前提メモは背景資料として参照し、未来の日付のメモは含めません。',
  '引用は背景資料です。引用元の日付が対象期間外でも記載しますが、期間内の新規実績として二重計上しないでください。',
  '完了記録は関連する項目の完了です。小さいタスクの完了を親タスク全体の完了と解釈しないでください。作業の追加や依頼の送付だけで、実施・評価・完了済みとも判断しないでください。',
  '予定は記録された日付・担当・作業を優先し、未完了項目と期限から整理する場合は候補と明示してください。確定予定・目標・未定を区別し、記録にない日付や担当を補わないでください。次週に限らず、残件に対応する重要な直近の予定・期限を記載してください。',
  '残件がないと明記された項目は「残件なし」と書けます。記録が見当たらないことを「残件なし」「問題なし」「完了」と解釈しないでください。空の見出しや不要な重複は増やさないでください。'
];
const buildWeeklyReport = ({ tasks, startDate, endDate, now = new Date(), onImage }) => {
  const reportTasks = tasks.filter(task => reportTaskIsEligible(task, startDate, endDate));
  const entriesByTask = reportTasks.map(task => ({ task, entries: reportPeriodEntries(task, startDate, endDate) }));
  const entries = entriesByTask.flatMap(item => item.entries);
  const comments = entries.filter(entry => entry.kind === 'comment' && !progressEntryIsNote(entry));
  const lines = [
    '# 週報作成用レポート（Copilot入力用）',
    `対象期間: ${startDate} ～ ${endDate}（開始日・終了日を含む）`,
    `出力日時: ${reportTimestamp(now)}`,
    `時刻の基準: ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'ブラウザーの現地時刻'}`,
    `選択タスク数: ${reportTasks.length}`, '',
    '## Copilotへの依頼',
    ...reportWritingPrompt, '',
    '## 期間内の記録サマリー',
    `期間内に完了したタスク: ${reportTasks.filter(task => reportTaskCompletedInPeriod(task, startDate, endDate)).length}件`,
    `うち期限日を完了日として扱ったタスク: ${reportTasks.filter(task => task.completed && reportCompletionUsesDueDate(task)).length}件`,
    `進捗記録: ${comments.length}件`,
    `完了の記録: ${comments.filter(entry => entry.status === 'completed').length}件`,
    `相手待ちの記録: ${comments.filter(entry => entry.status === 'waiting').length}件`,
    `小さいタスク追加の記録: ${comments.filter(entry => entry.addedSmallTask).length}件`,
    `通常コメント: ${entries.filter(entry => entry.plainComment && !entry.assumptionMemo).length}件`,
    `前提メモ（期間内）: ${entries.filter(entry => entry.assumptionMemo).length}件`,
    `理由付き期限変更の記録: ${entries.filter(entry => entry.kind === 'change').length}件`,
    '※件数は記録数です。同じ項目の複数記録を、別々の完了タスクとして数えないでください。', '',
    '## タスク別の詳細'
  ];
  const text = (label, value, indent = '') => {
    if (value) lines.push(`${indent}${label}:`, ...String(value).split(/\r?\n/).map(line => `${indent}  ${line}`));
  };
  const state = item => item.completed ? '完了' : item.waiting ? '相手待ち'
    : item.progressStage === 'doing' ? '着手中' : item.progressStage === 'todo' ? '未着手' : '未完了（着手状況の記録なし）';
  const stateWithDue = item => `${state(item)}${!item.completed && item.dueDate && item.dueDate < formatDate(now) ? ' / 期限超過（出力時点）' : ''}`;
  const media = (entry, indent = '') => {
    if (onImage) progressMediaItems(entry.images).forEach(image => lines.push(onImage(image)));
    else if (progressMediaItems(entry.images).length) text('添付画像（画像データは含みません）', progressMediaItems(entry.images).map(image => image.name).join(' / '), indent);
    progressTextLinks(entry.text || '', entry.textLinks).forEach(link => text('本文のリンク', `${entry.text.slice(link.start, link.end)}: ${link.url}`, indent));
    text('添付リンク', progressMediaItems(entry.links).filter(link => progressSafeUrl(link.url)).map(link => `${link.label || link.url}: ${link.url}`).join('\n'), indent);
  };
  const quote = (source, indent = '    ') => {
    lines.push(`${indent}引用（背景資料・新規実績には数えない）:`, `${indent}  元の日時: ${reportTimestamp(source.createdAt)}`);
    text('元の状態', source.assumptionMemo ? '前提メモ（背景情報・実績ではない）' : progressEntryIsNote(source) ? '通常コメント（進捗ではない）' : source.status === 'waiting' ? '相手待ち' : source.status === 'completed' ? '完了' : '進捗', `${indent}  `);
    text('関連するやるべきこと', source.subtaskTitles?.join(' / '), `${indent}  `);
    text('小さいタスク', source.smallTaskTitle, `${indent}  `);
    text('引用本文', source.text, `${indent}  `);
    media(source, `${indent}  `);
    if (source.quote) quote(source.quote, `${indent}  `);
  };
  entriesByTask.forEach(({ task, entries: taskEntries }, index) => {
    lines.push('', `### ${index + 1}. ${task.title}`, `タスクID: ${task.id}`,
      `予定日: ${task.date || '未設定'}`, `タスク期限: ${task.dueDate || '未設定'}`,
      `現在の状態（出力時点）: ${stateWithDue(task)}`);
    if (task.completed && Number.isFinite(reportCompletionDate(task).getTime())) lines.push(reportCompletionUsesDueDate(task)
      ? `タスク全体の完了日: ${formatDate(reportCompletionDate(task))}（完了日時未記録のため期限日を使用）`
      : `タスク全体の完了日時: ${reportTimestamp(task.completedAt)}`);
    if (task.isRecurringOccurrence) lines.push(`種別: 定期予定（${task.recurrenceDate} の回）`);
    text('タスクのメモ', task.memo);
    text('関連URL', (task.urls || []).join('\n'));
    text('結果メモ（日時未記録・現在の保存内容）', [task.completionNote, reportRichText(task.richResult)].filter(Boolean).join('\n'));
    text('成果物URL（現在の保存内容）', (task.resultUrls || []).join('\n'));
    if (onImage) {
      (task.resultImages || []).forEach((src, index) => lines.push(onImage(typeof src === 'string' ? { src, name: `成果画像 ${index + 1}` } : src)));
      const template = document.createElement('template'); template.innerHTML = task.richResult || '';
      template.content.querySelectorAll('img').forEach(el => { if (el.getAttribute('src')) lines.push(onImage({ src: el.getAttribute('src'), name: el.alt || '成果画像' })); });
    }
    if (!onImage && task.resultImages?.length) lines.push(`添付画像: ${task.resultImages.length}件（画像データはこのテキストに含まれません）`);
    const premises = (task.progressHistory || []).filter(entry => entry.kind === 'comment' && entry.assumptionMemo
      && (!Number.isFinite(reportEntryDate(entry.createdAt).getTime()) || reportEntryDate(entry.createdAt) < getLocalDate(startDate)));
    if (premises.length) {
      lines.push('', '#### 前提メモ（期間前・日時未記録の背景情報／期間内の実績ではない）');
      premises.forEach(entry => {
        lines.push(`- ${reportTimestamp(entry.createdAt)} / 前提メモ / 記録ID: ${entry.id}`);
        text('関連するやるべきこと', progressEntrySubtaskTitles(task, entry).join(' / '));
        text('小さいタスク', entry.smallTaskTitle);
        text('前提の内容', entry.text); media(entry);
        if (entry.editedAt) lines.push(`編集日時: ${reportTimestamp(entry.editedAt)}（本文は現在の保存内容）`);
        if (entry.quote) quote(entry.quote);
      });
    }
    lines.push('', '#### 現在のやるべきこと・小さいタスク（出力時点の参考）');
    const subtasks = getProgressSubtasks(task);
    if (!subtasks.length) lines.push('やるべきことの登録なし。');
    subtasks.forEach(st => {
      lines.push(`- ${st.title} [${st.id}] / 期限: ${st.dueDate || '未設定'} / ${stateWithDue(st)}`);
      getProgressSmallTasks(st).forEach(small => lines.push(`  - ${small.title} [${small.id}] / 期限なし / ${state(small)}`));
    });
    const completedItems = subtasks.flatMap(st => [st, ...getProgressSmallTasks(st)]).filter(item => item.completed && item.completionSource === 'manual' && item.completedAt
      && reportEntryDate(item.completedAt) >= getLocalDate(startDate) && reportEntryDate(item.completedAt) < addDays(getLocalDate(endDate), 1));
    if (completedItems.length) {
      lines.push('', '#### 期間内の項目の完了（保存された完了日時に基づく）');
      completedItems.forEach(item => lines.push(`- ${reportTimestamp(item.completedAt)} / ${item.title} [${item.id}] / 完了`));
    }
    lines.push('', `#### 期間内の記録（${taskEntries.length}件）`);
    if (!taskEntries.length) lines.push('指定期間内の進捗記録はありません。タスク全体の完了日／日時が別記されている場合は、その記録を参照してください。それ以外は現在の状態から期間内の実績を推測しないでください。');
    taskEntries.forEach(entry => {
      const type = entry.kind !== 'comment' ? '期限変更（理由あり）' : entry.assumptionMemo ? '前提メモ（背景情報・実績ではない）' : progressEntryIsNote(entry) ? '通常コメント（進捗・状態変更なし）' : entry.addedSmallTask ? '小さいタスクの追加'
        : entry.status === 'completed' ? '完了' : entry.status === 'waiting' ? '相手待ち' : '進捗';
      lines.push('', `- ${reportTimestamp(entry.createdAt)} / ${type} / 記録ID: ${entry.id}`);
      if (entry.kind === 'comment') lines.push(`  記録の状態: ${entry.assumptionMemo ? '前提メモ（背景情報・実績ではない）' : progressEntryIsNote(entry) ? '通常コメント（進捗ではない）' : entry.status === 'completed' ? '完了' : entry.status === 'waiting' ? '相手待ち' : '進捗'}`);
      const related = (entry.subtaskIds || []).map((id, i) => `${subtasks.find(st => st.id === id)?.title || entry.subtaskTitles?.[i] || '名称未記録'} [${id}]`);
      text('関連するやるべきこと', related.join(' / '), '  ');
      text('小さいタスク（削除済み項目も記録時の名称を保持）', entry.smallTaskId ? `${entry.smallTaskTitle || '名称未記録'} [${entry.smallTaskId}]` : '', '  ');
      text('本文', entry.text, '  ');
      media(entry, '  ');
      if (entry.editedAt) lines.push(`  編集日時: ${reportTimestamp(entry.editedAt)}`);
      if (entry.quote) quote(entry.quote);
    });
  });
  return `${lines.join('\n')}\n`;
};

// A real OOXML package, written locally without network dependencies.
const reportXml = value => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const reportZip = files => {
  const encoder = new TextEncoder(), parts = [], directory = [];
  let offset = 0;
  const header = size => new Uint8Array(size);
  const crc32 = bytes => {
    let crc = -1;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    return (crc ^ -1) >>> 0;
  };
  files.forEach(({ name, data }) => {
    const path = encoder.encode(name), bytes = typeof data === 'string' ? encoder.encode(data) : data;
    const crc = crc32(bytes), local = header(30), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x800, true); lv.setUint16(12, 33, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, bytes.length, true); lv.setUint32(22, bytes.length, true); lv.setUint16(26, path.length, true);
    parts.push(local, path, bytes);
    const central = header(46), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true); cv.setUint16(14, 33, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, bytes.length, true); cv.setUint32(24, bytes.length, true); cv.setUint16(28, path.length, true); cv.setUint32(42, offset, true);
    directory.push(central, path); offset += local.length + path.length + bytes.length;
  });
  const end = header(22), ev = new DataView(end.buffer), directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, directorySize, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
};
const buildWeeklyWordReport = async options => {
  const images = [], prefix = `REPORT_IMAGE_${createProgressId()}_`;
  const body = buildWeeklyReport({ ...options, onImage: image => { images.push(image); return prefix + (images.length - 1); } });
  const files = [], relationships = [], paragraphs = [];
  let imageId = 0;
  const run = text => `<w:r><w:t xml:space="preserve">${reportXml(text)}</w:t></w:r>`;
  const linkedText = text => {
    const named = text.match(/^(\s+)(.+?): (https?:\/\/\S+)$/i);
    if (named && progressSafeUrl(named[3])) {
      const id = `rId${relationships.length + 1}`;
      relationships.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${reportXml(named[3])}" TargetMode="External"/>`);
      return run(named[1]) + `<w:hyperlink r:id="${id}"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t>${reportXml(named[2])}</w:t></w:r></w:hyperlink>` + run(` (${named[3]})`);
    }
    const links = progressAllTextLinks(text, []);
    let cursor = 0, xml = '';
    links.forEach(link => {
      xml += run(text.slice(cursor, link.start));
      const id = `rId${relationships.length + 1}`;
      relationships.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${reportXml(link.url)}" TargetMode="External"/>`);
      xml += `<w:hyperlink r:id="${id}"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">${reportXml(text.slice(link.start, link.end))}</w:t></w:r></w:hyperlink>`;
      cursor = link.end;
    });
    return xml + run(text.slice(cursor));
  };
  for (const line of body.split('\n')) {
    if (line.startsWith(prefix)) {
      const image = images[Number(line.slice(prefix.length))];
      if (!image) continue;
      if (!/^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(image.src || '')) {
        paragraphs.push(`<w:p>${linkedText(`画像: ${image.name || '添付画像'}${progressSafeUrl(image.src) ? ` (${image.src})` : '（画像データなし）'}`)}</w:p>`); continue;
      }
      const loaded = await new Promise((resolve, reject) => {
        const element = new Image(); element.onload = () => resolve(element); element.onerror = () => reject(new Error(`画像「${image.name || '添付画像'}」を読み込めません。`)); element.src = image.src;
      });
      const scale = Math.min(1, 600 / loaded.naturalWidth, 700 / loaded.naturalHeight);
      const width = Math.max(1, Math.round(loaded.naturalWidth * scale)), height = Math.max(1, Math.round(loaded.naturalHeight * scale));
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(loaded, 0, 0, width, height);
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0));
      const name = `image${++imageId}.png`, id = `rId${relationships.length + 1}`;
      files.push({ name: `word/media/${name}`, data: bytes });
      relationships.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
      paragraphs.push(`<w:p>${run(image.name || '添付画像')}</w:p><w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${width * 9525}" cy="${height * 9525}"/><wp:docPr id="${imageId}" name="${reportXml(image.name || name)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${reportXml(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width * 9525}" cy="${height * 9525}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
    } else {
      const heading = line.match(/^(#{1,4})\s+(.*)/);
      paragraphs.push(`<w:p>${heading ? `<w:pPr><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="${heading[1].length - 1}"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="${32 - heading[1].length * 2}"/></w:rPr><w:t>${reportXml(heading[2])}</w:t></w:r>` : linkedText(line)}</w:p>`);
    }
  }
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  files.push({ name: '[Content_Types].xml', data: xml + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: xml + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: xml + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>` },
    { name: 'word/document.xml', data: xml + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>` });
  return reportZip(files);
};

const reportTaskOnProgressBoard = task => !!task.progressEnabled && !task.isSubtask && !task.isRecurringOccurrence && (!!task.completed || task.progressStage === 'doing');
const WeeklyReportModal = ({ tasks, onClose, onCreated }) => {
  const [format, setFormat] = useState('docx');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [startDate, setStartDate] = useState(() => formatDate(addDays(new Date(), -7)));
  const [endDate, setEndDate] = useState(() => formatDate(new Date()));
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState(() => tasks.filter(task => reportTaskOnProgressBoard(task) && reportTaskIsEligible(task,startDate,endDate)).map(task=>task.id));
  const formRef = useRef(null);
  const searchRef = useRef(null);
  const validRange = reportDateIsValid(startDate) && reportDateIsValid(endDate) && startDate <= endDate;
  const boardTasks=tasks.filter(reportTaskOnProgressBoard);
  const available = boardTasks.filter(task => reportTaskIsEligible(task, startDate, endDate));
  const undatedCompletedCount = boardTasks.filter(task => task.completed && !Number.isFinite(reportCompletionDate(task).getTime())).length;
  const visible = available.filter(task => task.title.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = available.filter(task => selectedIds.includes(task.id));
  const count = validRange ? selected.reduce((total, task) => total + reportPeriodEntries(task, startDate, endDate).length, 0) : 0;
  useEffect(() => {
    const previous = document.activeElement;
    searchRef.current?.focus();
    const handleKey = e => {
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); onClose(); }
      if (e.key === 'Tab') {
        const elements = [...formRef.current.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')];
        const first = elements[0], last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); previous?.focus(); };
  }, [onClose]);
  const download = async e => {
    e.preventDefault();
    if (!validRange || !selected.length || busy) return;
    setBusy(true); setError('');
    try {
    const options = { tasks: selected, startDate, endDate };
    const blob = format === 'docx' ? await buildWeeklyWordReport(options)
      : new Blob(['\uFEFF', buildWeeklyReport(options)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `週報素材_${startDate}_${endDate}.${format}`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onCreated(); onClose();
    } catch (issue) { setError(`出力できませんでした。${issue.message || 'もう一度お試しください。'}`); }
    finally { setBusy(false); }
  };
  return <div className="fixed inset-0 bg-black/60 z-50 p-4 flex items-center justify-center backdrop-blur-sm">
    <form ref={formRef} role="dialog" aria-modal="true" aria-label="週報用レポート作成" onSubmit={download}
      onKeyDown={e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !e.nativeEvent.isComposing) e.preventDefault(); }}
      className="w-full max-w-2xl max-h-[90vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden">
      <header className="p-5 border-b flex items-start justify-between gap-3">
        <div><h2 className="text-lg font-black">週報用レポート作成</h2><p className="text-xs text-gray-500 mt-1">週報の素材を、画像・リンク付きのWordファイルで出力します。</p></div>
        <button type="button" aria-label="レポート作成を閉じる" onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100"><X size={20}/></button>
      </header>
      <div className="p-5 overflow-y-auto space-y-4">
        <label className="block text-sm font-bold">出力形式<select aria-label="レポート出力形式" value={format} disabled={busy} onChange={e => setFormat(e.target.value)} className="ml-2 border rounded-lg p-2 font-normal"><option value="docx">Word（.docx・画像付き）</option><option value="txt">テキスト（.txt・画像名のみ）</option></select></label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap gap-4">
          <label className="text-sm font-bold">開始日<input aria-label="レポート開始日" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="block mt-1 border rounded-lg px-3 py-2 font-normal"/></label>
          <label className="text-sm font-bold">終了日<input aria-label="レポート終了日" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="block mt-1 border rounded-lg px-3 py-2 font-normal"/></label>
        </div>
        {!validRange && <p role="alert" className="text-sm text-red-700">開始日と終了日を正しく指定してください。開始日は終了日以前にしてください。</p>}
        <p className="text-xs text-gray-500">両日を含む期間内の記録と、選択タスクの現在の状態を分けて記載します。やるべきこと・小さいタスク・引用も含みます。</p>
        <p className="text-xs text-gray-500">未完了のタスクと、指定期間内に完了したタスクだけを選択できます。保存された完了日時を優先して判定します。</p>
        <p className="text-xs text-gray-500">過去の完了日時未記録タスクは、期限日を完了日として扱います。</p>
        {!!undatedCompletedCount && <p className="text-xs text-gray-500">完了日時・期限日とも未記録の完了タスクは対象外です（{undatedCompletedCount}件）。</p>}
        <input ref={searchRef} aria-label="レポート対象タスクを検索" placeholder="タスク名で検索" value={query} onChange={e => setQuery(e.target.value)} className="w-full border rounded-lg p-2 text-sm"/>
        <div className="flex justify-between items-center gap-2 text-xs">
          <span className="font-bold">選択中 {selected.length}件 / 期間内の記録 {count}件</span>
          <div className="flex gap-3"><button type="button" className="text-blue-700 underline" onClick={() => setSelectedIds(previous => [...new Set([...previous, ...visible.map(task => task.id)])])}>表示中をすべて選択</button>
            <button type="button" className="text-gray-600 underline" onClick={() => setSelectedIds([])}>選択を解除</button></div>
        </div>
        <fieldset><legend className="text-sm font-bold mb-2">対象の大タスク</legend>
          <div aria-label="レポート対象の大タスクタイル" className="grid grid-cols-2 gap-3">
            {visible.map(task => <label key={task.id} data-report-task-id={task.id} className={`relative min-h-28 rounded-xl border p-3 cursor-pointer shadow-sm hover:shadow-md ${progressStatusClasses(progressItemStatus(task))} ${selectedIds.includes(task.id) ? 'ring-2 ring-blue-500' : ''}`}>
              <input type="checkbox" aria-label={`レポート対象: ${task.title}`} checked={selectedIds.includes(task.id)} onChange={e=>setSelectedIds(previous=>e.target.checked?[...new Set([...previous,task.id])]:previous.filter(id=>id!==task.id))} className="absolute top-3 right-3"/>
              <span className="block pr-6 text-sm font-bold break-words">{task.title}</span><span className="mt-3 block text-xs">期限: {task.dueDate || '未設定'}</span>
            </label>)}
          </div>
          {!visible.length && <p className="text-sm text-gray-500">対象タスクがありません。着手中ボード・検索条件・期間を確認してください。</p>}
        </fieldset>
        <p className="text-xs text-gray-500">着手中ボードの大タスクが対象です。未完了・完了済みを分けずに並べ、期間内の進捗記録がないタスクも現在の情報を出力します。</p>
      </div>
      <footer className="border-t p-4 flex justify-end gap-2 shrink-0">
        <button type="button" onClick={onClose} className="border rounded-lg px-4 py-2 text-sm">キャンセル</button>
        <button type="submit" disabled={busy || !validRange || !selected.length} className="bg-blue-600 text-white disabled:opacity-40 rounded-lg px-4 py-2 text-sm font-bold">{busy ? '作成中…' : format === 'docx' ? 'Wordをダウンロード' : 'テキストをダウンロード'}</button>
      </footer>
    </form>
  </div>;
};

export default function App() {
  const [isDBReady, setIsDBReady] = useState(false);
  const [activeTab, setActiveTab] = useState('board');
  const [plannerView, setPlannerView] = useState('list');

  const [tasks, setTaskRecords] = useState([]);
  const setTasks = (update, metadata) => setTaskRecords(previous => {
    const next = typeof update === 'function' ? update(previous) : update;
    const previousById = new Map(previous.map(task => [task.id, task]));
    return next.map(task => {
      const old = previousById.get(task.id);
      if (old === task) return task;
      return appendProgressHistory(old, withCompletionTimestamp(old, normalizeProgressTask(syncRemovedProgressTodos(old, task))), metadata);
    });
  });
  const handleUpdateProgressTask = (id, update, metadata) => {
    setTasks(previous => previous.map(task => {
      if (task.id !== id) return task;
      let next = update(task);
      if (next.progressHistory === task.progressHistory) {
        const cleared = new Set();
        if (task.waiting && !next.waiting) cleared.add('task');
        getProgressSubtasks(task).forEach(st => {
          const after = getProgressSubtasks(next).find(item => item.id === st.id);
          if (after && st.waiting && !after.waiting) cleared.add(`subtask:${st.id}`);
          getProgressSmallTasks(st).forEach(small => { if (small.waiting && getProgressSmallTasks(after).some(item => item.id === small.id && !item.waiting)) cleared.add(`small:${small.id}`); });
        });
        if (cleared.size) next = { ...next, progressHistory: (next.progressHistory || []).map(entry => entry.status === 'waiting' && !progressEntryIsNote(entry) && !entry.resolvedByReplyId && cleared.has(progressWaitingScope(task, entry)) ? { ...entry, resolvedByReplyId: 'waiting-cleared-in-settings' } : entry) };
      }
      if (task.completed && next.completed) {
        const before = new Map(getProgressSubtasks(task).map(st => [st.id, st]));
        if (getProgressSubtasks(next).some(st => !st.completed && (!before.has(st.id) || before.get(st.id).completed))) {
          next = { ...next, completed: false };
          delete next.completedAt;
        }
      }
      return task.dueDate !== next.dueDate ? { ...next, date: next.dueDate } : next;
    }), metadata);
  };
  const [projects, setProjects] = useState([]);
  const [recurringSchedules, setRecurringSchedules] = useState([]);
  const [recurringCompletions, setRecurringCompletions] = useState({});
  const backupData = useMemo(() => ({ tasks, projects, recurringSchedules, recurringCompletions }), [tasks, projects, recurringSchedules, recurringCompletions]);
  const fileBackup = useFileBackup(backupData, isDBReady);

  useEffect(() => {
    const loadData = async () => {
      try {
        const loadedTasks = await loadFromDB('tasks');
        const loadedProjects = await loadFromDB('projects');
        const loadedRecurringSchedules = await loadFromDB('recurringSchedules');
        const loadedRecurringCompletions = await loadFromDB('recurringCompletions');

        const tasksWithId = (loadedTasks || initialTasks).map((t, idx) =>
          (!t.id || t.id === 'undefined') ? { ...t, id: `t_${Date.now()}_${idx}_${Math.random().toString(36).substring(2,9)}` } : t
        );

        setTaskRecords(tasksWithId.map(normalizeProgressTask));
        setProjects(loadedProjects || initialProjects);
        setRecurringSchedules(loadedRecurringSchedules || initialRecurringSchedules);
        setRecurringCompletions(loadedRecurringCompletions || {});
      } catch (e) {
        console.error("Failed to load from DB", e);
      } finally {
        setIsDBReady(true);
      }
    };
    loadData();
  }, []);

  useEffect(() => {
    if (isDBReady) saveToDB('tasks', tasks);
  }, [tasks, isDBReady]);

  useEffect(() => {
    if (isDBReady) saveToDB('projects', projects);
  }, [projects, isDBReady]);

  useEffect(() => {
    if (isDBReady) saveToDB('recurringSchedules', recurringSchedules);
  }, [recurringSchedules, isDBReady]);

  useEffect(() => {
    if (isDBReady) saveToDB('recurringCompletions', recurringCompletions);
  }, [recurringCompletions, isDBReady]);

  const [selectedProject, setSelectedProject] = useState(null);
  const [showCompletedTasks, setShowCompletedTasks] = useState(false);
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [creatingProgressTask, setCreatingProgressTask] = useState(false);
  const [completingTask, setCompletingTask] = useState(null);

  const [newTaskDefaultDate, setNewTaskDefaultDate] = useState(TODAY_STR);
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [isRecurringModalOpen, setIsRecurringModalOpen] = useState(false);
  const [editingRecurringSchedule, setEditingRecurringSchedule] = useState(null);
  const [isAddingSubtask, setIsAddingSubtask] = useState(false);
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [toastMessage, setToastMessage] = useState('');

  const [dragItem, setDragItem] = useState(null);
  const [hoverDropDate, setHoverDropDate] = useState(null);
  const [hoverDropWeek, setHoverDropWeek] = useState(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [filterCompleted, setFilterCompleted] = useState('all');
  const [filterProject, setFilterProject] = useState('all');
  const [showRecurringInList, setShowRecurringInList] = useState(true);

  const thisWeekRef = useRef(null);
  const fileInputRef = useRef(null);

  const mainBoardWeeks = useMemo(() => {
    const weeks = [];
    const today = new Date(TODAY_STR);
    const thisMonday = getMonday(today);

    for (let i = -26; i <= 26; i++) {
      const startMonday = addDays(thisMonday, i * 7);
      const days = [];
      const dayNames = ['月曜日', '火曜日', '水曜日', '木曜日', '金曜日'];
      for (let j = 0; j < 5; j++) {
        days.push({
          date: formatDate(addDays(startMonday, j)),
          label: dayNames[j]
        });
      }
      weeks.push({
        offset: i,
        startMonday: formatDate(startMonday),
        days: days,
        isThisWeek: i === 0,
        isNextWeek: i === 1
      });
    }
    return weeks;
  }, []);

  const getWeekLabel = (offset) => {
    if (offset === 0) return "今週";
    if (offset === 1) return "来週";
    if (offset === -1) return "先週";
    if (offset > 1) return `${offset}週間後`;
    if (offset < -1) return `${Math.abs(offset)}週間前`;
  };

  useEffect(() => {
    if (activeTab === 'board' && isDBReady) {
      setTimeout(() => {
        thisWeekRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' });
      }, 100);
    }
  }, [activeTab, isDBReady]);

  const scrollToThisWeek = () => {
    thisWeekRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const yearWeeks = useMemo(() => {
    const d = new Date(TODAY_STR);
    let currentMonday = getMonday(d);
    const weeks = [];
    for(let i=0; i<52; i++) {
      weeks.push({
        startDate: formatDate(currentMonday),
        weekNum: getWeekNumber(currentMonday),
      });
      currentMonday = addDays(currentMonday, 7);
    }
    return weeks;
  }, []);

  const handleExport = () => {
    const jsonString = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `taskmatrix_backup_${formatDate(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('データをエクスポートしました');
  };

  const handleImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);
        if (data.tasks && Array.isArray(data.tasks)) setTaskRecords(data.tasks.map(normalizeProgressTask));
        if (data.projects && Array.isArray(data.projects)) setProjects(data.projects);
        if (data.recurringSchedules && Array.isArray(data.recurringSchedules)) setRecurringSchedules(data.recurringSchedules);
        if (data.recurringCompletions && typeof data.recurringCompletions === 'object') setRecurringCompletions(data.recurringCompletions);
        showToast('データをインポートしました');
      } catch (error) {
        console.error("Import failed:", error);
        alert('ファイルの読み込みに失敗しました。正しいJSONファイルを選択してください。');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const recurringDisplayRange = useMemo(() => {
    const boardDates = mainBoardWeeks.flatMap(week => week.days.map(day => day.date));
    const plannerDates = yearWeeks.map(week => week.startDate);
    const allDates = [...boardDates, ...plannerDates, TODAY_STR].sort();
    return { start: allDates[0], end: allDates[allDates.length - 1] };
  }, [mainBoardWeeks, yearWeeks]);

  const recurringOccurrences = useMemo(() => {
    const rangeStart = getLocalDate(recurringDisplayRange.start);
    const rangeEnd = getLocalDate(recurringDisplayRange.end);
    rangeEnd.setHours(23, 59, 59, 999);
    const occurrences = [];

    recurringSchedules.forEach((schedule, scheduleIndex) => {
      if (!schedule.startDate) return;
      const scheduleEnd = schedule.endDate ? getLocalDate(schedule.endDate) : rangeEnd;
      const effectiveEnd = scheduleEnd < rangeEnd ? scheduleEnd : rangeEnd;
      let current = getRecurringFirstOccurrenceDate(schedule);
      let guard = 0;

      while (current < rangeStart && guard < 10000) {
        current = getRecurringNextOccurrenceDate(schedule, current);
        guard += 1;
      }

      while (current <= effectiveEnd && guard < 12000) {
        const date = formatDate(current);
        const completionKey = `${schedule.id}_${date}`;
        const completion = recurringCompletions[completionKey] || {};
        occurrences.push({
          id: buildRecurringOccurrenceId(schedule.id, date),
          recurringScheduleId: schedule.id,
          recurrenceDate: date,
          isRecurringOccurrence: true,
          isSubtask: false,
          type: 'recurring',
          title: schedule.title,
          date,
          dueDate: date,
          memo: schedule.memo,
          urls: schedule.urls || [],
          completed: completion.completed || false,
          completedAt: completion.completedAt,
          richResult: completion.richResult,
          completionNote: completion.completionNote || '',
          resultUrls: completion.resultUrls || [],
          resultImages: completion.resultImages || [],
          order: new Date(date).getTime() + 500 + scheduleIndex
        });
        current = getRecurringNextOccurrenceDate(schedule, current);
        guard += 1;
      }
    });

    return occurrences;
  }, [recurringSchedules, recurringCompletions, recurringDisplayRange]);

  const displayItems = useMemo(() => {
    const items = [];
    tasks.forEach((t, i) => {
      const tOrder = typeof t.order === 'number' ? t.order : new Date(t.date).getTime() + i * 1000;
      items.push({ ...t, isSubtask: false, order: tOrder });

      if (t.subtasks && Array.isArray(t.subtasks)) {
        t.subtasks.forEach((st, idx) => {
          const stOrder = typeof st.order === 'number' ? st.order : new Date(st.dueDate).getTime() + i * 1000 + idx;
          items.push({
            id: st.id || `${t.id}-sub-${idx}`,
            isSubtask: true,
            parentId: t.id,
            parentTitle: t.title,
            parentDueDate: t.dueDate,
            type: 'subtask',
            title: st.title,
            date: st.dueDate,
            dueDate: st.dueDate,
            completed: st.completed || false,
            waiting: st.waiting || false,
            subtaskIndex: idx,
            order: stOrder,
            richResult: st.richResult,
            resultUrls: st.resultUrls,
            completionNote: st.completionNote,
            resultImages: st.resultImages,
            memo: st.memo,
            urls: st.urls,
          });
        });
      }
    });
    // A tracked recurring occurrence is materialized once, so it can own subtasks/history.
    const materializedIds = new Set(tasks.map(task => task.id));
    return [...items, ...recurringOccurrences.filter(task => !materializedIds.has(task.id))].sort((a, b) => a.order - b.order);
  }, [tasks, recurringOccurrences]);

  const handlePointerDown = (e, type, data) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setDragItem({
      type,
      data,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      clientX: e.clientX,
      clientY: e.clientY,
      width: rect.width
    });
  };

  useEffect(() => {
    if (!dragItem) return;

    const handlePointerMove = (e) => {
      e.preventDefault();
      setDragItem(prev => ({
        ...prev,
        clientX: e.clientX,
        clientY: e.clientY
      }));

      const target = document.elementFromPoint(e.clientX, e.clientY);
      const columnEl = target?.closest('[data-drop-zone="column"]');
      const dropZoneDate = columnEl?.getAttribute('data-drop-date');
      const dropZoneWeek = target?.closest('[data-drop-week]')?.getAttribute('data-drop-week');

      setHoverDropDate(dropZoneDate || null);
      setHoverDropWeek(dropZoneWeek || null);
    };

    const handlePointerUp = (e) => {
      const target = document.elementFromPoint(e.clientX, e.clientY);

      const dropZone = target?.closest('[data-drop-zone]');
      const targetTaskEl = target?.closest('[data-task-id]');
      const dropZoneWeek = target?.closest('[data-drop-week]')?.getAttribute('data-drop-week');

      if (dragItem.type === 'task' && (dropZone || targetTaskEl)) {
        let finalDropDate = dragItem.data.date;
        let isDateChanged = false;

        let newDropDate = null;
        if (dropZone) {
          newDropDate = dropZone.getAttribute('data-drop-date');
        } else if (targetTaskEl) {
          newDropDate = targetTaskEl.getAttribute('data-drop-date');
        }

        if (newDropDate && newDropDate !== dragItem.data.date) {
          finalDropDate = newDropDate;
          isDateChanged = true;
        }

        const listContainer = dropZone ? (dropZone.querySelector('.overflow-y-auto') || dropZone) : (targetTaskEl ? targetTaskEl.parentElement : null);

        if (listContainer) {
          const taskEls = Array.from(listContainer.querySelectorAll('[data-task-id]')).filter(
            el => el.getAttribute('data-task-id') !== dragItem.data.id
          );

          let insertIndex = taskEls.length;
          for (let i = 0; i < taskEls.length; i++) {
            const rect = taskEls[i].getBoundingClientRect();
            const elCenterY = rect.top + rect.height / 2;
            if (e.clientY < elCenterY) {
              insertIndex = i;
              break;
            }
          }

          const getOrder = (id) => {
            const item = displayItems.find(t => t.id === id);
            return item && typeof item.order === 'number' ? item.order : Date.now();
          };

          let newOrder;
          if (taskEls.length === 0) {
            newOrder = Date.now();
          } else if (insertIndex === 0) {
            newOrder = getOrder(taskEls[0].getAttribute('data-task-id')) - 100000;
          } else if (insertIndex === taskEls.length) {
            newOrder = getOrder(taskEls[taskEls.length - 1].getAttribute('data-task-id')) + 100000;
          } else {
            const prevOrder = getOrder(taskEls[insertIndex - 1].getAttribute('data-task-id'));
            const nextOrder = getOrder(taskEls[insertIndex].getAttribute('data-task-id'));
            newOrder = (prevOrder + nextOrder) / 2;
          }

          setTasks(prev => prev.map(t => {
            if (dragItem.data.isSubtask) {
              if (t.id === dragItem.data.parentId) {
                const newSubtasks = [...t.subtasks];
                newSubtasks[dragItem.data.subtaskIndex] = {
                  ...newSubtasks[dragItem.data.subtaskIndex],
                  order: newOrder
                };
                if (isDateChanged) {
                  newSubtasks[dragItem.data.subtaskIndex].dueDate = finalDropDate;
                }
                return { ...t, subtasks: newSubtasks };
              }
            } else {
              if (t.id === dragItem.data.id) {
                if (isDateChanged) {
                  return { ...t, date: finalDropDate, dueDate: finalDropDate, order: newOrder };
                }
                return { ...t, order: newOrder };
              }
            }
            return t;
          }));
        }
      } else if (dragItem.type === 'template_task' && dropZoneWeek) {
        deploySingleTemplateTask(dragItem.data.project, dragItem.data.templateTask, dropZoneWeek);
      }

      setDragItem(null);
      setHoverDropDate(null);
      setHoverDropWeek(null);
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragItem, tasks, displayItems]);

  const handleEditTask = (task) => {
    setCreatingProgressTask(false);
    if (task.isRecurringOccurrence) {
      const schedule = recurringSchedules.find(item => item.id === task.recurringScheduleId);
      if (schedule) {
        setEditingRecurringSchedule(schedule);
        setIsRecurringModalOpen(true);
      }
      return;
    }
    setEditingTask(task);
    setIsTaskModalOpen(true);
  };

  const handleEditParentTask = (parentId) => {
    const parentTask = tasks.find(t => t.id === parentId);
    if (parentTask) {
      handleEditTask(parentTask);
    }
  };

  const handleDeleteTask = (taskId) => {
    setTasks(prev => prev.filter(t => t.id !== taskId));
    setIsTaskModalOpen(false);
    setEditingTask(null);
    showToast('タスクを削除しました');
  };

  const handleDeleteProject = (projectId) => {
    if (!selectedProject) return;
    const projectTitle = selectedProject.title;
    const projectType = selectedProject.type;

    setProjects(prev => prev.filter(p => p.id !== projectId));
    setTasks(prev => prev.filter(t => {
      if (t.projectId === projectId) return false;
      if (t.type === projectType && t.title.startsWith(`[${projectTitle}]`)) return false;
      return true;
    }));

    setPlannerView('list');
    setSelectedProject(null);
    showToast('イベントと関連タスクを削除しました');
  };

  const handleCompleteAction = (task) => {
    setCompletingTask(task);
  };

  const handleSaveRecurringSchedule = (scheduleData) => {
    if (scheduleData.id) {
      setRecurringSchedules(prev => prev.map(item => item.id === scheduleData.id ? { ...item, ...scheduleData } : item));
      showToast(`「${scheduleData.title}」を更新しました`);
    } else {
      setRecurringSchedules(prev => [...prev, { ...scheduleData, id: `r_${Date.now()}_${Math.random().toString(36).substring(2,9)}` }]);
      showToast(`「${scheduleData.title}」を作成しました`);
    }
    setIsRecurringModalOpen(false);
    setEditingRecurringSchedule(null);
  };

  const handleDeleteRecurringSchedule = (scheduleId) => {
    setRecurringSchedules(prev => prev.filter(item => item.id !== scheduleId));
    setRecurringCompletions(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${scheduleId}_`))));
    setIsRecurringModalOpen(false);
    setEditingRecurringSchedule(null);
    showToast('定期スケジュールを削除しました');
  };

  const handleCompleteSubtask = (parentId, subtaskIndex) => {
    // 古い直接完了関数は使用しませんが、他への影響を避けるため残しておきます
    setTasks(prev => prev.map(t => {
      if (t.id === parentId) {
        const newSubtasks = [...t.subtasks];
        newSubtasks[subtaskIndex] = {
          ...newSubtasks[subtaskIndex],
          completed: !newSubtasks[subtaskIndex].completed
        };
        return { ...t, subtasks: newSubtasks };
      }
      return t;
    }));
    showToast('小タスクの完了状態を更新しました');
  };

  const handleSaveCompletion = (taskId, richHtml, urls, isCompleted) => {
    if (completingTask?.isRecurringOccurrence) {
      const completionKey = `${completingTask.recurringScheduleId}_${completingTask.recurrenceDate}`;
      setRecurringCompletions(prev => ({
        ...prev,
        [completionKey]: withCompletionTimestamp(prev[completionKey] || { completed: false }, {
          ...(prev[completionKey] || {}),
          richResult: richHtml,
          resultUrls: urls,
          completed: isCompleted
        })
      }));
    } else if (completingTask?.isSubtask) {
      // 小タスクの場合の保存処理
      setTasks(prev => prev.map(t => {
        if (t.id === completingTask.parentId) {
          const newSubtasks = [...t.subtasks];
          newSubtasks[completingTask.subtaskIndex] = {
            ...newSubtasks[completingTask.subtaskIndex],
            richResult: richHtml,
            resultUrls: urls,
            completed: isCompleted
          };
          return { ...t, subtasks: newSubtasks };
        }
        return t;
      }));
    } else {
      // 親タスク・シンプルタスクの場合の保存処理
      setTasks(prev => prev.map(t => {
        if (t.id === taskId) {
          return { ...t, richResult: richHtml, resultUrls: urls, completed: isCompleted };
        }
        return t;
      }));
    }
    setCompletingTask(null);
    showToast(isCompleted ? 'タスクを完了状態にしました' : 'タスク情報を保存しました');
  };

  const deploySingleTemplateTask = (project, templateTask, weekStartDate) => {
    const existingTaskIndex = tasks.findIndex(
      t => t.type === project.type && t.title === `[${project.title}] ${templateTask.title}`
    );

    if (existingTaskIndex >= 0) {
      setTasks(prev => {
        const newTasks = [...prev];
        newTasks[existingTaskIndex] = {
          ...newTasks[existingTaskIndex],
          date: weekStartDate,
          dueDate: weekStartDate
        };
        return newTasks;
      });
      showToast(`「${templateTask.title}」の日程を ${weekStartDate.slice(5).replace('-','/')} の週に再設定しました`);
    } else {
      const newTask = {
        type: project.type,
        title: `[${project.title}] ${templateTask.title}`,
        date: weekStartDate,
        dueDate: weekStartDate,
        memo: '年間プランナーからの個別割り当て',
        urls: [],
        completed: false,
        completionNote: '',
        resultUrls: [],
        resultImages: [],
        order: Date.now(),
        id: `gen_${project.id}_${templateTask.id}_${Date.now()}_${Math.random().toString(36).substring(2,9)}`
      };
      setTasks(prev => [...prev, newTask]);
      showToast(`「${templateTask.title}」を ${weekStartDate.slice(5).replace('-','/')} の週に割り当てました`);
    }
  };

  const showToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => { setToastMessage(''); }, 3000);
  };

  const handleSaveTask = (taskData) => {
    if (taskData.isProjectSubtask) {
      setProjects(prev => prev.map(p => {
        if (p.id === taskData.projectId) {
          return {
            ...p,
            tasksTemplate: [...p.tasksTemplate, { id: `tt_${Date.now()}`, title: taskData.rawTitle }]
          };
        }
        return p;
      }));
    }

    const processedTaskData = {
      ...taskData,
      subtasks: taskData.subtasks?.map((st, i) => ({
        ...st,
        id: st.id || `sub_${Date.now()}_${i}_${Math.random().toString(36).substring(2,9)}`,
        order: st.order || Date.now() + i
      }))
    };

    if (!processedTaskData.id) {
      delete processedTaskData.id;
    }

    if (taskData.id) {
      setTasks(prev => prev.map(t => t.id === taskData.id ? {
        ...t, ...processedTaskData,
        date: t.dueDate !== processedTaskData.dueDate ? processedTaskData.dueDate : t.date
      } : t));
      showToast(`「${taskData.title}」を更新しました`);
    } else {
      const newTask = {
        date: taskData.dueDate,
        completed: false,
        completionNote: '',
        resultUrls: [],
        resultImages: [],
        order: Date.now(),
        ...processedTaskData,
        ...(creatingProgressTask ? { progressEnabled: true, progressStage: 'todo' } : {}),
        id: `t_${Date.now()}_${Math.random().toString(36).substring(2,9)}`
      };
      setTasks(prev => [...prev, newTask]);
      showToast(`「${taskData.title}」を作成しました`);
    }
    setIsTaskModalOpen(false);
    setEditingTask(null);
    setCreatingProgressTask(false);
  };

  const handleSaveNewProject = (projectData) => {
    const newProject = {
      id: `p_${Date.now()}`,
      ...projectData,
      tasksTemplate: []
    };
    setProjects(prev => [...prev, newProject]);
    setIsProjectModalOpen(false);
    showToast(`「${projectData.title}」を作成しました`);
  };

  const handleOpenTaskModalWithDate = (date) => {
    setCreatingProgressTask(false);
    setEditingTask(null);
    setNewTaskDefaultDate(date);
    setIsTaskModalOpen(true);
  };

  const handleOpenTaskModalFromFab = () => {
    setCreatingProgressTask(false);
    setEditingTask(null);
    setNewTaskDefaultDate(TODAY_STR);
    setIsTaskModalOpen(true);
  };

  const handleToggleProgress = (task, enabled) => {
    if (task.isRecurringOccurrence) {
      // Select this occurrence only; future dates keep their original recurrence.
      setTasks(previous => [...previous, {
        ...task, type: 'simple', isRecurringOccurrence: false,
        sourceRecurringScheduleId: task.recurringScheduleId,
        progressEnabled: enabled, progressStage: 'todo'
      }]);
    } else {
      handleUpdateProgressTask(task.id, current => ({
        ...current, progressEnabled: enabled,
        ...(enabled ? { progressStage: 'todo' } : {})
      }));
    }
  };

  const handleAddProgressTask = () => {
    setCreatingProgressTask(true);
    setEditingTask(null);
    setNewTaskDefaultDate(formatDate(new Date()));
    setIsTaskModalOpen(true);
  };

  const handleAddSubtask = () => {
    if (newSubtaskTitle.trim() && selectedProject) {
      const newTaskTemplate = { id: `tt_${Date.now()}`, title: newSubtaskTitle.trim() };

      setProjects(prev => prev.map(p => {
        if (p.id === selectedProject.id) {
          return { ...p, tasksTemplate: [...p.tasksTemplate, newTaskTemplate] };
        }
        return p;
      }));

      setSelectedProject(prev => ({
        ...prev,
        tasksTemplate: [...prev.tasksTemplate, newTaskTemplate]
      }));

      setNewSubtaskTitle('');
      setIsAddingSubtask(false);
    }
  };

  const getTaskForTemplate = (templateTask) => {
    if (!selectedProject) return null;
    return tasks.find(t => t.type === selectedProject.type && t.title === `[${selectedProject.title}] ${templateTask.title}`);
  };

  const getAssignedTasksForWeek = (weekStart) => {
    if (!selectedProject) return [];
    const weekStartD = new Date(weekStart);
    const weekEndD = addDays(weekStartD, 6);
    return tasks.filter(t => {
      if (t.type !== selectedProject.type) return false;
      if (!t.title.startsWith(`[${selectedProject.title}]`)) return false;
      const d = new Date(t.date);
      return d >= weekStartD && d <= weekEndD;
    });
  };

  const overdueTasks = useMemo(() => {
    return displayItems.filter(t => !t.completed && t.dueDate && new Date(t.dueDate) < new Date(TODAY_STR));
  }, [displayItems]);

  const todayTasks = useMemo(() => {
    return displayItems.filter(t => !t.completed && (t.date === TODAY_STR || t.dueDate === TODAY_STR) && !(new Date(t.dueDate) < new Date(TODAY_STR)));
  }, [displayItems]);

  const filteredTasks = useMemo(() => {
    return displayItems.filter(t => {
      if (filterCompleted === 'completed' && !t.completed) return false;
      if (filterCompleted === 'incomplete' && t.completed) return false;
      if (!showRecurringInList && t.isRecurringOccurrence) return false;

      if (filterProject !== 'all') {
        const targetProj = projects.find(p => p.id === filterProject);
        if (t.isSubtask) {
           const parentT = tasks.find(pt => pt.id === t.parentId);
           const isMatch = parentT?.projectId === filterProject || (targetProj && parentT?.title.startsWith(`[${targetProj.title}]`));
           if (!isMatch) return false;
        } else {
           const isMatch = t.projectId === filterProject || (targetProj && t.title.startsWith(`[${targetProj.title}]`));
           if (!isMatch) return false;
        }
      }

      if (searchQuery.trim() !== '') {
        const q = searchQuery.toLowerCase();
        const titleMatch = t.title?.toLowerCase().includes(q);
        const memoMatch = t.memo?.toLowerCase().includes(q);
        const noteMatch = t.completionNote?.toLowerCase().includes(q) || t.richResult?.toLowerCase().includes(q);
        const parentTitleMatch = t.isSubtask ? t.parentTitle?.toLowerCase().includes(q) : false;
        if (!titleMatch && !memoMatch && !noteMatch && !parentTitleMatch) return false;
      }

      return true;
    });
  }, [displayItems, filterCompleted, filterProject, searchQuery, projects, tasks, showRecurringInList]);

  if (!isDBReady) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100 flex-col gap-4 text-blue-600">
        <Loader2 className="animate-spin" size={48} />
        <p className="font-bold">データベースを読み込み中...</p>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-100 flex flex-col font-sans text-gray-800 overflow-hidden relative">
      <style>{`
        [contenteditable][data-placeholder]:empty:before {
          content: attr(data-placeholder);
          color: #9ca3af;
          pointer-events: none;
          display: block;
        }
        .rich-text-content img {
          max-height: 200px;
          border-radius: 0.5rem;
          margin: 0.5rem 0;
        }
      `}</style>
      <header className="bg-white border-b px-6 py-4 flex flex-wrap items-center justify-between z-10 shadow-sm shrink-0 gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-br from-blue-600 to-indigo-600 text-white p-2.5 rounded-xl shadow-md">
            <Calendar size={24} />
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tight text-gray-900 leading-none">TaskMatrix Pro</h1>
            <p className="text-xs text-gray-500 font-bold mt-1">Today: {TODAY_STR}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <details className="relative" data-file-backup>
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-slate-700 hover:bg-slate-100 bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold shadow-sm">
                <Download size={14} /><span>ファイル保存</span>
                {fileBackup.name && <span className={fileBackup.status === 'saved' ? 'text-emerald-700' : fileBackup.status === 'error' || fileBackup.status === 'permission' ? 'text-red-600' : 'text-amber-700'} role="status" aria-label="ファイル保存状態">{({ saved: '保存済み', saving: '保存中…', choosing: '選択中…', pending: '未保存', permission: '許可が必要', error: '保存失敗', ready: '接続済み' })[fileBackup.status]}</span>}
              </summary>
              <section aria-label="ファイル保存設定" className="absolute top-full left-0 mt-2 w-80 max-w-[calc(100vw-2rem)] bg-white border border-slate-200 rounded-xl shadow-lg p-4 space-y-3 z-50 text-sm font-normal">
                <p className="font-bold text-slate-800">ブラウザー外へのバックアップ</p>
                <p className="text-xs text-slate-500">タスク・トーク・画像・予定を、指定したJSONファイルに上書き保存します。復元は「インポート」から行えます。</p>
                {!fileBackup.supported ? <p className="text-xs text-amber-800" role="status">このブラウザーでは直接上書き保存に対応していません。Chrome・EdgeのHTTPS環境をご利用いただくか、「エクスポート」で保存してください。</p> : <>
                  <p className="text-xs break-all">保存先：{fileBackup.name || '未設定'}</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={fileBackup.chooseDestination} disabled={!fileBackup.ready || ['saving', 'choosing'].includes(fileBackup.status)} className="rounded-lg px-3 py-2 bg-blue-600 text-white text-xs font-bold disabled:opacity-50">{fileBackup.name ? '保存先を変更' : '保存先ファイルを選択'}</button>
                    <button type="button" onClick={() => fileBackup.writeNow(true)} disabled={!fileBackup.name || ['saving', 'choosing'].includes(fileBackup.status)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold disabled:opacity-50">今すぐ保存</button>
                  </div>
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={fileBackup.enabled} disabled={!fileBackup.ready || ['saving', 'choosing'].includes(fileBackup.status)} onChange={event => fileBackup.setEnabled(event.target.checked)} />変更時に自動で上書き保存</label>
                  <p className="text-xs text-slate-500">自動保存は変更から約1秒後に行います。この画面を開いている間に動作します。</p>
                  {fileBackup.lastSavedAt && <p className="text-xs text-slate-500">最終保存：{new Date(fileBackup.lastSavedAt).toLocaleString('ja-JP')}</p>}
                  {fileBackup.name && <button type="button" onClick={fileBackup.disconnect} disabled={['saving', 'choosing'].includes(fileBackup.status)} className="text-xs text-slate-500 underline disabled:opacity-50">保存先の接続を解除</button>}
                </>}
                {fileBackup.message && <p className={`text-xs ${['error', 'permission'].includes(fileBackup.status) ? 'text-red-700' : 'text-slate-600'}`} role={['error', 'permission'].includes(fileBackup.status) ? 'alert' : 'status'}>{fileBackup.message}</p>}
                {fileBackup.settingsWarning && <p className="text-xs text-amber-800" role="alert">{fileBackup.settingsWarning}</p>}
              </section>
            </details>
            <input
              type="file"
              aria-label="バックアップをインポート"
              accept=".json"
              style={{ display: 'none' }}
              ref={fileInputRef}
              onChange={handleImport}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 text-gray-500 hover:text-blue-600 bg-gray-50 hover:bg-blue-50 px-3 py-1.5 rounded-lg border border-gray-200 transition-colors text-xs font-bold shadow-sm"
              title="JSONファイルからインポート"
            >
              <Upload size={14} /> <span className="hidden sm:inline">インポート</span>
            </button>
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 text-gray-500 hover:text-blue-600 bg-gray-50 hover:bg-blue-50 px-3 py-1.5 rounded-lg border border-gray-200 transition-colors text-xs font-bold shadow-sm"
              title="JSONファイルへエクスポート"
            >
              <Download size={14} /> <span className="hidden sm:inline">エクスポート</span>
            </button>
            <button
              onClick={() => setIsReportModalOpen(true)}
              className="flex items-center gap-1.5 text-blue-700 hover:bg-blue-100 bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-200 transition-colors text-xs font-bold shadow-sm"
              title="週報用レポートをWordファイルで作成"
            >
              <FileText size={14} /> <span>レポート作成</span>
            </button>
          </div>

          <div className="flex flex-wrap bg-gray-100 p-1.5 rounded-xl border border-gray-200">
            <button
              onClick={() => setActiveTab('today')}
              className={`flex items-center gap-2 px-4 md:px-5 py-2.5 rounded-lg text-sm font-bold transition-all ${activeTab === 'today' ? 'bg-white shadow-sm text-blue-700 ring-1 ring-gray-200' : 'text-gray-500 hover:text-gray-700'}`}
            >
              <Bell size={18} /> <span className="hidden sm:inline">今日 / 期限切れ</span>
            </button>
            <button
              onClick={() => setActiveTab('board')}
              className={`flex items-center gap-2 px-4 md:px-5 py-2.5 rounded-lg text-sm font-bold transition-all ${activeTab === 'board' ? 'bg-white shadow-sm text-blue-700 ring-1 ring-gray-200' : 'text-gray-500 hover:text-gray-700'}`}
            >
              <Layout size={18} /> <span className="hidden sm:inline">ボード</span>
            </button>
            <button
              onClick={() => setActiveTab('progress')}
              className={`flex items-center gap-2 px-4 md:px-5 py-2.5 rounded-lg text-sm font-bold transition-all ${activeTab === 'progress' ? 'bg-white shadow-sm text-blue-700 ring-1 ring-gray-200' : 'text-gray-500 hover:text-gray-700'}`}
            >
              <CheckSquare size={18} /> <span>進捗</span>
            </button>
            <button
              onClick={() => setActiveTab('list')}
              className={`flex items-center gap-2 px-4 md:px-5 py-2.5 rounded-lg text-sm font-bold transition-all ${activeTab === 'list' ? 'bg-white shadow-sm text-blue-700 ring-1 ring-gray-200' : 'text-gray-500 hover:text-gray-700'}`}
            >
              <List size={18} /> <span className="hidden sm:inline">一覧・検索</span>
            </button>
            <button
              onClick={() => setActiveTab('recurring')}
              className={`flex items-center gap-2 px-4 md:px-5 py-2.5 rounded-lg text-sm font-bold transition-all ${activeTab === 'recurring' ? 'bg-white shadow-sm text-blue-700 ring-1 ring-gray-200' : 'text-gray-500 hover:text-gray-700'}`}
            >
              <Repeat size={18} /> <span className="hidden sm:inline">定期</span>
            </button>
            <button
              onClick={() => setActiveTab('planner')}
              className={`flex items-center gap-2 px-4 md:px-5 py-2.5 rounded-lg text-sm font-bold transition-all ${activeTab === 'planner' ? 'bg-white shadow-sm text-blue-700 ring-1 ring-gray-200' : 'text-gray-500 hover:text-gray-700'}`}
            >
              <Settings size={18} /> <span className="hidden sm:inline">プランナー</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-hidden relative">

        {activeTab === 'progress' && (
          <ProgressPage tasks={tasks} onUpdateTask={handleUpdateProgressTask} onAddTask={handleAddProgressTask} />
        )}

        {activeTab === 'today' && (
          <div className="h-full flex flex-col p-4 md:p-6 pb-24 max-w-[1200px] mx-auto w-full overflow-y-auto">
            <div className="space-y-8">

              <section>
                <h2 className="text-xl font-black text-red-600 flex items-center gap-2 mb-4 border-b-2 border-red-200 pb-2">
                  <AlertCircle size={24} /> 期限切れタスク ({overdueTasks.length})
                </h2>
                <div className="space-y-3 min-h-[50px]" data-drop-zone="list">
                  {overdueTasks.length > 0 ? (
                    overdueTasks.map(task => (
                      <ListViewTask
                        key={task.id}
                        task={task}
                        onEdit={t => t.isSubtask ? handleEditParentTask(t.parentId) : handleEditTask(t)}
                        onCompleteAction={handleCompleteAction}
                        onPointerDown={handlePointerDown}
                      />
                    ))
                  ) : (
                    <div className="flex flex-col items-center justify-center p-8 bg-green-50 border border-green-200 rounded-xl text-green-700 gap-2">
                      <CheckSquare size={32} className="opacity-50" />
                      <p className="font-bold text-sm">期限切れのタスクはありません！素晴らしいです。</p>
                    </div>
                  )}
                </div>
              </section>

              <section>
                <h2 className="text-xl font-black text-blue-800 flex items-center gap-2 mb-4 border-b-2 border-blue-200 pb-2">
                  <CalendarDays size={24} /> 今日のタスク ({todayTasks.length})
                </h2>
                <div className="space-y-3 min-h-[50px]" data-drop-zone="list" data-drop-date={TODAY_STR}>
                  {todayTasks.length > 0 ? (
                    todayTasks.map(task => (
                      <ListViewTask
                        key={task.id}
                        task={task}
                        onEdit={t => t.isSubtask ? handleEditParentTask(t.parentId) : handleEditTask(t)}
                        onCompleteAction={handleCompleteAction}
                        onPointerDown={handlePointerDown}
                      />
                    ))
                  ) : (
                    <div className="flex flex-col items-center justify-center p-8 bg-gray-50 border border-gray-200 rounded-xl text-gray-500 gap-2">
                      <Calendar size={32} className="opacity-30" />
                      <p className="font-bold text-sm">今日予定されている未完了のタスクはありません。</p>
                    </div>
                  )}
                </div>
              </section>

            </div>
          </div>
        )}

        {activeTab === 'board' && (
          <div className="h-full overflow-y-auto p-4 md:p-6 pb-24 scroll-smooth">
            <div className="max-w-[1600px] mx-auto space-y-6">

              {mainBoardWeeks.map((week) => (
                <section key={week.offset} ref={week.isThisWeek ? thisWeekRef : null} className="scroll-mt-24">
                  <div className="flex items-center gap-3 mb-4 pl-2">
                    <div className={`px-4 py-1.5 rounded-full font-black text-sm flex items-center gap-2
                      ${week.isThisWeek ? 'bg-blue-100 text-blue-800' :
                        week.isNextWeek ? 'bg-emerald-100 text-emerald-800' :
                        week.offset < 0 ? 'bg-gray-200 text-gray-700' : 'bg-purple-100 text-purple-800'}`}>
                      <Calendar size={16}/> {getWeekLabel(week.offset)}
                    </div>
                    <span className="text-gray-500 font-medium text-sm">{week.days[0].date} ~ {week.days[4].date}</span>
                  </div>
                  <div className="flex gap-4 overflow-x-auto pb-4 snap-x pl-2">
                    {week.days.map((day, idx) => (
                      <div key={`${week.offset}-${idx}`} className="snap-start">
                        <BoardColumn
                          date={day.date}
                          dateLabel={day.label}
                          tasks={displayItems.filter(t => (showCompletedTasks || !t.completed) && t.date === day.date).sort((a, b) => a.order - b.order)}
                          onEdit={t => t.isSubtask ? handleEditParentTask(t.parentId) : handleEditTask(t)}
                          onCompleteAction={handleCompleteAction}
                          onPointerDown={handlePointerDown}
                          isHovered={hoverDropDate === day.date}
                          onAddTask={handleOpenTaskModalWithDate}
                          onCompleteSubtask={handleCompleteSubtask}
                          onEditParentTask={handleEditParentTask}
                          onToggleProgress={handleToggleProgress}
                        />
                      </div>
                    ))}
                  </div>
                </section>
              ))}

            </div>
          </div>
        )}

        {activeTab === 'list' && (
          <div className="h-full flex flex-col p-4 md:p-6 pb-24 max-w-[1200px] mx-auto w-full">
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 flex flex-col overflow-hidden h-full">

              <div className="p-4 md:p-6 border-b bg-gray-50 flex flex-col gap-4 shrink-0">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-black text-gray-800 flex items-center gap-2">
                    <List size={24} className="text-blue-600"/> タスク一覧・検索
                  </h2>
                  <span className="text-sm font-bold text-gray-500 bg-gray-200 px-3 py-1 rounded-full">{filteredTasks.length} 件</span>
                </div>

                <div className="flex flex-col md:flex-row gap-3">
                  <div className="flex-1 relative">
                    <Search size={18} className="absolute left-3 top-3.5 text-gray-400" />
                    <input
                      type="text"
                      placeholder="タイトル、メモ、結果/成果からキーワード検索..."
                      className="w-full pl-10 pr-4 py-3 rounded-xl border-2 border-gray-200 focus:border-blue-500 focus:outline-none transition-colors text-sm font-medium"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>

                  <div className="flex flex-col sm:flex-row gap-3">
                    <select
                      className="py-3 px-4 rounded-xl border-2 border-gray-200 bg-white text-sm font-bold focus:border-blue-500 outline-none text-gray-700"
                      value={filterCompleted}
                      onChange={(e) => setFilterCompleted(e.target.value)}
                    >
                      <option value="all">完了状態: すべて</option>
                      <option value="incomplete">未完了のみ</option>
                      <option value="completed">完了済みのみ</option>
                    </select>

                    <select
                      className="py-3 px-4 rounded-xl border-2 border-gray-200 bg-white text-sm font-bold focus:border-blue-500 outline-none text-gray-700 max-w-full sm:max-w-[240px]"
                      value={filterProject}
                      onChange={(e) => setFilterProject(e.target.value)}
                    >
                      <option value="all">全プロジェクト・イベント</option>
                      {projects.map(p => (
                        <option key={p.id} value={p.id}>{p.title}</option>
                      ))}
                    </select>

                    <button
                      type="button"
                      onClick={() => setShowRecurringInList(prev => !prev)}
                      className={`py-3 px-4 rounded-xl border-2 text-sm font-bold transition-colors flex items-center justify-center gap-2 whitespace-nowrap ${showRecurringInList ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}
                      title="一覧に定期スケジュールを表示するか切り替え"
                    >
                      <Repeat size={16} />
                      定期: {showRecurringInList ? '表示' : '非表示'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-gray-50/50">
                <div className="space-y-3" data-drop-zone="list">
                  {filteredTasks.length > 0 ? (
                    filteredTasks.map(task => (
                      <ListViewTask
                        key={task.id}
                        task={task}
                        onEdit={t => t.isSubtask ? handleEditParentTask(t.parentId) : handleEditTask(t)}
                        onCompleteAction={handleCompleteAction}
                        onPointerDown={handlePointerDown}
                      />
                    ))
                  ) : (
                    <div className="flex flex-col items-center justify-center h-40 text-gray-400 gap-3">
                      <Search size={32} className="opacity-20" />
                      <p className="font-bold">条件に一致するタスクが見つかりません</p>
                    </div>
                  )}
                </div>
              </div>

            </div>
          </div>
        )}

        {activeTab === 'recurring' && (
          <div className="h-full flex flex-col p-4 md:p-6 pb-24 max-w-[1200px] mx-auto w-full overflow-y-auto">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
              <div>
                <h2 className="text-2xl font-black text-gray-900 flex items-center gap-2">
                  <Repeat size={28} className="text-green-600" /> 定期スケジュール管理
                </h2>
                <p className="text-sm text-gray-500 font-medium mt-1">開始時期・終了時期を指定して、日次・週次・月次の予定を自動でボードに表示します。</p>
              </div>
              <button
                onClick={() => { setEditingRecurringSchedule(null); setIsRecurringModalOpen(true); }}
                className="bg-green-600 hover:bg-green-700 text-white px-5 py-3 rounded-xl font-bold shadow-lg hover:shadow-xl transition-all flex items-center gap-2 justify-center"
              >
                <Plus size={20} /> 定期スケジュールを作成
              </button>
            </div>

            {recurringSchedules.length === 0 ? (
              <div className="bg-white border-2 border-dashed border-gray-300 rounded-2xl p-10 text-center text-gray-500">
                <Repeat size={48} className="mx-auto mb-3 text-gray-300" />
                <p className="font-bold">定期スケジュールはまだありません。</p>
                <p className="text-sm mt-1">右上の作成ボタンから、繰り返し予定を登録してください。</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {recurringSchedules.map(schedule => {
                  const scheduleOccurrences = recurringOccurrences.filter(item => item.recurringScheduleId === schedule.id);
                  const upcomingOccurrences = scheduleOccurrences.filter(item => item.date >= TODAY_STR).slice(0, 3);
                  return (
                    <div key={schedule.id} className="bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-md transition-all p-5 flex flex-col gap-4">
                      <div className="flex justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <span className="text-[10px] font-black tracking-wider uppercase px-2 py-0.5 rounded-full bg-green-100 text-green-700">Recurring</span>
                            <span className="text-xs font-bold text-green-700 bg-green-50 border border-green-100 px-2 py-0.5 rounded-full">{getFrequencyLabel(schedule.frequency, schedule.interval)}</span>
                          </div>
                          <h3 className="text-lg font-black text-gray-900 truncate">{schedule.title}</h3>
                          {schedule.memo && <p className="text-sm text-gray-500 mt-1 line-clamp-2">{schedule.memo}</p>}
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button
                            onClick={() => { setEditingRecurringSchedule(schedule); setIsRecurringModalOpen(true); }}
                            className="p-2 text-gray-500 hover:text-blue-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-blue-50 transition-colors"
                            title="編集"
                          >
                            <Pencil size={18} />
                          </button>
                          <button
                            onClick={() => handleDeleteRecurringSchedule(schedule.id)}
                            className="p-2 text-gray-500 hover:text-red-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-red-50 transition-colors"
                            title="削除"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3 bg-gray-50 rounded-xl p-3 border border-gray-100">
                        <div>
                          <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider">開始時期</p>
                          <p className="text-sm font-bold text-gray-800 flex items-center gap-1 mt-1"><CalendarDays size={14} className="text-green-600" /> {schedule.startDate}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider">終了時期</p>
                          <p className="text-sm font-bold text-gray-800 flex items-center gap-1 mt-1"><CalendarDays size={14} className="text-green-600" /> {schedule.endDate || '期限なし'}</p>
                        </div>
                      </div>

                      <div>
                        <p className="text-xs font-black text-gray-500 uppercase tracking-wider mb-2">次回予定</p>
                        {upcomingOccurrences.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {upcomingOccurrences.map(item => (
                              <span key={item.id} className={`text-xs font-bold px-3 py-1.5 rounded-lg border ${item.completed ? 'bg-green-50 text-green-700 border-green-200' : 'bg-blue-50 text-blue-700 border-blue-200'}`}>
                                {item.date}{item.completed ? ' 完了' : ''}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-gray-400 font-medium">表示対象期間内の今後の予定はありません。</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'planner' && (
          <div className="h-full flex flex-col p-4 md:p-6 pb-24 max-w-[1600px] mx-auto relative">

            {plannerView === 'list' ? (
              <div className="flex-1 bg-white rounded-2xl shadow-sm border border-gray-200 flex flex-col overflow-hidden">
                <div className="p-5 border-b bg-gray-50 flex items-center gap-3">
                  <CalendarDays className="text-blue-600" size={24}/>
                  <div>
                    <h2 className="font-black text-xl text-gray-800">イベント・プロジェクト一覧</h2>
                    <p className="text-sm text-gray-500 mt-0.5">カードを選択して年間スケジュールへの割り当てを開始します</p>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-6 bg-gray-50/30">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {projects.map(proj => (
                      <div
                        key={proj.id}
                        onClick={() => { setSelectedProject(proj); setPlannerView('detail'); setIsAddingSubtask(false); }}
                        className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-300 cursor-pointer transition-all group relative overflow-hidden"
                      >
                        <div className="flex items-center gap-2 mb-3">
                          <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-md
                            ${proj.type === 'project' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'}`}>
                            {proj.type === 'project' ? 'Project' : 'Evaluation'}
                          </span>
                        </div>
                        <h3 className="font-black text-lg text-gray-800 leading-tight group-hover:text-blue-700 transition-colors">
                          {proj.title}
                        </h3>
                        <p className="text-sm text-gray-500 mt-2 font-medium">小タスク数: {proj.tasksTemplate.length} 個</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col overflow-hidden gap-4">
                <div className="flex items-center justify-between bg-white p-4 rounded-2xl shadow-sm border border-gray-200 shrink-0">
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => setPlannerView('list')}
                      className="flex items-center gap-2 text-gray-600 hover:text-blue-700 hover:bg-blue-50 px-4 py-2 rounded-xl font-bold text-sm transition-colors"
                    >
                      <ArrowLeft size={18} /> 一覧に戻る
                    </button>
                    <div className="w-px h-6 bg-gray-200"></div>
                    <h2 className="text-xl font-black text-gray-800 flex items-center gap-2">
                      {selectedProject?.title}
                    </h2>
                  </div>
                  <button
                    onClick={() => handleDeleteProject(selectedProject.id)}
                    className="flex items-center gap-2 text-red-600 hover:bg-red-50 hover:text-red-700 px-3 py-2 rounded-xl font-bold text-sm transition-colors border border-red-200"
                    title="イベントを削除"
                  >
                    <Trash2 size={16} /> <span className="hidden sm:inline">削除</span>
                  </button>
                </div>

                <div className="flex-1 flex flex-row gap-4 md:gap-6 overflow-hidden">

                  <div className="w-48 sm:w-64 md:w-80 bg-white rounded-2xl shadow-sm border border-gray-200 flex flex-col overflow-hidden shrink-0">
                    <div className="p-4 border-b bg-blue-50/50">
                      <h3 className="font-bold text-gray-800 text-sm">小タスク一覧</h3>
                      <p className="text-xs text-blue-600 font-bold mt-1">右側の週枠へドラッグ＆ドロップ</p>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50/50">
                      {selectedProject?.tasksTemplate.map((t) => {
                        const assignedTask = getTaskForTemplate(t);
                        const isAssigned = !!assignedTask;

                        return (
                          <div
                            key={t.id}
                            className={`border-2 rounded-xl p-3 flex flex-col gap-1.5 shadow-sm hover:border-blue-400 hover:shadow-md transition-all cursor-grab active:cursor-grabbing group
                              ${isAssigned ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-200'}`}
                            onPointerDown={(e) => handlePointerDown(e, 'template_task', { project: selectedProject, templateTask: t })}
                          >
                            <div className="flex gap-2 items-start">
                              <GripVertical size={18} className="text-gray-300 group-hover:text-blue-500 shrink-0 mt-0.5" />
                              <span className="font-bold text-sm text-gray-700 leading-tight">{t.title}</span>
                            </div>

                            {isAssigned && (
                              <div className="pl-6 text-[11px] font-bold text-blue-600 flex items-center gap-1">
                                <Calendar size={12} />
                                {assignedTask.date.slice(5).replace('-', '/')} 週に割当済
                              </div>
                            )}
                          </div>
                        );
                      })}

                      <div className="pt-2 border-t border-gray-200 mt-4">
                        {isAddingSubtask ? (
                          <div className="bg-white border-2 border-blue-300 rounded-xl p-3 flex flex-col gap-2 shadow-sm">
                            <input
                              autoFocus
                              type="text"
                              value={newSubtaskTitle}
                              onChange={e => setNewSubtaskTitle(e.target.value)}
                              className="text-sm border-2 border-gray-200 p-2 rounded-lg focus:border-blue-500 focus:outline-none"
                              placeholder="新しい小タスク名"
                              onKeyDown={e => e.key === 'Enter' && handleAddSubtask()}
                            />
                            <div className="flex justify-end gap-2 mt-1">
                              <button onClick={() => setIsAddingSubtask(false)} className="text-xs text-gray-500 font-bold px-2 py-1 hover:bg-gray-100 rounded">キャンセル</button>
                              <button onClick={handleAddSubtask} className="text-xs bg-blue-600 text-white font-bold px-3 py-1.5 rounded-lg hover:bg-blue-700">追加する</button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => setIsAddingSubtask(true)}
                            className="w-full border-2 border-dashed border-gray-300 rounded-xl p-3 flex gap-2 items-center justify-center text-gray-500 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-colors"
                          >
                            <Plus size={18} />
                            <span className="font-bold text-sm">小タスクを追加</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex-1 bg-white rounded-2xl shadow-sm border border-gray-200 flex flex-col overflow-hidden">
                    <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
                      <h3 className="font-bold text-gray-800 text-sm flex items-center gap-2">
                        <Calendar size={16}/> 年間スケジュール割り当て枠
                      </h3>
                      <span className="text-xs text-gray-500 font-bold bg-white px-3 py-1 rounded-md border border-gray-200 hidden sm:inline-block">全52週</span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-gray-100/50">
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
                        {yearWeeks.map((week) => {
                          const isTarget = hoverDropWeek === week.startDate && dragItem?.type === 'template_task';
                          const assignedTasks = getAssignedTasksForWeek(week.startDate);

                          return (
                            <div
                              key={week.startDate}
                              data-drop-week={week.startDate}
                              className={`border-2 rounded-xl flex flex-col overflow-hidden transition-all duration-200 min-h-[120px]
                                ${isTarget ? 'border-blue-500 bg-blue-50 shadow-lg scale-105 transform' : 'border-gray-200 bg-white hover:border-blue-300'}`}
                            >
                              <div className={`px-2 py-1.5 text-center border-b flex justify-between items-center
                                ${isTarget ? 'bg-blue-500 text-white' : 'bg-gray-50 text-gray-500'}`}>
                                <span className="text-[10px] font-black uppercase tracking-widest">W{week.weekNum}</span>
                                <span className="text-xs font-bold">{week.startDate.slice(5).replace('-', '/')}</span>
                              </div>

                              <div className="flex-1 p-2 flex flex-col gap-1 overflow-y-auto">
                                {assignedTasks.length > 0 ? (
                                  assignedTasks.map(at => (
                                    <div key={at.id} className="text-[10px] bg-blue-100 text-blue-800 px-1.5 py-1 rounded border border-blue-200 leading-tight">
                                      {at.title.replace(`[${selectedProject.title}] `, '')}
                                    </div>
                                  ))
                                ) : (
                                  <div className="flex-1 flex items-center justify-center">
                                    <span className="text-[10px] text-gray-300 font-bold">ドロップして配置</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <div className={`${activeTab === 'progress' ? 'hidden' : 'fixed'} bottom-8 right-8 flex flex-col items-end gap-3 z-40`}>
        <label className="flex items-center gap-2 cursor-pointer bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 rounded-full px-4 py-3 shadow-lg transition-all font-bold text-sm">
          <input
            type="checkbox"
            checked={showCompletedTasks}
            onChange={e => setShowCompletedTasks(e.target.checked)}
            className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
          />
          <span className="hidden sm:inline">完了したタスクを表示</span>
          <span className="sm:hidden">完了を表示</span>
        </label>

        {activeTab === 'board' && (
          <button
            onClick={scrollToThisWeek}
            className="bg-white border border-gray-200 text-gray-700 hover:text-blue-600 hover:bg-blue-50 rounded-full px-4 py-3 shadow-lg transition-all flex items-center gap-2 font-bold text-sm"
          >
            <CalendarDays size={20} />
            <span className="hidden sm:inline">今週へ戻る</span>
          </button>
        )}

        {(activeTab === 'board' || activeTab === 'today') && (
          <button
            onClick={handleOpenTaskModalFromFab}
            className="bg-blue-600 hover:bg-blue-700 text-white rounded-full p-4 shadow-2xl hover:shadow-blue-500/50 transition-all transform hover:-translate-y-1 flex items-center justify-center group"
          >
            <Plus size={28} />
            <span className="max-w-0 overflow-hidden whitespace-nowrap group-hover:max-w-[120px] transition-all duration-300 font-bold px-0 group-hover:px-2">タスク作成</span>
          </button>
        )}

        {activeTab === 'recurring' && (
          <button
            onClick={() => { setEditingRecurringSchedule(null); setIsRecurringModalOpen(true); }}
            className="bg-green-600 hover:bg-green-700 text-white rounded-full p-4 shadow-2xl hover:shadow-green-500/50 transition-all transform hover:-translate-y-1 flex items-center justify-center group"
          >
            <Plus size={28} />
            <span className="max-w-0 overflow-hidden whitespace-nowrap group-hover:max-w-[160px] transition-all duration-300 font-bold px-0 group-hover:px-2">定期作成</span>
          </button>
        )}

        {activeTab === 'planner' && plannerView === 'list' && (
          <button
            onClick={() => setIsProjectModalOpen(true)}
            className="bg-purple-600 hover:bg-purple-700 text-white rounded-full p-4 shadow-2xl hover:shadow-purple-500/50 transition-all transform hover:-translate-y-1 flex items-center justify-center group"
          >
            <Plus size={28} />
            <span className="max-w-0 overflow-hidden whitespace-nowrap group-hover:max-w-[120px] transition-all duration-300 font-bold px-0 group-hover:px-2">イベント作成</span>
          </button>
        )}
      </div>

      {toastMessage && (
        <div className="fixed bottom-10 left-1/2 transform -translate-x-1/2 bg-gray-800 text-white px-6 py-3 rounded-full shadow-2xl z-50 font-bold text-sm transition-opacity duration-300 ease-in-out whitespace-nowrap pointer-events-none">
          {toastMessage}
        </div>
      )}

      {dragItem && (
        <div
          style={{
            position: 'fixed',
            top: dragItem.clientY - dragItem.offsetY,
            left: dragItem.clientX - dragItem.offsetX,
            width: dragItem.width || 280,
            pointerEvents: 'none',
            zIndex: 9999,
            transform: 'rotate(3deg) scale(1.05)',
            transition: 'transform 0.05s',
            opacity: 0.95,
          }}
        >
          {dragItem.type === 'task' && (
            <div className="bg-white border-2 border-blue-500 p-3 rounded-xl shadow-2xl flex gap-3 opacity-95">
              <GripVertical size={20} className="text-blue-500" />
              <div>
                <div className="text-[10px] font-black text-blue-600 uppercase mb-0.5">
                  {dragItem.data.isSubtask ? 'Moving Subtask...' : 'Moving Task...'}
                </div>
                <h4 className="font-bold text-sm text-gray-800">{dragItem.data.title}</h4>
              </div>
            </div>
          )}
          {dragItem.type === 'template_task' && (
            <div className="bg-white border-2 border-blue-500 p-3 rounded-xl shadow-2xl flex items-center gap-3 opacity-95">
              <GripVertical size={20} className="text-blue-500" />
              <div>
                <div className="text-[10px] font-black text-blue-600 uppercase mb-0.5">Assigning...</div>
                <span className="font-bold text-sm text-gray-800">{dragItem.data.templateTask.title}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {isReportModalOpen && <WeeklyReportModal
        tasks={displayItems.filter(task => !task.isSubtask)}
        onClose={() => setIsReportModalOpen(false)}
        onCreated={() => showToast('週報用レポートをダウンロードしました')}
      />}
      <TaskModal
        isOpen={isTaskModalOpen}
        onClose={() => { setIsTaskModalOpen(false); setEditingTask(null); setCreatingProgressTask(false); }}
        onSave={handleSaveTask}
        onDelete={handleDeleteTask}
        defaultDate={newTaskDefaultDate}
        editingTask={editingTask}
        projects={projects}
      />
      <ProjectModal
        isOpen={isProjectModalOpen}
        onClose={() => setIsProjectModalOpen(false)}
        onSave={handleSaveNewProject}
      />
      <RecurringScheduleModal
        isOpen={isRecurringModalOpen}
        onClose={() => { setIsRecurringModalOpen(false); setEditingRecurringSchedule(null); }}
        onSave={handleSaveRecurringSchedule}
        onDelete={handleDeleteRecurringSchedule}
        editingSchedule={editingRecurringSchedule}
      />
      <CompletionModal
        isOpen={!!completingTask}
        task={completingTask}
        onClose={() => setCompletingTask(null)}
        onSave={handleSaveCompletion}
      />

    </div>
  );
}
