import React, { useState, useMemo, useRef } from 'react';
import { Ruler, Scale, Clock, Box, Hash, Calculator, Gauge, ArrowRightLeft, MoveRight, Zap, Power, Hammer, Thermometer, Droplets, Percent, CalendarClock, Activity, Battery, Cpu, RotateCw, Check } from 'lucide-react';

// ==========================================
// 1. 各種単位の定義と基準値への変換レート・ロジック
// ==========================================
const unitDictionary = {
  length: {
    name: '長さ', icon: <Ruler className="w-5 h-5 text-blue-500" />, base: 'm',
    conversions: { 'nm': 1e-9, 'µm': 1e-6, 'mm': 1e-3, 'cm': 1e-2, 'm': 1, 'km': 1e3, 'Mm': 1e6, 'Gm': 1e9, 'in': 0.0254, 'ft': 0.3048, 'yd': 0.9144, 'mile': 1609.344, }
  },
  area: {
    name: '面積', icon: <Box className="w-5 h-5 text-green-500" />, base: 'm^2',
    conversions: { 'mm^2': 1e-6, 'cm^2': 1e-4, 'm^2': 1, 'a': 100, 'ha': 10000, 'km^2': 1e6, }
  },
  volume: {
    name: '体積', icon: <Box className="w-5 h-5 text-teal-500" />, base: 'm^3',
    conversions: { 'mm^3': 1e-9, 'cm^3': 1e-6, 'cc': 1e-6, 'mL': 1e-6, 'L': 1e-3, 'm^3': 1, 'km^3': 1e9, }
  },
  mass: {
    name: '質量', icon: <Scale className="w-5 h-5 text-orange-500" />, base: 'kg',
    conversions: { 'µg': 1e-9, 'mg': 1e-6, 'g': 1e-3, 'kg': 1, 't': 1e3, 'Mg': 1e3, 'Gg': 1e6, }
  },
  time: {
    name: '時間', icon: <Clock className="w-5 h-5 text-purple-500" />, base: 's',
    conversions: { 'ns': 1e-9, 'µs': 1e-6, 'ms': 1e-3, 's': 1, 'min': 60, 'h': 3600, 'day': 86400, }
  },
  angle: {
    name: '角度', icon: <ArrowRightLeft className="w-5 h-5 text-yellow-500" />, base: 'rad',
    conversions: { 'rad': 1, 'deg': Math.PI / 180, }
  },
  pressure: {
    name: '圧力', icon: <Gauge className="w-5 h-5 text-red-500" />, base: 'Pa',
    conversions: { 'µPa': 1e-6, 'mPa': 1e-3, 'Pa': 1, 'hPa': 100, 'kPa': 1e3, 'MPa': 1e6, 'GPa': 1e9, 'bar': 1e5, 'atm': 101325, }
  },
  energy: {
    name: 'エネルギー・熱量', icon: <Zap className="w-5 h-5 text-yellow-500" />, base: 'J',
    conversions: { 'µJ': 1e-6, 'mJ': 1e-3, 'J': 1, 'kJ': 1e3, 'MJ': 1e6, 'GJ': 1e9, 'cal': 4.184, 'kcal': 4184, 'Wh': 3600, 'kWh': 3.6e6, 'eV': 1.602176634e-19, }
  },
  power: {
    name: '仕事率・電力', icon: <Power className="w-5 h-5 text-amber-500" />, base: 'W',
    conversions: { 'µW': 1e-6, 'mW': 1e-3, 'W': 1, 'kW': 1e3, 'MW': 1e6, 'GW': 1e9, 'PS': 735.49875, 'HP': 745.699872, }
  },
  force: {
    name: '力', icon: <Hammer className="w-5 h-5 text-stone-500" />, base: 'N',
    conversions: { 'µN': 1e-6, 'mN': 1e-3, 'N': 1, 'kN': 1e3, 'MN': 1e6, 'GN': 1e9, 'kgf': 9.80665, 'lbf': 4.4482216152605, 'dyn': 1e-5, }
  },
  torque: {
    name: 'トルク', icon: <RotateCw className="w-5 h-5 text-rose-500" />, base: 'N·m',
    conversions: { 'µN·m': 1e-6, 'mN·m': 1e-3, 'N·m': 1, 'kN·m': 1e3, 'MN·m': 1e6, 'GN·m': 1e9, 'kgf·m': 9.80665, 'kgf·cm': 0.0980665, 'lbf·ft': 1.3558179483314, }
  },
  temperature: {
    name: '温度', icon: <Thermometer className="w-5 h-5 text-red-400" />, base: 'K',
    conversions: {
      'K': { toBase: x => x, fromBase: x => x },
      '℃': { toBase: x => x + 273.15, fromBase: x => x - 273.15 },
      '℉': { toBase: x => (x + 459.67) * 5 / 9, fromBase: x => (x * 9 / 5) - 459.67 },
    }
  },
  density: {
    name: '密度', icon: <Droplets className="w-5 h-5 text-cyan-500" />, base: 'kg/m^3',
    conversions: { 'kg/m^3': 1, 'g/cm^3': 1000, 'kg/L': 1000, 'g/mL': 1000, 'g/L': 1, }
  },
  moment_of_inertia: {
    name: '慣性モーメント', icon: <RotateCw className="w-5 h-5 text-stone-600" />, base: 'kg·m^2',
    conversions: { 'g·cm^2': 1e-7, 'kg·m^2': 1, }
  },
  current: {
    name: '電流', icon: <Activity className="w-5 h-5 text-yellow-600" />, base: 'A',
    conversions: { 'µA': 1e-6, 'mA': 1e-3, 'A': 1, 'kA': 1e3, 'MA': 1e6, 'GA': 1e9, }
  },
  voltage: {
    name: '電圧', icon: <Zap className="w-5 h-5 text-yellow-400" />, base: 'V',
    conversions: { 'µV': 1e-6, 'mV': 1e-3, 'V': 1, 'kV': 1e3, 'MV': 1e6, 'GV': 1e9, }
  },
  resistance: {
    name: '電気抵抗', icon: <Cpu className="w-5 h-5 text-green-600" />, base: 'Ω',
    conversions: { 'µΩ': 1e-6, 'mΩ': 1e-3, 'Ω': 1, 'kΩ': 1e3, 'MΩ': 1e6, 'GΩ': 1e9, }
  },
  capacitance: {
    name: '静電容量', icon: <Battery className="w-5 h-5 text-blue-400" />, base: 'F',
    conversions: { 'pF': 1e-12, 'nF': 1e-9, 'µF': 1e-6, 'mF': 1e-3, 'F': 1, }
  },
  charge: {
    name: '電荷', icon: <Activity className="w-5 h-5 text-purple-400" />, base: 'C',
    conversions: { 'µC': 1e-6, 'mC': 1e-3, 'C': 1, 'kC': 1e3, 'mAh': 3.6, 'Ah': 3600, }
  },
  inductance: {
    name: 'インダクタンス', icon: <Cpu className="w-5 h-5 text-orange-400" />, base: 'H',
    conversions: { 'µH': 1e-6, 'mH': 1e-3, 'H': 1, }
  }
};

