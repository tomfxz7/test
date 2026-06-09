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
  Repeat
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

const getLastDayOfMonth = (date) => {
  const d = getLocalDate(date);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
};

const getMonthlyOccurrenceDate = (date, dayOfMonth) => {
  const base = getLocalDate(date);
  const targetDay = Math.max(1, Math.min(31, Number(dayOfMonth) || base.getDate()));
  const lastDay = getLastDayOfMonth(base);
  return new Date(base.getFullYear(), base.getMonth(), Math.min(targetDay, lastDay));
};

const getFirstRecurringOccurrenceDate = (schedule) => {
  const start = getLocalDate(schedule.startDate);
  if (schedule.frequency === 'weekly') {
    const targetDay = Number.isInteger(Number(schedule.recurrenceDay)) ? Number(schedule.recurrenceDay) : start.getDay();
    const offset = (targetDay - start.getDay() + 7) % 7;
    return addDays(start, offset);
  }
  if (schedule.frequency === 'monthly') {
    const targetDay = Number(schedule.recurrenceDay) || start.getDate();
    const candidate = getMonthlyOccurrenceDate(start, targetDay);
    return candidate < start ? getMonthlyOccurrenceDate(addMonths(start, 1), targetDay) : candidate;
  }
  return start;
};

const getRecurringNextOccurrenceDate = (date, schedule) => {
  if (schedule.frequency === 'monthly') {
    return getMonthlyOccurrenceDate(addMonths(date, Math.max(1, Number(schedule.interval) || 1)), schedule.recurrenceDay);
  }
  return getRecurringStepDate(date, schedule.frequency, schedule.interval);
};

const weekdayLabels = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];

const getFrequencyLabel = (frequency, interval = 1) => {
  const safeInterval = Math.max(1, Number(interval) || 1);
  const unit = frequency === 'daily' ? '日' : frequency === 'monthly' ? 'か月' : '週';
  return safeInterval === 1 ? `毎${unit}` : `${safeInterval}${unit}ごと`;
};

const getRecurrenceDetailLabel = (schedule) => {
  if (schedule.frequency === 'weekly') {
    const day = Number.isInteger(Number(schedule.recurrenceDay)) ? Number(schedule.recurrenceDay) : getLocalDate(schedule.startDate).getDay();
    return weekdayLabels[day];
  }
  if (schedule.frequency === 'monthly') {
    return `${Number(schedule.recurrenceDay) || getLocalDate(schedule.startDate).getDate()}日`;
  }
  return '毎回';
};

const buildRecurringOccurrenceId = (scheduleId, date) => `rec_${scheduleId}_${date}`;

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
    startDate: TODAY_STR,
    endDate: '',
    recurrenceDay: getLocalDate(TODAY_STR).getDay(),
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