// ==========================================
// 2. 基本的なフォーマット・変換ユーティリティ
// ==========================================
const formatNumber = (num) => {
  if (num === 0) return '0';
  const abs = Math.abs(num);
  if (abs >= 1e6 || abs <= 1e-4) {
    const expStr = num.toExponential(4);
    const [base, exp] = expStr.split('e');
    return `${parseFloat(base)} * 10^${parseInt(exp)}`;
  }
  return parseFloat(num.toFixed(6)).toString();
};

const toFraction = (decimal) => {
  if (decimal === 0 || !Number.isFinite(decimal) || isNaN(decimal) || Math.abs(decimal) > 1e6) return null;
  const isNegative = decimal < 0;
  let b = Math.abs(decimal);
  const tolerance = 1.0E-6;
  let h1 = 1, h2 = 0, k1 = 0, k2 = 1;
  do {
      let a = Math.floor(b);
      let aux = h1; h1 = a * h1 + h2; h2 = aux;
      aux = k1; k1 = a * k1 + k2; k2 = aux;
      b = 1 / (b - a);
  } while (Math.abs(Math.abs(decimal) - h1 / k1) > Math.abs(decimal) * tolerance && k1 < 100000);

  if (k1 >= 100000 || k1 === 1) return null; 
  return (isNegative ? "-" : "") + h1 + "/" + k1;
};

const getFractionPi = (rad) => {
  const ratio = rad / Math.PI;
  const commonFractions = [
    { val: 1/6, str: 'π/6' }, { val: 1/4, str: 'π/4' }, { val: 1/3, str: 'π/3' },
    { val: 1/2, str: 'π/2' }, { val: 2/3, str: '2π/3' }, { val: 3/4, str: '3π/4' },
    { val: 5/6, str: '5π/6' }, { val: 1, str: 'π' }, { val: 2, str: '2π' }
  ];
  for (const f of commonFractions) {
    if (Math.abs(ratio - f.val) < 1e-5) return f.str;
    if (Math.abs(ratio + f.val) < 1e-5) return '-' + f.str;
  }
  return null;
};

const normalizeUnit = (u) => {
  const map = {
    'ワット': 'W', 'キロワット': 'kW', 'メガワット': 'MW',
    'ジュール': 'J', 'カロリー': 'cal', 'キロカロリー': 'kcal',
    'ニュートン': 'N', 'キログラム': 'kg', 'グラム': 'g', 'トン': 't',
    '秒': 's', '分': 'min', '時間': 'h',
    'メートル': 'm', 'センチ': 'cm', 'ミリ': 'mm', 'マイクロメートル': 'µm', 'リットル': 'L', 
    '度': 'deg', '馬力': 'PS', 'パスカル': 'Pa', '気圧': 'atm',
    '摂氏': '℃', '度C': '℃', '度c': '℃', '°C': '℃', '華氏': '℉', '°F': '℉', 'ケルビン': 'K',
    '立米': 'm^3', 'g/cc': 'g/cm^3',
    'アンペア': 'A', 'ミリアンペア': 'mA', 'ボルト': 'V', 'オーム': 'Ω',
    'ファラド': 'F', 'マイクロファラド': 'µF', 'クーロン': 'C', 'ヘンリー': 'H',
    'アンペア時': 'Ah', 'ミリアンペア時': 'mAh',
    // 手軽な入力（u -> µ）のサポート
    'um': 'µm', 'ug': 'µg', 'us': 'µs', 'uPa': 'µPa', 'uJ': 'µJ', 'uW': 'µW', 
    'uN': 'µN', 'uA': 'µA', 'uV': 'µV', 'uΩ': 'µΩ', 'uF': 'µF', 'uC': 'µC', 'uH': 'µH'
  };
  return map[u] || u;
};

// ==========================================
// 3. 次元付き数式の評価エンジン (計算用)
// ==========================================
const CATEGORY_DIMS = {
  length: {m: 1}, area: {m: 2}, volume: {m: 3}, mass: {kg: 1}, time: {s: 1}, angle: {rad: 1},
  pressure: {kg: 1, m: -1, s: -2}, energy: {kg: 1, m: 2, s: -2}, power: {kg: 1, m: 2, s: -3},
  force: {kg: 1, m: 1, s: -2}, torque: {kg: 1, m: 2, s: -2}, density: {kg: 1, m: -3}, moment_of_inertia: {kg: 1, m: 2},
  current: {A: 1}, voltage: {kg: 1, m: 2, s: -3, A: -1}, resistance: {kg: 1, m: 2, s: -3, A: -2},
  capacitance: {kg: -1, m: -2, s: 4, A: 2}, charge: {s: 1, A: 1}, inductance: {kg: 1, m: 2, s: -2, A: -2}
};

const matchDims = (d1, d2) => {
  const keys = new Set([...Object.keys(d1), ...Object.keys(d2)]);
  for (let k of keys) if ((d1[k] || 0) !== (d2[k] || 0)) return false;
  return true;
};

const formatDims = (dims) => {
  let num = [], den = [];
  for (let [k, v] of Object.entries(dims)) {
    if (v > 0) num.push(v === 1 ? k : `${k}^${v}`);
    else if (v < 0) den.push(v === -1 ? k : `${k}^${-v}`);
  }
  if (!num.length && !den.length) return '';
  let res = num.length ? num.join('·') : '1';
  if (den.length) res += ' / ' + den.join('·');
  return res;
};