const TaskCard = ({ task, onEdit, onCompleteAction, onPointerDown, onCompleteSubtask, onEditParentTask }) => {
  const isOverdue = new Date(task.dueDate) < new Date(TODAY_STR) && !task.completed;
  const isCompleted = task.completed;
  const [isSubtasksOpen, setIsSubtasksOpen] = useState(false);

  const stateClasses = isCompleted
    ? "bg-gray-50 border-gray-200 opacity-60"
    : isOverdue
      ? "bg-red-50 border-red-300 hover:border-red-400"
      : "bg-white border-gray-200 hover:border-blue-300";

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
                    <div key={i} className="flex justify-between items-center text-[10px] text-gray-600 bg-white border border-gray-100 rounded px-1.5 py-1">
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

const BoardColumn = ({ date, dateLabel, tasks, onEdit, onCompleteAction, onPointerDown, isHovered, onAddTask, onCompleteSubtask, onEditParentTask }) => {
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
      ${isCompleted ? 'bg-gray-50 border-gray-200 opacity-80' : isOverdue ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200 shadow-sm hover:border-blue-300'}`}
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
        setSubtasks(editingTask.subtasks || []);
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
                    const newSt = [...subtasks]; newSt[i].title = e.target.value; setSubtasks(newSt);
                  }}/>
                  <input type="date" required className="border-2 border-orange-100 p-2 rounded-lg text-sm w-36 focus:border-orange-400 focus:outline-none" value={st.dueDate} onChange={e => {
                    const newSt = [...subtasks]; newSt[i].dueDate = e.target.value; setSubtasks(newSt);
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
    if (editorRef.current && html !== undefined && editorRef.current.innerHTML !== html) {
      editorRef.current.innerHTML = html || '';
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
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        onClick={handleEditorClick}
        data-placeholder="結論・成果を入力。文字と画像を自由に混ぜて記述でき、画像をペースト(Ctrl+V)することも可能です。テキストを選択してCtrl+Kでリンク挿入も可能。"
      />
    </div>
  );
};

const CompletionModal = ({ isOpen, task, onClose, onSave }) => {
  const richHtmlRef = useRef('');
  const [richHtml, setRichHtml] = useState('');
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
      richHtmlRef.current = initialHtml;
      setRichHtml(initialHtml);
      setUrls(task.resultUrls && task.resultUrls.length > 0 ? task.resultUrls : ['']);
    } else {
      richHtmlRef.current = '';
      setRichHtml('');
    }
  }, [isOpen, task]);

  if (!isOpen || !task) return null;

  const handleRichHtmlChange = (html) => {
    richHtmlRef.current = html;
    setRichHtml(html);
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
    startDate: TODAY_STR,
    endDate: '',
    recurrenceDay: getLocalDate(TODAY_STR).getDay(),
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
          startDate: editingSchedule.startDate || TODAY_STR,
          endDate: editingSchedule.endDate || '',
          recurrenceDay: editingSchedule.recurrenceDay ?? (editingSchedule.frequency === 'monthly' ? getLocalDate(editingSchedule.startDate || TODAY_STR).getDate() : getLocalDate(editingSchedule.startDate || TODAY_STR).getDay()),
          memo: editingSchedule.memo || '',
          urls: editingSchedule.urls && editingSchedule.urls.length > 0 ? editingSchedule.urls : ['']
        });
      } else {
        setFormData({ title: '', frequency: 'weekly', interval: 1, startDate: TODAY_STR, endDate: '', recurrenceDay: getLocalDate(TODAY_STR).getDay(), memo: '', urls: [''] });
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
      startDate: formData.startDate,
      endDate: formData.endDate,
      recurrenceDay: formData.frequency === 'daily' ? undefined : Number(formData.recurrenceDay),
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
              <select
                required
                className="w-full border-2 border-gray-200 p-3 rounded-xl focus:border-green-500 focus:outline-none bg-white"
                value={formData.frequency}
                onChange={e => {
                  const nextFrequency = e.target.value;
                  const start = getLocalDate(formData.startDate || TODAY_STR);
                  setFormData({
                    ...formData,
                    frequency: nextFrequency,
                    recurrenceDay: nextFrequency === 'monthly' ? start.getDate() : start.getDay()
                  });
                }}
              >
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

          {formData.frequency !== 'daily' && (
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-1">{formData.frequency === 'weekly' ? '曜日' : '日付'}</label>
              {formData.frequency === 'weekly' ? (
                <select required className="w-full border-2 border-gray-200 p-3 rounded-xl focus:border-green-500 focus:outline-none bg-white" value={formData.recurrenceDay} onChange={e => setFormData({...formData, recurrenceDay: Number(e.target.value)})}>
                  {weekdayLabels.map((label, idx) => (
                    <option key={label} value={idx}>{label}</option>
                  ))}
                </select>
              ) : (
                <select required className="w-full border-2 border-gray-200 p-3 rounded-xl focus:border-green-500 focus:outline-none bg-white" value={formData.recurrenceDay} onChange={e => setFormData({...formData, recurrenceDay: Number(e.target.value)})}>
                  {Array.from({ length: 31 }, (_, idx) => idx + 1).map(day => (
                    <option key={day} value={day}>{day}日</option>
                  ))}
                </select>
              )}
              {formData.frequency === 'monthly' && (
                <p className="text-xs text-gray-500 font-medium mt-1">月末より後の日付は、その月の最終日に表示します。</p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-green-50 border border-green-100 p-4 rounded-xl">
            <div>
              <label className="block text-sm font-bold text-green-800 mb-1">開始時期 <span className="text-red-500">必須</span></label>
              <input
                required
                type="date"
                className="w-full border-2 border-green-200 p-3 rounded-xl focus:border-green-500 focus:outline-none bg-white"
                value={formData.startDate}
                onChange={e => {
                  const nextStart = e.target.value;
                  const start = getLocalDate(nextStart || TODAY_STR);
                  setFormData({
                    ...formData,
                    startDate: nextStart,
                    recurrenceDay: formData.frequency === 'monthly' ? start.getDate() : formData.frequency === 'weekly' ? start.getDay() : formData.recurrenceDay
                  });
                }}
              />
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

export default function App() {
  const [isDBReady, setIsDBReady] = useState(false);
  const [activeTab, setActiveTab] = useState('board');
  const [plannerView, setPlannerView] = useState('list');

  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [recurringSchedules, setRecurringSchedules] = useState([]);
  const [recurringCompletions, setRecurringCompletions] = useState({});

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

        setTasks(tasksWithId);
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
  const [editingTask, setEditingTask] = useState(null);
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
    const data = { tasks, projects, recurringSchedules, recurringCompletions };
    const jsonString = JSON.stringify(data, null, 2);
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
        if (data.tasks && Array.isArray(data.tasks)) setTasks(data.tasks);
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
    const boardDates = mainBoardWeeks.reduce((dates, week) => [...dates, ...week.days.map(day => day.date)], []);
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
      let current = getFirstRecurringOccurrenceDate(schedule);
      let guard = 0;

      while (current < rangeStart && guard < 10000) {
        current = getRecurringNextOccurrenceDate(current, schedule);
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
          richResult: completion.richResult,
          completionNote: completion.completionNote || '',
          resultUrls: completion.resultUrls || [],
          resultImages: completion.resultImages || [],
          order: new Date(date).getTime() + 500 + scheduleIndex
        });
        current = getRecurringNextOccurrenceDate(current, schedule);
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
    return [...items, ...recurringOccurrences].sort((a, b) => a.order - b.order);
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
    setRecurringCompletions(prev => {
      const next = {};
      Object.entries(prev).forEach(([key, value]) => {
        if (!key.startsWith(`${scheduleId}_`)) next[key] = value;
      });
      return next;
    });
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
        [completionKey]: {
          ...(prev[completionKey] || {}),
          richResult: richHtml,
          resultUrls: urls,
          completed: isCompleted
        }
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
      setTasks(prev => prev.map(t => t.id === taskData.id ? { ...t, ...processedTaskData } : t));
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
        id: `t_${Date.now()}_${Math.random().toString(36).substring(2,9)}`
      };
      setTasks(prev => [...prev, newTask]);
      showToast(`「${taskData.title}」を作成しました`);
    }
    setIsTaskModalOpen(false);
    setEditingTask(null);
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
    setEditingTask(null);
    setNewTaskDefaultDate(date);
    setIsTaskModalOpen(true);
  };

  const handleOpenTaskModalFromFab = () => {
    setEditingTask(null);
    setNewTaskDefaultDate(TODAY_STR);
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
      if (!showRecurringInList && t.isRecurringOccurrence) return false;
      if (filterCompleted === 'completed' && !t.completed) return false;
      if (filterCompleted === 'incomplete' && t.completed) return false;

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
          <div className="flex items-center gap-2">
            <input
              type="file"
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
          </div>

          <div className="flex bg-gray-100 p-1.5 rounded-xl border border-gray-200">
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

                    <label className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl border-2 border-gray-200 bg-white text-sm font-bold text-gray-700 whitespace-nowrap cursor-pointer hover:border-blue-300 transition-colors">
                      <input
                        type="checkbox"
                        checked={showRecurringInList}
                        onChange={(e) => setShowRecurringInList(e.target.checked)}
                        className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                      />
                      定期を表示
                    </label>

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
                            <span className="text-xs font-bold text-gray-600 bg-gray-50 border border-gray-200 px-2 py-0.5 rounded-full">{getRecurrenceDetailLabel(schedule)}</span>
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

      <div className="fixed bottom-8 right-8 flex flex-col items-end gap-3 z-40">
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

      <TaskModal
        isOpen={isTaskModalOpen}
        onClose={() => { setIsTaskModalOpen(false); setEditingTask(null); }}
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