const evaluateExpression = (exprStr) => {
  let hasDateStr = false;
  let expr = exprStr.replace(/\b\d{4}\/\d{1,2}\/\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/g, match => {
    hasDateStr = true; return `( ${new Date(match).getTime()} ms )`;
  });

  expr = expr.replace(/(sin|cos|tan|arcsin|arccos|arctan|asin|acos|atan)\s*([-+]?\d+\.?\d*(?:e[-+]?\d+)?\s*[a-zA-Z°]+(?:\^[+-]?\d+)?)/gi, '$1($2)');
  expr = expr.replace(/·/g, '*');

  const tokenRegex = /(sin|cos|tan|arcsin|arccos|arctan|asin|acos|atan|\d+\.\d+(?:e[+-]?\d+)?|\d+(?:e[+-]?\d+)?|[a-zA-Z°µΩ\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+(?:\^[+-]?\d+)?|[\+\-\*\/\(\)])/gi;
  const rawTokens = [...expr.matchAll(tokenRegex)].map(m => m[0]);

  const tokens = [];
  for (let i = 0; i < rawTokens.length; i++) {
    let t = rawTokens[i], type = '', val = null;
    if (/^[\+\-\*\/\(\)]$/.test(t)) type = 'op';
    else if (/^(sin|cos|tan|arcsin|arccos|arctan|asin|acos|atan)$/i.test(t)) type = 'func';
    else if (!isNaN(parseFloat(t)) && isFinite(t)) { type = 'num'; val = parseFloat(t); }
    else type = 'unit';

    if (tokens.length > 0) {
      const prev = tokens[tokens.length - 1];
      const needsMul = 
        (prev.type === 'num' && (type === 'unit' || type === 'func' || t === '(')) ||
        (prev.type === 'unit' && (type === 'func' || t === '(' || type === 'num' || type === 'unit')) ||
        (prev.value === ')' && (type === 'num' || type === 'unit' || type === 'func' || t === '('));
      if (needsMul) tokens.push({ type: 'op', value: '_' });
    }

    if (t === '-') {
      if (tokens.length === 0 || ['+', '-', '*', '/', '(', '_'].includes(tokens[tokens.length - 1].value)) t = 'neg';
    } else if (t === '+') {
      if (tokens.length === 0 || ['+', '-', '*', '/', '(', '_'].includes(tokens[tokens.length - 1].value)) continue;
    }

    if (type === 'op' || t === 'neg') tokens.push({ type: 'op', value: t });
    else if (type === 'func') tokens.push({ type: 'func', value: t.toLowerCase() });
    else if (type === 'num') tokens.push({ type: 'num', value: val });
    else if (type === 'unit') tokens.push({ type: 'unit', value: t });
  }

  const precedence = { '+': 1, '-': 1, '*': 2, '/': 2, '_': 3, 'neg': 4 };
  const associativity = { '+': 'L', '-': 'L', '*': 'L', '/': 'L', '_': 'L', 'neg': 'R' };
  const output = [], stack = [];

  for (let token of tokens) {
    if (token.type === 'num' || token.type === 'unit') output.push(token);
    else if (token.type === 'func') stack.push(token);
    else if (token.type === 'op') {
      if (token.value === '(') stack.push(token);
      else if (token.value === ')') {
        while (stack.length > 0 && stack[stack.length - 1].value !== '(') output.push(stack.pop());
        stack.pop();
        if (stack.length > 0 && stack[stack.length - 1].type === 'func') output.push(stack.pop());
      } else {
        while (stack.length > 0 && stack[stack.length - 1].type === 'op' && stack[stack.length - 1].value !== '(') {
          const o1 = token.value, o2 = stack[stack.length - 1].value;
          if ((associativity[o1] === 'L' && precedence[o1] <= precedence[o2]) || (associativity[o1] === 'R' && precedence[o1] < precedence[o2])) output.push(stack.pop());
          else break;
        }
        stack.push(token);
      }
    }
  }
  while (stack.length > 0) output.push(stack.pop());

  const evalStack = [];
  const popQty = () => { if (!evalStack.length) throw new Error("数式エラー"); return evalStack.pop(); };

  const UNIT_DEFS = { 'pi': { v: Math.PI, d: {} } };
  Object.values(unitDictionary).forEach(cat => {
    Object.entries(cat.conversions).forEach(([u, conv]) => {
      if (typeof conv !== 'object') UNIT_DEFS[u] = { v: conv, d: CATEGORY_DIMS[Object.keys(unitDictionary).find(k => unitDictionary[k] === cat)] };
    });
  });

  for (let token of output) {
    if (token.type === 'num') evalStack.push({ v: token.value, d: {} });
    else if (token.type === 'unit') {
      const norm = normalizeUnit(token.value);
      if (UNIT_DEFS[norm] !== undefined) {
        evalStack.push({ v: UNIT_DEFS[norm].v, d: { ...UNIT_DEFS[norm].d } });
      } else {
        let found = null;
        if (!['a', 'A', 'mΩ', 'MΩ'].includes(norm)) {
          for (let key in UNIT_DEFS) {
            if (key.toLowerCase() === norm.toLowerCase()) { found = key; break; }
          }
        }
        if (found) {
          evalStack.push({ v: UNIT_DEFS[found].v, d: { ...UNIT_DEFS[found].d } });
        } else {
          evalStack.push({ v: 1, d: { [norm]: 1 } });
        }
      }
    } else if (token.type === 'op') {
      if (token.value === 'neg') {
        const a = popQty(); evalStack.push({ v: -a.v, d: { ...a.d } });
      } else {
        const b = popQty(), a = popQty();
        if (token.value === '+') {
          if (!matchDims(a.d, b.d)) throw new Error("次元不一致");
          evalStack.push({ v: a.v + b.v, d: { ...a.d } });
        } else if (token.value === '-') {
          if (!matchDims(a.d, b.d)) throw new Error("次元不一致");
          evalStack.push({ v: a.v - b.v, d: { ...a.d } });
        } else if (token.value === '*' || token.value === '_') {
          const newD = { ...a.d };
          for (let [k, v] of Object.entries(b.d)) { newD[k] = (newD[k] || 0) + v; if (newD[k] === 0) delete newD[k]; }
          evalStack.push({ v: a.v * b.v, d: newD });
        } else if (token.value === '/') {
          const newD = { ...a.d };
          for (let [k, v] of Object.entries(b.d)) { newD[k] = (newD[k] || 0) - v; if (newD[k] === 0) delete newD[k]; }
          evalStack.push({ v: a.v / b.v, d: newD });
        }
      }
    } else if (token.type === 'func') {
      const a = popQty(), fn = token.value;
      if (['sin', 'cos', 'tan'].includes(fn)) evalStack.push({ v: Math[fn](a.v), d: {} });
      else {
        if (Object.keys(a.d).length > 0) throw new Error("逆三角関数は無次元である必要があります");
        evalStack.push({ v: Math[fn.replace('arc', 'a')](a.v), d: { rad: 1 } });
      }
    }
  }

  if (evalStack.length !== 1) throw new Error("評価失敗");
  return { value: evalStack[0].v, dims: evalStack[0].d, hasDateStr };
};

// ==========================================
// 4. 入力解析ロジック
// ==========================================
const parseInput = (text) => {
  text = text.trim();
  if (!text) return [];
  let results = [];

  // 1. 進数
  const baseMatch = text.match(/^([hdob])([0-9a-f]+)$/i);
  if (baseMatch) {
    const prefix = baseMatch[1].toLowerCase();
    const valStr = baseMatch[2];
    const isValid = 
      (prefix === 'b' && /^[01]+$/.test(valStr)) || (prefix === 'o' && /^[0-7]+$/.test(valStr)) ||
      (prefix === 'd' && /^[0-9]+$/.test(valStr)) || (prefix === 'h');
    if (isValid) {
      const base = prefix === 'h' ? 16 : prefix === 'o' ? 8 : prefix === 'b' ? 2 : 10;
      const decimalVal = parseInt(valStr, base);
      if (!isNaN(decimalVal)) {
        results.push({
          title: '進数変換', icon: <Hash className="w-5 h-5 text-slate-600" />,
          items: [ `d${decimalVal.toString(10)}`, `h${decimalVal.toString(16)}`, `o${decimalVal.toString(8)}`, `b${decimalVal.toString(2)}` ].filter(item => !item.toLowerCase().startsWith(prefix + valStr.toLowerCase()))
        });
        return results;
      }
    }
  }

  // 2. 三角関数・逆三角関数
  const trigMatch = text.match(/^(sin|cos|tan|arcsin|arccos|arctan|asin|acos|atan)\s*\(?\s*(-?[\d.]+)\s*(deg|°|rad)?\s*\)?$/i);
  if (trigMatch) {
    const func = trigMatch[1].toLowerCase();
    const val = parseFloat(trigMatch[2]);
    const unit = (trigMatch[3] || '').toLowerCase();
    if (['sin', 'cos', 'tan'].includes(func)) {
      let rad = val;
      if (unit === 'deg' || unit === '°') rad = val * Math.PI / 180;
      results.push({ title: '三角関数の計算結果', icon: <Calculator className="w-5 h-5 text-indigo-500" />, items: [`${Math.round(Math[func](rad) * 1e10) / 1e10}`] });
    } else {
      let resultsList = [];
      if (['asin', 'arcsin', 'acos', 'arccos'].includes(func)) {
        if (val >= -1 && val <= 1) {
           const rad = (func === 'asin' || func === 'arcsin') ? Math.asin(val) : Math.acos(val);
           resultsList.push(`${formatNumber(rad * 180 / Math.PI)} deg`, `${formatNumber(rad)} rad`);
        } else {
           resultsList.push(`定義域エラー (入力は -1 〜 1 の範囲のみ)`);
        }
      } else {
         const rad = Math.atan(val);
         resultsList.push(`${formatNumber(rad * 180 / Math.PI)} deg`, `${formatNumber(rad)} rad`);
      }
      results.push({ title: '逆三角関数の角度', icon: <Calculator className="w-5 h-5 text-indigo-500" />, items: resultsList });
    }
    return results;
  }

  // 3. 単位なしの単一数値（0.5 など）
  const plainNumberMatch = text.match(/^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/);
  if (plainNumberMatch) {
    const val = parseFloat(text);
    const fraction = toFraction(val);
    const numItems = [`${formatNumber(val * 100)} %`];
    if (fraction) numItems.unshift(fraction);
    results.push({ title: '分数・割合として', icon: <Percent className="w-5 h-5 text-pink-500" />, items: numItems });
    results.push({ title: '角度として', icon: <ArrowRightLeft className="w-5 h-5 text-yellow-500" />, items: [`${val} deg = ${formatNumber(val * Math.PI / 180)} rad`, `${val} rad = ${formatNumber(val * 180 / Math.PI)} deg`] });
    results.push({ title: '三角関数の値 (radとして)', icon: <Calculator className="w-5 h-5 text-indigo-500" />, items: [`sin = ${formatNumber(Math.sin(val))}`, `cos = ${formatNumber(Math.cos(val))}`, `tan = ${formatNumber(Math.tan(val))}`] });
    const invItems = [];
    if (val >= -1 && val <= 1) {
      const asinR = Math.asin(val);
      const acosR = Math.acos(val);
      invItems.push(`arcsin = ${formatNumber(asinR * 180 / Math.PI)} deg (${formatNumber(asinR)} rad)`);
      invItems.push(`arccos = ${formatNumber(acosR * 180 / Math.PI)} deg (${formatNumber(acosR)} rad)`);
    }
    const atanR = Math.atan(val);
    invItems.push(`arctan = ${formatNumber(atanR * 180 / Math.PI)} deg (${formatNumber(atanR)} rad)`);
    results.push({ title: '逆三角関数の角度', icon: <Calculator className="w-5 h-5 text-indigo-500" />, items: invItems });
    return results;
  }

  // 4. 単位付き数値
  const unitMatch = text.match(/^([-+]?[\d]*\.?[\d]+(?:[eE][-+]?[\d]+)?)\s*(.+)$/i);
  if (unitMatch) {
    const val = parseFloat(unitMatch[1]);
    let rawUnit = unitMatch[2].trim();
    if (rawUnit === '°') rawUnit = 'deg';
    
    const unit = normalizeUnit(rawUnit);
    let foundCategory = null;
    let foundUnitKey = null;

    for (const [catName, catData] of Object.entries(unitDictionary)) {
      if (catData.conversions[unit] !== undefined) {
        foundCategory = catName;
        foundUnitKey = unit;
        break;
      }
    }

    if (!foundCategory) {
      for (const [catName, catData] of Object.entries(unitDictionary)) {
        for (const u of Object.keys(catData.conversions)) {
          if (u.toLowerCase() === unit.toLowerCase()) {
            if (['a', 'A', 'mΩ', 'MΩ'].includes(unit)) continue; 
            foundCategory = catName;
            foundUnitKey = u;
            break;
          }
        }
        if (foundCategory) break;
      }
    }

    if (foundCategory) {
      const catData = unitDictionary[foundCategory];
      const isCustomConversion = typeof catData.conversions[foundUnitKey] === 'object';
      const baseVal = isCustomConversion ? catData.conversions[foundUnitKey].toBase(val) : val * catData.conversions[foundUnitKey];

      const convertedItems = [];
      for (const [u, conversion] of Object.entries(catData.conversions)) {
        if (u === foundUnitKey) continue; 
        const converted = typeof conversion === 'object' ? conversion.fromBase(baseVal) : baseVal / conversion;
        convertedItems.push(`${formatNumber(converted)} ${u}`);
      }

      const G = 9.80665;
      if (foundCategory === 'mass') {
        convertedItems.push(`${formatNumber(baseVal * G)} N (地球重力下)`);
        convertedItems.push(`${formatNumber(baseVal)} kgf`);
      } else if (foundCategory === 'force') {
        convertedItems.push(`${formatNumber(baseVal / G)} kg (地球重力下)`);
      }

      results.push({ title: catData.name, icon: catData.icon, items: convertedItems });
      return results;
    }
  }

  // 【B】計算エンジン
  try {
    const { value, dims, hasDateStr } = evaluateExpression(text);
    
    if (hasDateStr && matchDims(dims, CATEGORY_DIMS.time)) {
      const d = new Date(value * 1000);
      results.push({ title: '日時計算の結果', icon: <CalendarClock className="w-5 h-5 text-indigo-500" />, items: [d.toLocaleString(), `${formatNumber(value / 3600)} h`] });
      return results;
    }

    let matchedCategory = null;
    for (let [cat, cdims] of Object.entries(CATEGORY_DIMS)) {
      if (matchDims(dims, cdims)) { matchedCategory = cat; break; }
    }

    if (matchedCategory) {
      const catData = unitDictionary[matchedCategory];
      const items = Object.entries(catData.conversions).map(([u, conv]) => {
         if (typeof conv !== 'object') return `${formatNumber(value / conv)} ${u}`;
         return null;
      }).filter(Boolean);
      results.push({ title: `計算結果 (${catData.name})`, icon: <Calculator className="w-5 h-5 text-blue-500" />, items });
    } else {
      const dimStr = formatDims(dims);
      if (dimStr !== '') {
        results.push({ title: '計算結果 (組み立て単位)', icon: <Calculator className="w-5 h-5 text-slate-500" />, items: [`${formatNumber(value)} ${dimStr}`] });
      } else {
        results.push({ title: '計算結果', icon: <Calculator className="w-5 h-5 text-slate-500" />, items: [`${formatNumber(value)}`] });
      }
    }
  } catch (err) {}

  return results;
};

// ==========================================
// 5. UIコンポーネント
// ==========================================
export default function App() {
  const [input, setInput] = useState('');
  const [copiedIndex, setCopiedIndex] = useState(null);
  const results = useMemo(() => parseInput(input), [input]);

  // オートコンプリート（予測変換）の生成
  const suggestion = useMemo(() => {
    if (!input) return null;
    
    // 入力の末尾がアルファベット等かどうか
    const match = input.match(/([a-zA-Z°µΩ·]+)$/);
    if (match) {
      const unitPart = match[1];
      const prefix = input.slice(0, input.length - unitPart.length);
      
      const allUnits = Object.values(unitDictionary).flatMap(cat => Object.keys(cat.conversions));
      const extraUnits = ['°C', '°F', 'deg']; 
      const searchPool = Array.from(new Set([...allUnits, ...extraUnits]));

      // 前方一致でマッチする単位を探す
      const matches = searchPool.filter(u => u.toLowerCase().startsWith(unitPart.toLowerCase()) && u.length > unitPart.length);
      if (matches.length > 0) {
        // 大文字小文字の完全一致を優先
        const exactMatches = matches.filter(u => u.startsWith(unitPart));
        const bestMatch = exactMatches.length > 0 ? exactMatches[0] : matches[0];
        
        return prefix + bestMatch;
      }
    }
    return null;
  }, [input]);

  const handleCopy = (text, indexKey) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      setCopiedIndex(indexKey);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (err) {}
    document.body.removeChild(textArea);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 p-4 md:p-8 font-sans selection:bg-blue-100">
      <div className="max-w-3xl mx-auto space-y-8">
        
        <header className="text-center pt-8 pb-4">
          <h1 className="text-3xl font-bold text-slate-800 mb-3 tracking-tight">よしなに単位変換</h1>
          <p className="text-slate-500 text-sm md:text-base">
            SI接頭辞、トルク、温度入力(°C)に対応。Tabキーで単位を予測補完できます。
          </p>
        </header>

        <div className="relative bg-white border border-slate-200 shadow-sm rounded-2xl focus-within:ring-4 focus-within:ring-blue-500/10 focus-within:border-blue-500 transition-all flex items-center">
          <div className="relative w-full overflow-hidden">
            {/* ゴーストテキスト（サジェスト表示） */}
            {suggestion && suggestion.startsWith(input) && (
              <div className="absolute inset-0 p-5 pl-6 pr-12 text-2xl font-mono text-slate-300 pointer-events-none flex items-center bg-transparent z-0">
                <span className="opacity-0 whitespace-pre">{input}</span>
                <span className="whitespace-pre">{suggestion.slice(input.length)}</span>
              </div>
            )}
            <input
              type="text"
              className="w-full text-2xl p-5 pl-6 pr-12 bg-transparent outline-none font-mono text-slate-800 relative z-10"
              placeholder="例: 10A, 27°C, 10kgf·m, 10uF..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Tabキーでサジェストを補完
                if (e.key === 'Tab' && suggestion) {
                  e.preventDefault();
                  setInput(suggestion);
                }
              }}
              autoFocus
            />
          </div>
          {input && (
            <button 
              onClick={() => setInput('')}
              className="absolute right-5 z-20 text-slate-300 hover:text-slate-500 p-1"
            >
              ✕
            </button>
          )}
        </div>

        <div className="space-y-4">
          {results.length > 0 ? (
            results.map((res, i) => (
              <div key={i} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 md:p-6 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="flex items-center gap-2 text-slate-600 font-semibold mb-4 pb-3 border-b border-slate-50">
                   {res.icon}
                   <span>{res.title}</span>
                </div>
                <div className="flex flex-wrap gap-2.5">
                   {res.items.map((item, j) => {
                      const isCopied = copiedIndex === `${i}-${j}`;
                      return (
                        <button
                          key={j}
                          onClick={() => handleCopy(item, `${i}-${j}`)}
                          title="クリックしてコピー"
                          className={`flex items-center gap-2 border px-4 py-2.5 rounded-xl font-mono text-[15px] transition-all active:scale-95 cursor-pointer ${
                            isCopied 
                              ? 'bg-green-50 border-green-200 text-green-700' 
                              : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-white hover:border-slate-300 hover:shadow-sm'
                          }`}
                        >
                           <span className={isCopied ? "text-green-500" : "text-blue-500 opacity-50"}>
                             {isCopied ? <Check size={16} /> : <MoveRight size={16} />}
                           </span>
                           {item}
                        </button>
                      );
                   })}
                </div>
              </div>
            ))
          ) : (
            input.trim() !== '' && (
              <div className="text-center py-12 text-slate-400">
                <p>該当する解釈や計算が見つかりませんでした。</p>
                <div className="mt-4 text-sm bg-slate-100/50 inline-block p-4 rounded-xl text-left">
                  <p className="font-semibold text-slate-500 mb-2">💡 入力と補完のヒント</p>
                  <ul className="space-y-1">
                    <li>・予測変換: 入力中に薄い文字が出たら <code>Tab</code> キーで決定できます。</li>
                    <li>・SI接頭辞: <code>10µm</code> (<code>10um</code>でも可), <code>10GW</code>, <code>10pF</code> などに対応。</li>
                    <li>・トルク: <code>10N·m</code>, <code>5kgf·m</code> など。</li>
                    <li>・温度/角度: <code>27°C</code>, <code>100°F</code>, <code>45deg</code> などの入力に対応しました。</li>
                  </ul>
                </div>
              </div>
            )
          )}
        </div>

      </div>
    </div>
  );
}
