/**
 * 人物状态栏（ZNS）——酒馆助手 / SillyTavern 伴侣脚本。
 *
 * 作为 ES 模块加载（iframe 内）：
 *   import 'https://testingcf.jsdelivr.net/gh/<user>/<repo>@<tag>/dist/index.js'
 *
 * 界面注入宿主页面，类名 / id / CSS 变量一律 zns- 前缀，
 * 避免和 zhino-script 的 .zhino-root、--zn-* 冲突。
 * 玻璃色优先读宿主的 --zn-*（zhino 若把变量挂到可继承处），否则用夜空 / 白昼樱花回退色。
 * 强调色来自当前世界观预设，不占用 zhino 的紫色。
 *
 * 宿主页控制台：window.ZNS = { presets, registerPreset, refresh, setWorldview }
 */

// ---------------------------------------------------------------------------
// 纯函数：解析、预设、世界观打分。不碰 DOM，方便 node 自测。
// ---------------------------------------------------------------------------

/** HTML 转义。凡是可能拼进标记字符串的外部文本都走这里；DOM 路径再用 textContent。 */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 第二段像 MVU 给叶子附的说明，而不是另一个标签。 */
function looksLikeDesc(text) {
  if (typeof text !== 'string') return false;
  if (text.length >= 8) return true;
  if (/[。！？，、；：.!?]/.test(text)) return true;
  if (/(描述|说明|备注|当前|上限|初始|刚刚|因为|状态)/.test(text)) return true;
  return false;
}

/**
 * MVU 常见叶子：[值, "说明"]。
 * [80, 100] 两个都是数字，不当成说明，留给条形图当「当前/上限」。
 * ["中毒", "轻伤"] 两个短词，保留为标签，不剥掉第二个。
 */
function isMvuTuple(value) {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[1] !== 'string') return false;
  const head = value[0];
  if (head == null || typeof head === 'number' || typeof head === 'boolean') return true;
  if (typeof head === 'object') return true;
  if (typeof head === 'string' && looksLikeDesc(value[1])) return true;
  return false;
}

function peelMvu(value) {
  let current = value;
  for (let i = 0; i < 4 && isMvuTuple(current); i += 1) current = current[0];
  return current;
}

function asNumber(value) {
  const peeled = peelMvu(value);
  if (typeof peeled === 'number' && Number.isFinite(peeled)) return peeled;
  if (typeof peeled === 'string') {
    const text = peeled.trim().replace(/[,，\s]/g, '');
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  }
  return null;
}

function isEmptyValue(raw) {
  if (raw == null) return true;
  const value = peelMvu(raw);
  if (value == null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (isPlainObject(value) && Object.keys(value).length === 0) return true;
  return false;
}

function stringifyValue(value) {
  const peeled = peelMvu(value);
  if (peeled == null) return '';
  if (typeof peeled === 'string' || typeof peeled === 'number' || typeof peeled === 'boolean') {
    return String(peeled);
  }
  if (Array.isArray(peeled)) {
    return peeled.map((item) => stringifyValue(item)).filter(Boolean).join(' / ');
  }
  if (isPlainObject(peeled)) {
    return Object.entries(peeled)
      .map(([key, item]) => `${key}: ${stringifyValue(item)}`)
      .join('，');
  }
  return String(peeled);
}

function formatQty(num) {
  if (!Number.isFinite(num)) return '—';
  const rounded = Math.round(num * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-6) {
    return Math.round(rounded).toLocaleString('zh-CN');
  }
  return rounded.toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

const BAR_CURRENT_KEYS = ['当前', 'current', 'value', 'val', 'cur', 'now'];
const BAR_MAX_KEYS = ['上限', 'max', 'maximum', 'limit', 'maxHp', 'maxMP'];
const BAR_META_KEYS = new Set([...BAR_CURRENT_KEYS, ...BAR_MAX_KEYS, '描述', 'desc', 'min', '说明']);

function isBarMetaObject(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length) return false;
  return keys.every((key) => BAR_META_KEYS.has(key) || BAR_META_KEYS.has(key.toLowerCase()));
}

function readKeyedNumber(obj, keys) {
  if (!isPlainObject(obj)) return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const num = asNumber(obj[key]);
      if (num != null) return num;
    }
  }
  const lower = {};
  for (const [key, item] of Object.entries(obj)) lower[key.toLowerCase()] = item;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(lower, key.toLowerCase())) {
      const num = asNumber(lower[key.toLowerCase()]);
      if (num != null) return num;
    }
  }
  return null;
}

/**
 * 条形图数值。
 * 接受 number、"80/100"、"80%"、[80,100]、{当前,上限}，以及 MVU 的 [值, "说明"]。
 * 上限优先级：数值自带的分母 > 同角色的 maxKey > 字段 max。
 * 解析不出数字时退回文本，避免把「三百岁」画成空条。
 */
function parseBarValue(raw, field, data) {
  if (isEmptyValue(raw)) return { mode: 'empty' };
  const peeled = peelMvu(raw);
  let current = null;
  let max = null;

  if (typeof peeled === 'number') {
    current = peeled;
  } else if (typeof peeled === 'string') {
    const text = peeled.trim();
    const pair = text.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
    if (pair) {
      current = Number(pair[1]);
      max = Number(pair[2]);
    } else {
      const percent = text.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
      if (percent) {
        current = Number(percent[1]);
        max = 100;
      } else {
        const num = asNumber(text);
        if (num == null) return { mode: 'text', text };
        current = num;
      }
    }
  } else if (Array.isArray(peeled)) {
    if (peeled.length >= 2 && asNumber(peeled[0]) != null && asNumber(peeled[1]) != null) {
      current = asNumber(peeled[0]);
      max = asNumber(peeled[1]);
    } else if (peeled.length >= 1 && asNumber(peeled[0]) != null) {
      current = asNumber(peeled[0]);
    } else {
      return { mode: 'text', text: stringifyValue(peeled) };
    }
  } else if (isPlainObject(peeled)) {
    current = readKeyedNumber(peeled, BAR_CURRENT_KEYS);
    max = readKeyedNumber(peeled, BAR_MAX_KEYS);
    if (current == null) {
      const nums = Object.values(peeled).map(asNumber).filter((num) => num != null);
      if (nums.length) current = nums[0];
      if (nums.length > 1 && max == null) max = nums[1];
    }
    if (current == null) return { mode: 'text', text: stringifyValue(peeled) };
  } else {
    return { mode: 'text', text: stringifyValue(peeled) };
  }

  if (max == null && field && field.maxKey && data) {
    max = asNumber(data[field.maxKey]);
  }
  if (max == null && field && typeof field.max === 'number') max = field.max;
  return { mode: 'bar', current, max };
}

function parseTextValue(raw) {
  if (isEmptyValue(raw)) return '';
  const peeled = peelMvu(raw);
  if (typeof peeled === 'string' || typeof peeled === 'number' || typeof peeled === 'boolean') {
    return String(peeled);
  }
  if (Array.isArray(peeled)) {
    return peeled.map((item) => stringifyValue(item)).filter(Boolean).join(' / ');
  }
  if (isPlainObject(peeled)) {
    const current = readKeyedNumber(peeled, BAR_CURRENT_KEYS);
    if (current != null && Object.keys(peeled).length <= 3) return formatQty(current);
    return stringifyValue(peeled);
  }
  return stringifyValue(peeled);
}

function parseNumValue(raw) {
  if (isEmptyValue(raw)) return { empty: true, text: '' };
  const direct = asNumber(raw);
  if (direct != null) return { empty: false, text: formatQty(direct), num: direct };
  const peeled = peelMvu(raw);
  if (isPlainObject(peeled)) {
    const current = readKeyedNumber(peeled, BAR_CURRENT_KEYS);
    if (current != null) return { empty: false, text: formatQty(current), num: current };
  }
  const text = parseTextValue(raw);
  return { empty: text === '', text };
}

function parseChips(raw, asList) {
  if (isEmptyValue(raw)) return [];
  const peeled = peelMvu(raw);
  if (typeof peeled === 'string') {
    if (!asList && /[,，、|;；]/.test(peeled)) {
      return peeled.split(/[,，、|;；]/).map((item) => item.trim()).filter(Boolean);
    }
    return [peeled.trim()];
  }
  if (typeof peeled === 'number' || typeof peeled === 'boolean') return [String(peeled)];
  if (Array.isArray(peeled)) {
    const chips = [];
    for (const item of peeled) {
      const value = peelMvu(item);
      if (value == null || value === '') continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        chips.push(String(value));
      } else if (Array.isArray(value)) {
        chips.push(...value.map((part) => stringifyValue(part)).filter(Boolean));
      } else if (isPlainObject(value)) {
        const name = value.名称 || value.name || value.标题;
        if (name) {
          const extra = value.描述 || value.desc || value.效果 || value.层数 || '';
          chips.push(extra ? `${stringifyValue(name)} · ${stringifyValue(extra)}` : stringifyValue(name));
        } else {
          chips.push(stringifyValue(value));
        }
      }
    }
    return chips;
  }
  if (isPlainObject(peeled)) {
    return Object.entries(peeled).map(([key, item]) => {
      const value = peelMvu(item);
      if (value == null || value === '' || (isPlainObject(value) && !Object.keys(value).length)) return key;
      return `${key} · ${stringifyValue(value)}`;
    });
  }
  return [stringifyValue(peeled)];
}

const LOW_DANGER_RE = /生命|血量|气血|健康|体力|理智|神智|人性|耐久|^HP$|^hp$/i;

/**
 * 条的警戒色。
 * invert: true 表示越高越糟（饥饿、感染度、赛博精神病、通缉等级）：≥ 75% 变红。
 * 否则生命 / HP 一类在 < 25% 变红。danger: 'low' | 'high' 仍认，high 等同 invert。
 */
function barDanger(field, current, max) {
  if (max == null || !(max > 0) || current == null) return false;
  const ratio = current / max;
  const inverted = field && (field.invert === true || field.danger === 'high');
  if (inverted) return ratio >= 0.75;
  if (field && field.danger === 'low') return ratio < 0.25;
  const label = `${field?.key || ''}${field?.label || ''}`;
  if (LOW_DANGER_RE.test(label)) return ratio < 0.25;
  return false;
}

// --- 简易 YAML（缩进映射、- 列表、key: value、[a, b] 行内列表） ---

function stripYamlComment(text) {
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trim();
  }
  return text.trim();
}

function unquote(text) {
  const value = String(text ?? '').trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function splitCommaList(inner) {
  const parts = [];
  let buf = '';
  let quote = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ',' || ch === '，') {
      parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function parseScalar(raw) {
  const text = String(raw ?? '').trim();
  if (text === '' || text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (text === 'true' || text === 'True') return true;
  if (text === 'false' || text === 'False') return false;
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitCommaList(inner).map(parseScalar);
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      return JSON.parse(text);
    } catch {
      /* 不是 JSON 对象就当普通字符串 */
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function parseYamlish(src) {
  const lines = [];
  String(src ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).forEach((rawLine) => {
    const expanded = rawLine.replace(/\t/g, '  ');
    if (!expanded.trim()) return;
    const indent = expanded.match(/^ */)[0].length;
    const text = stripYamlComment(expanded.slice(indent));
    if (!text) return;
    lines.push({ indent, text });
  });
  if (!lines.length) return {};

  let index = 0;
  const peek = () => lines[index];

  function parseValue(indent, rest) {
    if (rest !== '' && rest !== '|' && rest !== '>') return parseScalar(rest);
    const next = peek();
    if (!next || next.indent <= indent) return null;
    return parseNode(next.indent);
  }

  function parseNode(indent) {
    const line = peek();
    if (!line || line.indent < indent) return {};
    if (line.indent === indent && line.text.startsWith('- ')) return parseList(indent);
    return parseMap(indent);
  }

  function parseMap(indent) {
    const obj = {};
    while (peek() && peek().indent === indent && !peek().text.startsWith('- ')) {
      const line = lines[index];
      index += 1;
      const matched = line.text.match(/^([^:：]+?)\s*[:：]\s*(.*)$/);
      if (!matched) continue;
      const key = unquote(matched[1].trim());
      obj[key] = parseValue(indent, matched[2].trim());
    }
    return obj;
  }

  function parseList(indent) {
    const list = [];
    while (peek() && peek().indent === indent && peek().text.startsWith('- ')) {
      const line = lines[index];
      index += 1;
      const item = line.text.slice(2).trim();
      if (item === '') {
        const next = peek();
        list.push(next && next.indent > indent ? parseNode(next.indent) : null);
        continue;
      }
      const matched = item.match(/^([^:：]+?)\s*[:：]\s*(.*)$/);
      if (matched && !/^\d+$/.test(matched[1].trim())) {
        const obj = {};
        const key = unquote(matched[1].trim());
        const rest = matched[2].trim();
        if (rest === '' && peek() && peek().indent > indent) obj[key] = parseNode(peek().indent);
        else obj[key] = parseScalar(rest);
        if (peek() && peek().indent > indent && !peek().text.startsWith('- ')) {
          Object.assign(obj, parseMap(peek().indent));
        }
        list.push(obj);
      } else {
        list.push(parseScalar(item));
      }
    }
    return list;
  }

  return parseNode(lines[0].indent);
}

function extractStatusBlock(text) {
  if (!text) return null;
  const matched = String(text).match(/<status\b[^>]*>([\s\S]*?)<\/status>/i);
  if (!matched) return null;
  let body = matched[1].trim();
  const fenced = body.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)```$/);
  if (fenced) body = fenced[1].trim();
  return body;
}

function parseStatusBlock(body) {
  const text = String(body ?? '').trim();
  if (!text) return null;
  if (text[0] === '{' || text[0] === '[') {
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object') return data;
    } catch {
      /* 继续走 YAML */
    }
  }
  return parseYamlish(text);
}

// --- 预设 ---

const META_KEYS = new Set(['stat_data', 'display_data', 'schema', '_meta', 'zns_worldview', '$schema']);

const GROUP_KEYS = new Set([
  '属性', '状态', '基础', '信息', '资源', '背包', '物品', '装备', '技能', '其他',
  '世界', '系统', '面板', '角色面板', '属性面板', '随身', '生存', '物资', '生活', '人际', '能力', '机体', '街头', '修为',
  'meta', 'info', 'stats', 'status', 'base', 'basic', 'inventory',
]);

/** @type {Array<{id:string,name:string,theme:object,keywords:string[],groups:object[]}>} */
const presets = [
  {
    id: 'xiuxian',
    name: '修仙',
    theme: {
      accent: '#5eead4',
      accent2: '#fbbf24',
      accentInk: '#0f766e',
      accent2Ink: '#b45309',
      icon: '☯',
      bgGradient: 'linear-gradient(160deg, rgba(94,234,212,0.28), rgba(251,191,36,0.08) 42%, transparent 70%)',
    },
    keywords: ['修仙', '修真', '仙侠', '灵根', '金丹', '元婴', '化神', '炼气', '筑基', '渡劫', '飞升', '灵石', '功法', '法宝', '宗门', '灵气', '道侣'],
    groups: [
      {
        label: '修为',
        fields: [
          { key: '境界', label: '境界', type: 'text' },
          { key: '灵根', label: '灵根', type: 'text' },
          { key: '修为', label: '修为', type: 'bar', max: 100, maxKey: '修为上限' },
          { key: '灵力', label: '灵力', type: 'bar', max: 100, maxKey: '灵力上限' },
          { key: '寿元', label: '寿元', type: 'bar', maxKey: '寿元上限' },
          { key: '心境', label: '心境', type: 'text' },
        ],
      },
      {
        label: '随身',
        fields: [
          { key: '功法', label: '功法', type: 'list' },
          { key: '法宝', label: '法宝', type: 'list' },
          { key: '灵石', label: '灵石', type: 'num' },
          { key: '状态', label: '状态', type: 'tags' },
        ],
      },
    ],
  },
  {
    id: 'dushi',
    name: '都市',
    theme: {
      accent: '#fb7185',
      accent2: '#fdba74',
      accentInk: '#be123c',
      accent2Ink: '#c2410c',
      icon: '城',
      bgGradient: 'linear-gradient(160deg, rgba(251,113,133,0.30), rgba(253,186,116,0.10) 46%, transparent 72%)',
    },
    keywords: ['都市', '职场', '总裁', '校园', '豪门', '房租', '地铁', '加班', '都市异能', '现代都市', '公司职员'],
    groups: [
      {
        label: '生活',
        fields: [
          { key: '职业', label: '职业', type: 'text' },
          { key: '金钱', label: '金钱', type: 'num' },
          { key: '体力', label: '体力', type: 'bar', max: 100, danger: 'low' },
          { key: '精力', label: '精力', type: 'bar', max: 100, danger: 'low' },
          { key: '心情', label: '心情', type: 'text' },
          { key: '好感度', label: '好感度', type: 'bar', max: 100 },
        ],
      },
      {
        label: '人际',
        fields: [
          { key: '人际关系', label: '人际关系', type: 'list' },
          { key: '身份', label: '身份', type: 'text' },
          { key: '位置', label: '位置', type: 'text' },
          { key: '状态', label: '状态', type: 'tags' },
        ],
      },
    ],
  },
  {
    id: 'moshi',
    name: '末日',
    theme: {
      accent: '#bef264',
      accent2: '#fb923c',
      accentInk: '#3f6212',
      accent2Ink: '#c2410c',
      icon: '☢',
      bgGradient: 'linear-gradient(160deg, rgba(190,242,100,0.22), rgba(251,146,60,0.12) 48%, transparent 74%)',
    },
    keywords: ['末日', '末世', '丧尸', '废土', '感染者', '避难所', '辐射', '幸存者', '据点', '尸潮'],
    groups: [
      {
        label: '生存',
        fields: [
          { key: '生命', label: '生命', type: 'bar', max: 100, danger: 'low' },
          { key: '饥饿', label: '饥饿', type: 'bar', max: 100, invert: true },
          { key: '口渴', label: '口渴', type: 'bar', max: 100, invert: true },
          { key: '感染度', label: '感染度', type: 'bar', max: 100, invert: true },
          { key: '理智', label: '理智', type: 'bar', max: 100, danger: 'low' },
        ],
      },
      {
        label: '物资',
        fields: [
          { key: '弹药', label: '弹药', type: 'num' },
          { key: '物资', label: '物资', type: 'list' },
          { key: '据点', label: '据点', type: 'text' },
          { key: '武器', label: '武器', type: 'text' },
          { key: '状态', label: '状态', type: 'tags' },
        ],
      },
    ],
  },
  {
    id: 'xihuan',
    name: '西幻',
    theme: {
      accent: '#93c5fd',
      accent2: '#fcd34d',
      accentInk: '#1d4ed8',
      accent2Ink: '#a16207',
      icon: '✦',
      bgGradient: 'linear-gradient(160deg, rgba(147,197,253,0.32), rgba(252,211,77,0.12) 46%, transparent 72%)',
    },
    keywords: ['西幻', '魔法师', '骑士团', '精灵', '地下城', '魔王', '公会', '龙与地下城', '法师', '魔力', '冒险者'],
    groups: [
      {
        label: '角色',
        fields: [
          { key: '种族', label: '种族', type: 'text' },
          { key: '职业', label: '职业', type: 'text' },
          { key: '等级', label: '等级', type: 'num' },
          { key: 'HP', label: 'HP', type: 'bar', max: 100, maxKey: 'HP上限', danger: 'low' },
          { key: 'MP', label: 'MP', type: 'bar', max: 100, maxKey: 'MP上限' },
          { key: '金币', label: '金币', type: 'num' },
          { key: '阵营', label: '阵营', type: 'text' },
        ],
      },
      {
        label: '能力',
        fields: [
          { key: '装备', label: '装备', type: 'list' },
          { key: '技能', label: '技能', type: 'list' },
          { key: '状态', label: '状态', type: 'tags' },
        ],
      },
    ],
  },
  {
    id: 'cyber',
    name: '赛博朋克',
    theme: {
      accent: '#22d3ee',
      accent2: '#e879f9',
      accentInk: '#0e7490',
      accent2Ink: '#a21caf',
      icon: '⌬',
      bgGradient: 'linear-gradient(160deg, rgba(34,211,238,0.28), rgba(232,121,249,0.16) 48%, transparent 74%)',
    },
    keywords: ['赛博朋克', '赛博', '义体', '赛博精神病', '黑客', '霓虹', '芯片', '欧元币', '义体医生', '公司城'],
    groups: [
      {
        label: '机体',
        fields: [
          { key: 'HP', label: 'HP', type: 'bar', max: 100, danger: 'low' },
          { key: '人性', label: '人性', type: 'bar', max: 100, danger: 'low' },
          { key: '赛博精神病', label: '赛博精神病', type: 'bar', max: 100, invert: true },
          { key: 'RAM', label: 'RAM', type: 'bar', maxKey: 'RAM上限' },
        ],
      },
      {
        label: '街头',
        fields: [
          { key: '义体', label: '义体', type: 'list' },
          { key: '欧元币', label: '欧元币', type: 'num' },
          { key: '声望', label: '声望', type: 'num' },
          { key: '通缉等级', label: '通缉等级', type: 'bar', max: 5, invert: true },
          { key: '状态', label: '状态', type: 'tags' },
        ],
      },
    ],
  },
];

const NAME_TO_ID = {
  修仙: 'xiuxian',
  修真: 'xiuxian',
  仙侠: 'xiuxian',
  都市: 'dushi',
  末日: 'moshi',
  末世: 'moshi',
  西幻: 'xihuan',
  赛博: 'cyber',
  赛博朋克: 'cyber',
};

function getPreset(id) {
  return presets.find((preset) => preset.id === id) || null;
}

function knownFieldKeys() {
  const keys = new Set();
  for (const preset of presets) {
    for (const group of preset.groups || []) {
      for (const field of group.fields || []) {
        keys.add(field.key);
        if (field.maxKey) keys.add(field.maxKey);
      }
    }
  }
  return keys;
}

function mostlyFieldObject(obj) {
  if (!isPlainObject(obj)) return false;
  const keys = Object.keys(obj).filter((key) => !META_KEYS.has(key));
  if (!keys.length) return false;
  const known = knownFieldKeys();
  let hits = 0;
  for (const key of keys) {
    const value = peelMvu(obj[key]);
    if (known.has(key) || !isPlainObject(value) || isBarMetaObject(value)) hits += 1;
  }
  return hits / keys.length >= 0.5;
}

/**
 * 把「属性 / 背包」这种分组嵌套摊平一层，好让预设字段对得上。
 * 已经是预设字段的对象（例如功法映射）保持原样，交给列表渲染。
 */
function flattenChar(obj) {
  if (!isPlainObject(obj)) return {};
  const known = knownFieldKeys();
  const out = {};
  for (const [key, raw] of Object.entries(obj)) {
    if (META_KEYS.has(key)) continue;
    const value = peelMvu(raw);
    if (!known.has(key) && isPlainObject(value) && !isBarMetaObject(value)) {
      const entries = Object.entries(value);
      const leaves = entries.filter(([childKey, child]) => {
        const peeled = peelMvu(child);
        return known.has(childKey) || !isPlainObject(peeled) || isBarMetaObject(peeled);
      }).length;
      if (entries.length && leaves / entries.length >= 0.5) {
        for (const [childKey, child] of entries) {
          if (!Object.prototype.hasOwnProperty.call(out, childKey)) out[childKey] = child;
        }
        continue;
      }
    }
    out[key] = raw;
  }
  return out;
}

function charsFromBag(bag) {
  if (!isPlainObject(bag)) return [];
  const entries = Object.entries(bag).filter(([, value]) => isPlainObject(peelMvu(value)));
  return entries.map(([name, value]) => ({ name, data: flattenChar(peelMvu(value)) }));
}

/**
 * 多角色：
 * 1. stat_data.角色 / characters
 * 2. 顶层值大多是「字段样子」的对象 → {角色名: {…}}
 * 3. 否则整包算一个角色，名字用角色卡 name2，没有就叫「主角」
 * 顶层若是「属性 / 背包」这种分组名，不当成角色，摊平进同一个角色。
 */
function splitCharacters(stat, fallbackName) {
  const name = fallbackName || '主角';
  if (Array.isArray(stat)) {
    return stat.map((item, index) => {
      if (!isPlainObject(item)) return { name: `角色${index + 1}`, data: {} };
      const label = item.名称 || item.name || item.角色 || `角色${index + 1}`;
      const data = { ...item };
      delete data.名称;
      delete data.name;
      delete data.角色;
      return { name: String(label), data: flattenChar(data) };
    });
  }
  if (!isPlainObject(stat)) return [{ name, data: {} }];

  const bag = stat.角色 || stat.characters || stat.角色列表;
  if (isPlainObject(bag)) {
    const chars = charsFromBag(bag);
    if (chars.length) return chars;
  }

  const allKeys = Object.keys(stat).filter((key) => !META_KEYS.has(key));
  const entries = allKeys
    .map((key) => [key, peelMvu(stat[key])])
    .filter(([, value]) => isPlainObject(value) && !isBarMetaObject(value));
  if (entries.length >= 1 && entries.length >= allKeys.length * 0.6) {
    const fieldLike = entries.filter(([, value]) => mostlyFieldObject(value));
    const names = fieldLike.map(([key]) => key);
    const groupish = names.filter((key) => GROUP_KEYS.has(key)).length;
    if (
      fieldLike.length >= 1 &&
      fieldLike.length / entries.length >= 0.6 &&
      groupish < names.length * 0.6
    ) {
      return fieldLike.map(([key, value]) => ({ name: key, data: flattenChar(value) }));
    }
  }
  return [{ name, data: flattenChar(stat) }];
}

function matchWorldviewToken(text) {
  const source = String(text || '');
  const idMatch = source.match(/zns\s*[:：]\s*([a-z0-9_-]+)/i);
  if (idMatch && getPreset(idMatch[1].toLowerCase())) return idMatch[1].toLowerCase();
  const nameMatch = source.match(/世界观\s*[:：]\s*([^\s,，;；|]+)/);
  if (nameMatch) {
    const token = nameMatch[1].trim();
    if (getPreset(token)) return token;
    if (NAME_TO_ID[token]) return NAME_TO_ID[token];
  }
  return null;
}

function matchTokenList(list) {
  for (const item of list || []) {
    if (item == null) continue;
    const text = String(item).trim();
    if (!text) continue;
    const tagged = matchWorldviewToken(text);
    if (tagged) return tagged;
    if (getPreset(text)) return text;
    if (NAME_TO_ID[text]) return NAME_TO_ID[text];
  }
  return null;
}

function scoreKeywords(text) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return null;
  let bestId = null;
  let best = 0;
  for (const preset of presets) {
    let score = 0;
    const seen = new Set();
    for (const keyword of preset.keywords || []) {
      const needle = String(keyword || '').trim().toLowerCase();
      if (needle.length < 2 || seen.has(needle)) continue;
      seen.add(needle);
      let from = 0;
      let count = 0;
      while (from < hay.length && count < 5) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        count += 1;
        from = at + needle.length;
      }
      if (!count) continue;
      const cjk = /[\u4e00-\u9fff]/.test(needle);
      const weight = (cjk && needle.length >= 2) || needle.length >= 4 ? 2 : 1;
      score += count * weight;
    }
    if (score > best) {
      best = score;
      bestId = preset.id;
    }
  }
  return best >= 2 ? bestId : null;
}

function buildView(charData, preset, showEmpty) {
  const used = new Set();
  const groups = [];
  const data = charData || {};
  for (const group of preset.groups || []) {
    const fields = [];
    for (const field of group.fields || []) {
      used.add(field.key);
      if (field.maxKey) used.add(field.maxKey);
      const has = Object.prototype.hasOwnProperty.call(data, field.key);
      const raw = has ? data[field.key] : undefined;
      const empty = !has || isEmptyValue(raw);
      if (empty && !showEmpty) continue;
      fields.push({ field, raw, empty });
    }
    if (fields.length) groups.push({ label: group.label, fields, extra: false });
  }
  const extras = [];
  for (const [key, raw] of Object.entries(data)) {
    if (used.has(key) || META_KEYS.has(key)) continue;
    if (isEmptyValue(raw) && !showEmpty) continue;
    extras.push({
      field: { key, label: key, type: 'text' },
      raw,
      empty: isEmptyValue(raw),
    });
  }
  if (extras.length) groups.push({ label: '其他', fields: extras, extra: true });
  return groups;
}

// ---------------------------------------------------------------------------
// 启动。浏览器里注入宿主页面；Node 里只留下面的自测入口。
// ---------------------------------------------------------------------------

function start() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const hostWin = (() => {
    try {
      return window.parent && window.parent.document ? window.parent : window;
    } catch {
      return window;
    }
  })();

  const hostDoc = hostWin.document;
  if (!hostDoc) return;
  if (hostDoc.body) boot(hostWin);
  else if (hostDoc.readyState === 'loading') hostDoc.addEventListener('DOMContentLoaded', () => boot(hostWin), { once: true });
  else setTimeout(() => boot(hostWin), 0);
}

function boot(hostWin) {
  const hostDoc = hostWin.document;
  try {
    hostWin.ZNS?._destroy?.();
  } catch {
    /* 旧实例清理失败也不拦新的 */
  }
  hostDoc.getElementById('zns-root')?.remove();
  hostDoc.getElementById('zns-style')?.remove();

  const styleEl = hostDoc.createElement('style');
  styleEl.id = 'zns-style';
  styleEl.textContent = CSS_TEXT;
  hostDoc.body.appendChild(styleEl);

  const root = hostDoc.createElement('div');
  root.id = 'zns-root';
  root.className = 'zns-root';
  root.setAttribute('data-zns-theme', 'dark');
  root.setAttribute('data-zns-theme-mode', 'dark');
  hostDoc.body.appendChild(root);

  const fab = hostDoc.createElement('button');
  fab.id = 'zns-fab';
  fab.className = 'zns-fab';
  fab.type = 'button';
  fab.setAttribute('aria-label', '人物状态栏');
  fab.setAttribute('aria-expanded', 'false');
  fab.textContent = '☯';
  root.appendChild(fab);

  const panel = hostDoc.createElement('section');
  panel.id = 'zns-panel';
  panel.className = 'zns-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '人物状态栏');
  panel.hidden = true;
  root.appendChild(panel);

  const grip = hostDoc.createElement('div');
  grip.className = 'zns-sheet-grip';
  grip.setAttribute('aria-hidden', 'true');
  panel.appendChild(grip);

  const header = hostDoc.createElement('header');
  header.className = 'zns-header';
  panel.appendChild(header);

  const brand = hostDoc.createElement('div');
  brand.className = 'zns-brand';
  header.appendChild(brand);

  const icon = hostDoc.createElement('div');
  icon.className = 'zns-icon';
  icon.textContent = '☯';
  brand.appendChild(icon);

  const titles = hostDoc.createElement('div');
  titles.className = 'zns-titles';
  brand.appendChild(titles);

  const titleEl = hostDoc.createElement('div');
  titleEl.className = 'zns-title';
  titleEl.textContent = '人物状态';
  titles.appendChild(titleEl);

  const sourceEl = hostDoc.createElement('div');
  sourceEl.className = 'zns-source';
  sourceEl.textContent = '来源：检测中';
  titles.appendChild(sourceEl);

  const actions = hostDoc.createElement('div');
  actions.className = 'zns-actions';
  header.appendChild(actions);

  const themeBtn = iconButton(hostDoc, 'zns-theme', '切换主题');
  const refreshBtn = iconButton(hostDoc, 'zns-refresh', '刷新');
  refreshBtn.appendChild(svgEl(hostDoc, SVG_REFRESH));
  const closeBtn = iconButton(hostDoc, 'zns-close', '关闭');
  closeBtn.appendChild(svgEl(hostDoc, SVG_CLOSE));
  actions.append(themeBtn, refreshBtn, closeBtn);

  const toolbar = hostDoc.createElement('div');
  toolbar.className = 'zns-toolbar';
  panel.appendChild(toolbar);

  const select = hostDoc.createElement('select');
  select.id = 'zns-worldview';
  select.className = 'zns-select';
  select.setAttribute('aria-label', '世界观');
  toolbar.appendChild(select);

  const tabs = hostDoc.createElement('div');
  tabs.id = 'zns-tabs';
  tabs.className = 'zns-tabs';
  tabs.setAttribute('role', 'tablist');
  panel.appendChild(tabs);

  const body = hostDoc.createElement('div');
  body.id = 'zns-body';
  body.className = 'zns-body';
  panel.appendChild(body);

  const footer = hostDoc.createElement('footer');
  footer.className = 'zns-footer';
  panel.appendChild(footer);

  const emptyLabel = hostDoc.createElement('label');
  emptyLabel.className = 'zns-check';
  const emptyInput = hostDoc.createElement('input');
  emptyInput.id = 'zns-show-empty';
  emptyInput.type = 'checkbox';
  emptyLabel.appendChild(emptyInput);
  emptyLabel.appendChild(hostDoc.createTextNode('显示空字段'));
  footer.appendChild(emptyLabel);

  const footNote = hostDoc.createElement('div');
  footNote.className = 'zns-footnote';
  footNote.textContent = '只读';
  footer.appendChild(footNote);

  const ls = storageOf(hostWin);
  let themeMode = safeGet(ls, 'zns_theme') || 'dark';
  if (themeMode !== 'light' && themeMode !== 'auto') themeMode = 'dark';
  let showEmpty = safeGet(ls, 'zns_show_empty') === '1';
  emptyInput.checked = showEmpty;
  let panelOpen = false;
  let activeName = '';
  let model = null;
  let pollTimer = 0;
  let refreshSeq = 0;
  let destroyed = false;
  let suppressClick = false;
  let optionSig = '';
  const offs = [];
  let resizeObserver = null;
  let media = null;

  function resolvedTheme() {
    if (themeMode === 'light') return 'light';
    if (themeMode === 'dark') return 'dark';
    return detectHostTheme(hostWin);
  }

  function applyTheme() {
    const theme = resolvedTheme();
    root.setAttribute('data-zns-theme', theme);
    root.setAttribute('data-zns-theme-mode', themeMode);
    themeBtn.replaceChildren();
    if (themeMode === 'auto') {
      themeBtn.textContent = '随';
      themeBtn.title = '主题：跟随宿主（点击切换）';
    } else if (theme === 'light') {
      themeBtn.appendChild(svgEl(hostDoc, SVG_SUN));
      themeBtn.title = '主题：白昼樱花（点击切换）';
    } else {
      themeBtn.appendChild(svgEl(hostDoc, SVG_MOON));
      themeBtn.title = '主题：夜空（点击切换）';
    }
    themeBtn.setAttribute('aria-label', themeBtn.title);
    if (model?.preset) applyAccent(model.preset);
  }

  function applyAccent(preset) {
    const theme = preset?.theme || {};
    const light = root.getAttribute('data-zns-theme') === 'light';
    const accent = light ? (theme.accentInk || theme.accent || '#7c3aed') : (theme.accent || '#a78bfa');
    const accent2 = light ? (theme.accent2Ink || theme.accent2 || '#d97706') : (theme.accent2 || '#fbbf24');
    root.style.setProperty('--zns-accent', accent);
    root.style.setProperty('--zns-accent-2', accent2);
    root.style.setProperty('--zns-glow', theme.bgGradient || 'none');
    const glyph = theme.icon || '✦';
    icon.textContent = glyph;
    fab.textContent = glyph;
  }

  function syncOptions() {
    const sig = presets.map((preset) => `${preset.id}:${preset.name}`).join('|');
    if (sig === optionSig) return;
    optionSig = sig;
    const current = select.value;
    select.replaceChildren();
    const auto = hostDoc.createElement('option');
    auto.value = '';
    auto.textContent = '自动检测';
    select.appendChild(auto);
    for (const preset of presets) {
      const option = hostDoc.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      select.appendChild(option);
    }
    select.value = [...select.options].some((option) => option.value === current) ? current : '';
  }

  function render() {
    syncOptions();
    applyTheme();
    if (!model) return;
    const preset = model.preset || presets[0];
    titleEl.textContent = preset ? preset.name : '人物状态';
    sourceEl.textContent = model.error
      ? model.error
      : `来源：${model.source || '默认'}${model.statSource ? ` · ${model.statSource}` : ''}`;
    if (preset) applyAccent(preset);

    const manualId = model.manualId || '';
    if (select.value !== manualId && hostDoc.activeElement !== select) select.value = manualId;

    const chars = model.characters || [];
    if (!chars.some((char) => char.name === activeName)) activeName = chars[0]?.name || '';

    tabs.replaceChildren();
    chars.forEach((char) => {
      const tab = hostDoc.createElement('button');
      tab.type = 'button';
      tab.className = 'zns-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', char.name === activeName ? 'true' : 'false');
      if (char.name === activeName) tab.classList.add('is-active');
      tab.textContent = char.name;
      tab.title = char.name;
      tab.addEventListener('click', () => {
        activeName = char.name;
        render();
      });
      tabs.appendChild(tab);
    });
    tabs.hidden = chars.length === 0;

    const scroll = body.scrollTop;
    body.replaceChildren();
    if (model.error && !chars.length) {
      body.appendChild(emptyNote(hostDoc, model.error));
    } else if (!preset) {
      body.appendChild(emptyNote(hostDoc, '没有可用的世界观预设'));
    } else if (!chars.length) {
      body.appendChild(emptyNote(hostDoc, '还没有状态数据'));
    } else {
      const char = chars.find((item) => item.name === activeName) || chars[0];
      const groups = buildView(char.data, preset, showEmpty);
      if (!groups.length) {
        body.appendChild(emptyNote(hostDoc, showEmpty ? '没有字段' : '没有可显示的字段'));
      }
      for (const group of groups) {
        const section = hostDoc.createElement('section');
        section.className = 'zns-group';
        const label = hostDoc.createElement('div');
        label.className = 'zns-group-label';
        label.textContent = group.label;
        section.appendChild(label);
        for (const item of group.fields) section.appendChild(renderField(hostDoc, item, char.data));
        body.appendChild(section);
      }
    }
    body.scrollTop = scroll;
    if (panelOpen) positionPanel();
  }

  function placeFab(x, y) {
    const pos = clampFab(hostWin, x, y);
    fab.style.left = `${pos.x}px`;
    fab.style.top = `${pos.y}px`;
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    return pos;
  }

  function loadFab() {
    const raw = safeGet(ls, 'zns_fab_pos');
    if (raw) {
      try {
        const saved = JSON.parse(raw);
        if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
          placeFab(saved.x, saved.y);
          return;
        }
      } catch {
        /* 坏掉的坐标就用默认位置 */
      }
    }
    const size = 52;
    placeFab(hostWin.innerWidth - size - 20, hostWin.innerHeight - size - 88);
  }

  function positionPanel() {
    const narrow = hostWin.innerWidth < 600;
    panel.classList.toggle('is-sheet', narrow);
    if (narrow) {
      panel.style.left = '0px';
      panel.style.right = '0px';
      panel.style.bottom = '0px';
      panel.style.top = 'auto';
      panel.style.width = 'auto';
      return;
    }
    const rect = fab.getBoundingClientRect();
    const width = panel.offsetWidth || 400;
    const height = panel.offsetHeight || 480;
    const gap = 12;
    let left = rect.left - width - gap;
    if (left < 8) left = rect.right + gap;
    if (left + width > hostWin.innerWidth - 8) left = Math.max(8, hostWin.innerWidth - width - 8);
    let top = rect.bottom - height;
    if (top < 8) top = 8;
    if (top + height > hostWin.innerHeight - 8) top = Math.max(8, hostWin.innerHeight - height - 8);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.width = '';
  }

  function startPoll() {
    stopPoll();
    pollTimer = hostWin.setInterval(() => {
      refresh({ quiet: true });
    }, 5000);
  }

  function stopPoll() {
    if (pollTimer) {
      hostWin.clearInterval(pollTimer);
      pollTimer = 0;
    }
  }

  function openPanel() {
    panelOpen = true;
    panel.hidden = false;
    panel.classList.add('is-open');
    fab.setAttribute('aria-expanded', 'true');
    positionPanel();
    hostWin.requestAnimationFrame(positionPanel);
    startPoll();
  }

  function closePanel() {
    panelOpen = false;
    panel.classList.remove('is-open');
    panel.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
    stopPoll();
  }

  function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
  }

  // 点击和拖动：位移超过阈值才算拖，避免轻轻一晃把点击吃掉。
  // 拖完后浏览器仍可能补发 click（按钮跟着指针走，pointerup 落在按钮上），所以短暂吞掉那一次。
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;
  let dragged = false;
  const DRAG_THRESHOLD = 8;

  fab.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return;
    pointerId = event.pointerId;
    dragged = false;
    startX = event.clientX;
    startY = event.clientY;
    const rect = fab.getBoundingClientRect();
    originX = rect.left;
    originY = rect.top;
    try {
      fab.setPointerCapture(pointerId);
    } catch {
      /* 某些宿主不给捕获，移动事件仍可能打在按钮上 */
    }
    fab.classList.add('is-dragging');
  });

  fab.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragged = true;
    placeFab(originX + dx, originY + dy);
    if (panelOpen) positionPanel();
  });

  function endPointer(event) {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    fab.classList.remove('is-dragging');
    if (dragged) {
      const rect = fab.getBoundingClientRect();
      const pos = placeFab(rect.left, rect.top);
      safeSet(ls, 'zns_fab_pos', JSON.stringify(pos));
      suppressClick = true;
      hostWin.setTimeout(() => {
        suppressClick = false;
      }, 350);
    }
  }

  fab.addEventListener('pointerup', endPointer);
  fab.addEventListener('pointercancel', endPointer);
  fab.addEventListener('click', (event) => {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    togglePanel();
  });

  themeBtn.addEventListener('click', () => {
    themeMode = themeMode === 'dark' ? 'light' : themeMode === 'light' ? 'auto' : 'dark';
    safeSet(ls, 'zns_theme', themeMode);
    applyTheme();
    render();
  });

  refreshBtn.addEventListener('click', () => {
    refreshBtn.classList.add('is-busy');
    refresh({ force: true }).finally(() => refreshBtn.classList.remove('is-busy'));
  });

  closeBtn.addEventListener('click', closePanel);
  emptyInput.addEventListener('change', () => {
    showEmpty = emptyInput.checked;
    safeSet(ls, 'zns_show_empty', showEmpty ? '1' : '0');
    render();
  });

  select.addEventListener('change', () => {
    setWorldview(select.value);
  });

  function onKeydown(event) {
    if (event.key === 'Escape' && panelOpen) closePanel();
  }

  function onResize() {
    const rect = fab.getBoundingClientRect();
    placeFab(rect.left, rect.top);
    if (panelOpen) positionPanel();
  }

  hostDoc.addEventListener('keydown', onKeydown);
  hostWin.addEventListener('resize', onResize);
  offs.push(() => hostDoc.removeEventListener('keydown', onKeydown));
  offs.push(() => hostWin.removeEventListener('resize', onResize));

  try {
    media = hostWin.matchMedia('(prefers-color-scheme: light)');
    const onMedia = () => {
      if (themeMode === 'auto') applyTheme();
    };
    media.addEventListener?.('change', onMedia);
    offs.push(() => media.removeEventListener?.('change', onMedia));
  } catch {
    /* 没有 matchMedia 就只靠手动主题 */
  }

  try {
    const observer = new hostWin.MutationObserver(() => {
      if (themeMode === 'auto') applyTheme();
    });
    observer.observe(hostDoc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    if (hostDoc.body) observer.observe(hostDoc.body, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    const zhino = hostDoc.querySelector('.zhino-root');
    if (zhino) observer.observe(zhino, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    resizeObserver = observer;
  } catch {
    /* 观察失败时，刷新和轮询仍会重算跟随主题 */
  }

  try {
    const panelObserver = new hostWin.ResizeObserver(() => {
      if (panelOpen) positionPanel();
    });
    panelObserver.observe(panel);
    offs.push(() => panelObserver.disconnect());
  } catch {
    /* 没有 ResizeObserver 时，打开和窗口变化仍会摆一次位置 */
  }

  function pickFn(name) {
    try {
      if (typeof window[name] === 'function') return window[name].bind(window);
    } catch {
      /* iframe 全局不可读 */
    }
    try {
      if (hostWin !== window && typeof hostWin[name] === 'function') return hostWin[name].bind(hostWin);
    } catch {
      /* 跨域父页 */
    }
    return null;
  }

  function pickGlobal(name) {
    try {
      if (typeof window[name] !== 'undefined') return window[name];
    } catch {
      /* 忽略 */
    }
    try {
      if (hostWin !== window && typeof hostWin[name] !== 'undefined') return hostWin[name];
    } catch {
      /* 忽略 */
    }
    return undefined;
  }

  async function readVariables(type, messageId) {
    const getVariables = pickFn('getVariables');
    if (!getVariables) return null;
    try {
      const opt = { type };
      if (messageId != null) opt.message_id = messageId;
      const data = await maybeAwait(getVariables(opt));
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  function safeContext() {
    const pools = [];
    try {
      if (typeof SillyTavern !== 'undefined') pools.push(SillyTavern);
    } catch {
      /* 忽略 */
    }
    try {
      if (hostWin.SillyTavern) pools.push(hostWin.SillyTavern);
    } catch {
      /* 忽略 */
    }
    for (const api of pools) {
      try {
        if (typeof api.getContext === 'function') {
          const ctx = api.getContext();
          if (ctx) return ctx;
        }
      } catch {
        /* 下一处 */
      }
    }
    return null;
  }

  function activeCharacter(ctx) {
    if (!ctx) return null;
    const list = ctx.characters;
    const id = ctx.characterId;
    if (Array.isArray(list) && list[id]) return list[id];
    if (list && typeof list === 'object' && id != null && list[id]) return list[id];
    return null;
  }

  function characterDisplayName(ctx) {
    return ctx?.name2 || activeCharacter(ctx)?.name || '主角';
  }

  function collectTags(char) {
    if (!char) return [];
    const bags = [char.tags, char.data?.tags, char.data?.extensions?.tags];
    const out = [];
    for (const bag of bags) {
      if (!bag) continue;
      if (Array.isArray(bag)) out.push(...bag);
      else if (typeof bag === 'string') out.push(...bag.split(/[,，]/));
    }
    return out;
  }

  function charTextBlob(char) {
    if (!char) return '';
    const data = char.data || {};
    return [
      char.description, char.personality, char.scenario, char.first_mes, char.mes_example, char.creator_notes,
      data.description, data.personality, data.scenario, data.first_mes, data.mes_example, data.creator_notes,
    ].filter(Boolean).join('\n');
  }

  function scanEntries(entries) {
    const list = Array.isArray(entries)
      ? entries
      : (entries && typeof entries === 'object' ? Object.values(entries) : []);
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const parts = [entry.comment, entry.name, entry.key, entry.title];
      if (Array.isArray(entry.keys)) parts.push(...entry.keys);
      else if (typeof entry.keys === 'string') parts.push(entry.keys);
      const hit = matchTokenList(parts.filter((part) => part != null).map(String));
      if (hit) return hit;
    }
    return null;
  }

  async function matchWorldbook(ctx, char) {
    const books = [];
    const characterBook = char?.data?.character_book || char?.character_book;
    if (characterBook?.entries) books.push(characterBook.entries);
    for (const key of ['worldInfo', 'world_info', 'lorebook']) {
      const info = ctx?.[key];
      if (!info) continue;
      if (info.entries) books.push(info.entries);
      else if (Array.isArray(info)) books.push(info);
    }
    for (const entries of books) {
      const hit = scanEntries(entries);
      if (hit) return hit;
    }

    const getNames = pickFn('getCharWorldbookNames');
    const getBook = pickFn('getWorldbook');
    if (!getNames || !getBook) return null;
    try {
      const names = await maybeAwait(getNames('current'));
      const list = [];
      if (names?.primary) list.push(names.primary);
      if (Array.isArray(names?.additional)) list.push(...names.additional);
      if (Array.isArray(names)) list.push(...names);
      for (const bookName of list) {
        if (!bookName) continue;
        try {
          const book = await maybeAwait(getBook(bookName));
          const hit = scanEntries(book?.entries || book);
          if (hit) return hit;
        } catch {
          /* 单本世界书读失败不影响其他来源 */
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  async function detectWorldview() {
    const manualMark = safeGet(ls, 'zns_manual_worldview') || '';
    const chatVars = await readVariables('chat');
    const chatWv = chatVars && typeof chatVars.zns_worldview === 'string' ? chatVars.zns_worldview : '';
    if (getPreset(chatWv)) {
      return { id: chatWv, source: chatWv === manualMark ? '手动选择' : '聊天变量', manualId: chatWv === manualMark ? chatWv : '' };
    }

    const ctx = safeContext();
    const char = activeCharacter(ctx);
    const tagHit = matchTokenList(collectTags(char));
    if (tagHit) return { id: tagHit, source: '角色卡标签', manualId: '' };

    const bookHit = await matchWorldbook(ctx, char);
    if (bookHit) return { id: bookHit, source: '世界书', manualId: '' };

    const keywordHit = scoreKeywords(charTextBlob(char));
    if (keywordHit) return { id: keywordHit, source: '关键词匹配', manualId: '' };

    const stored = safeGet(ls, 'zns_worldview') || '';
    if (getPreset(stored)) return { id: stored, source: '手动选择', manualId: stored };

    return { id: presets[0]?.id || 'xiuxian', source: '默认', manualId: '' };
  }

  function messageTextOf(message) {
    if (!message || typeof message !== 'object') return '';
    return message.message || message.mes || message.content || '';
  }

  function isAssistantMessage(message) {
    if (!message || typeof message !== 'object') return false;
    if (message.role) return message.role === 'assistant';
    if ('is_user' in message) return message.is_user === false && message.is_system !== true;
    return true;
  }

  async function getLastAiText() {
    const getChatMessages = pickFn('getChatMessages');
    const ctx = safeContext();
    if (getChatMessages) {
      try {
        let messages = await maybeAwait(getChatMessages(-1));
        if (!Array.isArray(messages)) messages = messages ? [messages] : [];
        const last = messages[messages.length - 1];
        if (last && isAssistantMessage(last)) {
          const text = messageTextOf(last);
          if (text) return text;
        }
      } catch {
        /* 换一条路径 */
      }
      try {
        const total = Array.isArray(ctx?.chat) ? ctx.chat.length : 0;
        if (total > 0) {
          const start = Math.max(0, total - 30);
          let messages = await maybeAwait(getChatMessages(`${start}-${total - 1}`));
          if (!Array.isArray(messages)) messages = messages ? [messages] : [];
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (isAssistantMessage(messages[i])) {
              const text = messageTextOf(messages[i]);
              if (text) return text;
            }
          }
        }
      } catch {
        /* 再退回上下文 */
      }
    }
    try {
      const chat = ctx?.chat;
      if (Array.isArray(chat)) {
        for (let i = chat.length - 1; i >= 0; i -= 1) {
          const message = chat[i];
          if (message && message.is_user !== true && message.is_system !== true) {
            const text = message.mes || message.message || '';
            if (text) return text;
          }
        }
      }
    } catch {
      /* 没有聊天记录 */
    }
    return '';
  }

  function hasStat(stat) {
    if (Array.isArray(stat)) return stat.length > 0;
    return isPlainObject(stat) && Object.keys(stat).length > 0;
  }

  async function loadStat() {
    const mvu = pickGlobal('Mvu');
    if (mvu && typeof mvu.getMvuData === 'function') {
      try {
        const data = await maybeAwait(mvu.getMvuData({ type: 'message', message_id: 'latest' }));
        if (hasStat(data?.stat_data)) return { stat: data.stat_data, statSource: 'MVU' };
      } catch {
        /* MVU 不可用就继续 */
      }
    }
    const messageVars = await readVariables('message', 'latest');
    if (hasStat(messageVars?.stat_data)) return { stat: messageVars.stat_data, statSource: '消息变量' };
    const chatVars = await readVariables('chat');
    if (hasStat(chatVars?.stat_data)) return { stat: chatVars.stat_data, statSource: '聊天变量' };
    try {
      const text = await getLastAiText();
      const block = extractStatusBlock(text);
      if (block) {
        const parsed = parseStatusBlock(block);
        if (hasStat(parsed)) return { stat: parsed, statSource: '正文 <status>' };
      }
    } catch {
      /* 正文解析失败 */
    }
    return { stat: null, statSource: '无数据' };
  }

  async function loadModel() {
    const detected = await detectWorldview();
    const loaded = await loadStat();
    const ctx = safeContext();
    const preset = getPreset(detected.id) || presets[0];
    const characters = loaded.stat ? splitCharacters(loaded.stat, characterDisplayName(ctx)) : [];
    return {
      preset,
      source: detected.source,
      manualId: detected.manualId || '',
      statSource: loaded.statSource,
      characters,
      error: '',
    };
  }

  async function refresh() {
    const seq = ++refreshSeq;
    refreshBtn.classList.add('is-busy');
    try {
      const next = await loadModel();
      if (destroyed || seq !== refreshSeq) return next;
      model = next;
      render();
      return next;
    } catch {
      if (destroyed || seq !== refreshSeq) return null;
      model = {
        preset: presets[0],
        source: '默认',
        manualId: '',
        statSource: '无数据',
        characters: [],
        error: '读取状态失败',
      };
      render();
      return model;
    } finally {
      if (seq === refreshSeq) refreshBtn.classList.remove('is-busy');
    }
  }

  const scheduleRefresh = debounce(() => {
    refresh();
  }, 280);

  async function persistWorldview(id) {
    const value = id || '';
    const write = pickFn('insertOrAssignVariables');
    if (write) {
      try {
        await maybeAwait(write({ zns_worldview: value }, { type: 'chat' }));
      } catch {
        /* 写不进聊天变量时仍有 localStorage */
      }
    }
    if (value && getPreset(value)) {
      safeSet(ls, 'zns_worldview', value);
      safeSet(ls, 'zns_manual_worldview', value);
    } else {
      safeRemove(ls, 'zns_worldview');
      safeRemove(ls, 'zns_manual_worldview');
    }
  }

  async function setWorldview(id) {
    const next = id && getPreset(id) ? id : '';
    await persistWorldview(next);
    return refresh();
  }

  function registerPreset(preset) {
    if (!preset || typeof preset !== 'object') throw new Error('ZNS.registerPreset: preset 无效');
    if (!preset.id || typeof preset.id !== 'string') throw new Error('ZNS.registerPreset: 缺少 id');
    if (!preset.name) preset.name = preset.id;
    if (!preset.theme || typeof preset.theme !== 'object') {
      preset.theme = { accent: '#a78bfa', accent2: '#fbbf24', icon: '✦', bgGradient: 'none' };
    }
    if (!Array.isArray(preset.keywords)) preset.keywords = [];
    if (!Array.isArray(preset.groups)) preset.groups = [];
    const at = presets.findIndex((item) => item.id === preset.id);
    if (at >= 0) presets[at] = preset;
    else presets.push(preset);
    optionSig = '';
    scheduleRefresh();
    return preset;
  }

  function bindEvents() {
    const on = pickFn('eventOn');
    if (!on) return;
    const table = pickGlobal('tavern_events') || {};
    const names = [
      table.MESSAGE_RECEIVED, table.MESSAGE_SWIPED, table.CHAT_CHANGED, table.MESSAGE_EDITED, table.MESSAGE_DELETED,
      'MESSAGE_RECEIVED', 'message_received',
      'MESSAGE_SWIPED', 'message_swiped',
      'CHAT_CHANGED', 'chat_changed', 'chat_id_changed',
      'MESSAGE_EDITED', 'message_edited',
      'MESSAGE_DELETED', 'message_deleted',
    ];
    const seen = new Set();
    for (const name of names) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      try {
        const off = on(name, scheduleRefresh);
        if (typeof off === 'function') offs.push(off);
      } catch {
        /* 这个事件名宿主不认 */
      }
    }
    try {
      const mvu = pickGlobal('Mvu');
      const ended = mvu?.events?.VARIABLE_UPDATE_ENDED;
      if (ended && !seen.has(ended)) {
        const off = on(ended, scheduleRefresh);
        if (typeof off === 'function') offs.push(off);
      }
    } catch {
      /* 没有 MVU 事件 */
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopPoll();
    offs.splice(0).forEach((off) => {
      try {
        off();
      } catch {
        /* 解绑失败就留下，元素马上会拆掉 */
      }
    });
    try {
      resizeObserver?.disconnect();
    } catch {
      /* 忽略 */
    }
    root.remove();
    styleEl.remove();
    if (hostWin.ZNS && hostWin.ZNS._destroy === destroy) hostWin.ZNS = undefined;
  }

  hostWin.ZNS = {
    presets,
    registerPreset,
    refresh,
    setWorldview,
    _destroy: destroy,
  };

  window.addEventListener('pagehide', destroy);
  window.addEventListener('unload', destroy);

  bindEvents();
  applyTheme();
  loadFab();
  refresh().then(() => {
    if (destroyed) return;
    try {
      hostWin.dispatchEvent(new hostWin.Event('zns-ready'));
    } catch {
      /* 自定义事件发不出去不影响面板 */
    }
  });
}

function iconButton(doc, id, label) {
  const button = doc.createElement('button');
  button.id = id;
  button.className = 'zns-iconbtn';
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

function svgEl(doc, markup) {
  const wrap = doc.createElement('span');
  wrap.className = 'zns-svg';
  wrap.innerHTML = markup;
  return wrap;
}

function emptyNote(doc, text) {
  const note = doc.createElement('div');
  note.className = 'zns-empty';
  note.textContent = text;
  return note;
}

function renderField(doc, item, data) {
  const { field, raw, empty } = item;
  const wrap = doc.createElement('div');
  wrap.className = `zns-field zns-field-${field.type || 'text'}`;
  if (empty) wrap.classList.add('is-empty');

  if (field.type === 'bar' && !empty) {
    const parsed = parseBarValue(raw, field, data);
    if (parsed.mode === 'text') {
      wrap.className = 'zns-field zns-field-text';
      appendLabeled(doc, wrap, field.label, parsed.text);
      return wrap;
    }
    const top = doc.createElement('div');
    top.className = 'zns-field-top';
    const label = doc.createElement('span');
    label.className = 'zns-field-label';
    label.textContent = field.label;
    const num = doc.createElement('span');
    num.className = 'zns-bar-num';
    const max = parsed.max;
    num.textContent = parsed.mode === 'bar'
      ? (max != null ? `${formatQty(parsed.current)} / ${formatQty(max)}` : formatQty(parsed.current))
      : '—';
    top.append(label, num);
    wrap.appendChild(top);

    const track = doc.createElement('div');
    track.className = 'zns-bar-track';
    track.setAttribute('role', 'meter');
    const current = parsed.mode === 'bar' ? parsed.current : 0;
    const limit = max != null && max > 0 ? max : (current > 0 ? current : 1);
    const ratio = max != null && max > 0 ? Math.max(0, Math.min(1, current / max)) : (parsed.mode === 'bar' ? 1 : 0);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(limit));
    track.setAttribute('aria-valuenow', String(current));
    track.setAttribute('aria-label', field.label);
    const fill = doc.createElement('div');
    fill.className = 'zns-bar-fill';
    const danger = parsed.mode === 'bar' && barDanger(field, current, max);
    if (danger) {
      fill.classList.add('is-danger');
      wrap.classList.add('is-danger');
    }
    fill.style.width = `${ratio * 100}%`;
    if (ratio > 0 && ratio < 0.03) fill.style.minWidth = '4px';
    track.appendChild(fill);
    wrap.appendChild(track);
    return wrap;
  }

  if (field.type === 'tags' || field.type === 'list') {
    const label = doc.createElement('div');
    label.className = 'zns-field-label';
    label.textContent = field.label;
    wrap.appendChild(label);
    const chips = empty ? [] : parseChips(raw, field.type === 'list');
    if (!chips.length) {
      const dash = doc.createElement('div');
      dash.className = 'zns-field-value';
      dash.textContent = '—';
      wrap.appendChild(dash);
      return wrap;
    }
    const row = doc.createElement('div');
    row.className = 'zns-chips';
    for (const chipText of chips) {
      const chip = doc.createElement('span');
      chip.className = field.type === 'list' ? 'zns-chip is-list' : 'zns-chip';
      chip.textContent = chipText;
      row.appendChild(chip);
    }
    wrap.appendChild(row);
    return wrap;
  }

  if (field.type === 'num') {
    const parsed = empty ? { text: '—' } : parseNumValue(raw);
    appendLabeled(doc, wrap, field.label, parsed.text || '—');
    return wrap;
  }

  appendLabeled(doc, wrap, field.label, empty ? '—' : (parseTextValue(raw) || '—'));
  return wrap;
}

function appendLabeled(doc, wrap, labelText, valueText) {
  const label = doc.createElement('div');
  label.className = 'zns-field-label';
  label.textContent = labelText;
  const value = doc.createElement('div');
  value.className = 'zns-field-value';
  value.textContent = valueText;
  wrap.append(label, value);
}

function detectHostTheme(hostWin) {
  try {
    const doc = hostWin.document;
    const zhino = doc.querySelector('.zhino-root');
    const zhinoTheme = zhino?.getAttribute('data-theme');
    if (zhinoTheme === 'light' || zhinoTheme === 'dark') return zhinoTheme;
    const rootTheme = doc.documentElement.getAttribute('data-theme') || doc.body?.getAttribute('data-theme');
    if (rootTheme === 'light' || rootTheme === 'dark') return rootTheme;
    const className = `${doc.documentElement.className || ''} ${doc.body?.className || ''}`;
    if (/\blight\b/i.test(className) && !/\bdark\b/i.test(className)) return 'light';
    if (hostWin.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  } catch {
    /* 读不到宿主主题 */
  }
  return 'dark';
}

function storageOf(hostWin) {
  try {
    if (hostWin.localStorage) return hostWin.localStorage;
  } catch {
    /* 分区存储或禁用 */
  }
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* 忽略 */
  }
  return null;
}

function safeGet(store, key) {
  try {
    return store?.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function safeSet(store, key, value) {
  try {
    store?.setItem(key, value);
  } catch {
    /* 隐私模式可能拒绝写入 */
  }
}

function safeRemove(store, key) {
  try {
    store?.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

function clampFab(hostWin, x, y) {
  const size = 52;
  const maxX = Math.max(0, hostWin.innerWidth - size);
  const maxY = Math.max(0, hostWin.innerHeight - size);
  return {
    x: Math.min(Math.max(0, x), maxX),
    y: Math.min(Math.max(0, y), maxY),
  };
}

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

async function maybeAwait(value) {
  if (value && typeof value.then === 'function') return value;
  return value;
}

const SVG_REFRESH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/></svg>';
const SVG_CLOSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const SVG_MOON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/></svg>';
const SVG_SUN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

const CSS_TEXT = `
.zns-root {
  --zns-bg: var(--zn-bg-secondary, var(--zn-bg, #141a2e));
  --zns-glass: var(--zn-glass-bg, rgba(16, 13, 34, 0.94));
  --zns-glass-border: var(--zn-glass-border, rgba(167, 139, 250, 0.28));
  --zns-text: var(--zn-text-primary, rgba(255, 255, 255, 0.94));
  --zns-text-dim: var(--zn-text-regular, rgba(255, 255, 255, 0.76));
  --zns-text-muted: var(--zn-text-muted, rgba(255, 255, 255, 0.62));
  --zns-border: var(--zn-border-light, rgba(255, 255, 255, 0.12));
  --zns-surface: var(--zn-bg-surface2, rgba(255, 255, 255, 0.06));
  --zns-sunken: var(--zn-surface-sunken, rgba(0, 0, 0, 0.28));
  --zns-danger: var(--zn-danger, #f87171);
  --zns-shadow: var(--zn-shadow-glass, 0 24px 48px rgba(8, 6, 24, 0.55));
  --zns-blur: var(--zn-glass-blur, blur(16px) saturate(130%));
  --zns-highlight: var(--zn-glass-highlight, rgba(255, 255, 255, 0.16));
  --zns-star: rgba(255, 255, 255, 0.85);
  --zns-star-dim: rgba(255, 255, 255, 0.45);
  --zns-accent: #5eead4;
  --zns-accent-2: #fbbf24;
  --zns-glow: none;
  --zns-radius: 16px;
  position: fixed;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  overflow: visible;
  z-index: 100010;
  pointer-events: none;
  color: var(--zns-text);
  color-scheme: dark;
  font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
.zns-root, .zns-root * { box-sizing: border-box; }
.zns-root[data-zns-theme="light"] {
  --zns-bg: #fdf6fb;
  --zns-glass: rgba(253, 246, 251, 0.97);
  --zns-glass-border: rgba(124, 58, 237, 0.28);
  --zns-text: #241c38;
  --zns-text-dim: #3d3558;
  --zns-text-muted: #5c5478;
  --zns-border: rgba(42, 36, 64, 0.14);
  --zns-surface: rgba(124, 58, 237, 0.06);
  --zns-sunken: rgba(124, 58, 237, 0.08);
  --zns-danger: #dc2626;
  --zns-shadow: 0 22px 44px rgba(150, 120, 170, 0.28);
  --zns-highlight: rgba(255, 255, 255, 0.85);
  --zns-star: rgba(124, 58, 237, 0.45);
  --zns-star-dim: rgba(244, 114, 182, 0.55);
  color-scheme: light;
}
.zns-fab, .zns-panel { pointer-events: auto; }
.zns-fab {
  position: fixed;
  z-index: 100011;
  width: 52px;
  height: 52px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--zns-glass-border);
  background: var(--zns-glass);
  color: var(--zns-accent);
  box-shadow: 0 0 18px color-mix(in srgb, var(--zns-accent) 42%, transparent), 0 10px 24px rgba(0, 0, 0, 0.28);
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  backdrop-filter: var(--zns-blur);
  -webkit-backdrop-filter: var(--zns-blur);
  font: inherit;
  font-size: 22px;
  line-height: 1;
  display: grid;
  place-items: center;
}
.zns-fab.is-dragging { cursor: grabbing; box-shadow: 0 0 0 4px color-mix(in srgb, var(--zns-accent) 28%, transparent), 0 12px 28px rgba(0, 0, 0, 0.32); }
.zns-fab:focus-visible, .zns-iconbtn:focus-visible, .zns-tab:focus-visible, .zns-select:focus-visible {
  outline: 2px solid var(--zns-accent);
  outline-offset: 2px;
}
.zns-panel {
  position: fixed;
  z-index: 100012;
  display: none;
  flex-direction: column;
  width: min(400px, calc(100vw - 24px));
  max-height: calc(100vh - 16px);
  border-radius: var(--zns-radius);
  overflow: hidden;
  color: var(--zns-text);
  background-color: var(--zns-glass);
  background-image: var(--zns-glow);
  background-repeat: no-repeat;
  border: 1px solid var(--zns-glass-border);
  box-shadow: var(--zns-shadow), inset 0 1px 0 var(--zns-highlight);
  backdrop-filter: var(--zns-blur);
  -webkit-backdrop-filter: var(--zns-blur);
}
.zns-panel.is-open { display: flex; height: auto; max-height: calc(100vh - 16px); }
.zns-panel::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background-image:
    radial-gradient(1.2px 1.2px at 14% 16%, var(--zns-star), transparent 60%),
    radial-gradient(1px 1px at 32% 58%, var(--zns-star-dim), transparent 60%),
    radial-gradient(1.2px 1.2px at 58% 24%, var(--zns-star), transparent 60%),
    radial-gradient(1px 1px at 78% 46%, var(--zns-star-dim), transparent 60%),
    radial-gradient(1px 1px at 88% 78%, var(--zns-star), transparent 60%);
}
.zns-panel > * { position: relative; z-index: 1; }
.zns-sheet-grip {
  display: none;
  width: 40px;
  height: 4px;
  border-radius: 999px;
  background: var(--zns-border);
  margin: 8px auto 0;
  flex: none;
}
.zns-panel.is-sheet.is-open {
  left: 0;
  right: 0;
  bottom: 0;
  top: auto;
  width: auto;
  height: 75vh;
  max-height: 75vh;
  border-radius: 18px 18px 0 0;
  border-bottom: none;
  padding-bottom: env(safe-area-inset-bottom);
}
.zns-panel.is-sheet .zns-sheet-grip { display: block; }
.zns-header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 12px 6px;
  flex: none;
}
.zns-brand { display: flex; gap: 8px; min-width: 0; flex: 1; align-items: center; }
.zns-icon {
  width: 36px;
  height: 36px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: color-mix(in srgb, var(--zns-accent) 18%, transparent);
  color: var(--zns-accent);
  border: 1px solid color-mix(in srgb, var(--zns-accent) 42%, transparent);
  font-size: 18px;
}
.zns-titles { min-width: 0; }
.zns-title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zns-source {
  margin-top: 2px;
  font-size: 11px;
  color: var(--zns-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.zns-actions { display: flex; gap: 4px; flex: none; }
.zns-iconbtn {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  border: 1px solid var(--zns-border);
  background: var(--zns-surface);
  color: var(--zns-text);
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0;
}
.zns-iconbtn:hover { border-color: var(--zns-accent); color: var(--zns-accent); }
.zns-svg { display: grid; place-items: center; width: 16px; height: 16px; }
.zns-svg svg { display: block; }
.zns-iconbtn.is-busy svg { animation: zns-spin 0.8s linear infinite; }
@keyframes zns-spin { to { transform: rotate(360deg); } }
.zns-toolbar { padding: 0 12px 8px; flex: none; }
.zns-select {
  width: 100%;
  height: 34px;
  border-radius: 10px;
  border: 1px solid var(--zns-border);
  background: var(--zns-sunken);
  color: var(--zns-text);
  padding: 0 10px;
  font: inherit;
  font-size: 13px;
}
.zns-tabs {
  display: flex;
  gap: 6px;
  padding: 0 12px 8px;
  overflow-x: auto;
  flex: none;
  scrollbar-width: none;
}
.zns-tabs::-webkit-scrollbar { display: none; }
.zns-tab {
  flex: none;
  max-width: 148px;
  border: 1px solid var(--zns-border);
  background: transparent;
  color: var(--zns-text-dim);
  border-radius: 999px;
  padding: 4px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zns-tab.is-active {
  color: var(--zns-text);
  border-color: var(--zns-accent);
  background: color-mix(in srgb, var(--zns-accent) 20%, transparent);
}
.zns-body {
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 12px 10px;
  flex: 1 1 auto;
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: var(--zns-border) transparent;
}
.zns-body::-webkit-scrollbar { width: 8px; }
.zns-body::-webkit-scrollbar-thumb { background: var(--zns-border); border-radius: 999px; }
.zns-group {
  margin: 0 0 10px;
  padding: 10px 10px 6px;
  background: var(--zns-surface);
  border: 1px solid var(--zns-border);
  border-radius: 12px;
}
.zns-group:last-child { margin-bottom: 0; }
.zns-group-label {
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--zns-text-muted);
  margin-bottom: 8px;
}
.zns-field { margin-bottom: 8px; min-width: 0; }
.zns-field-text, .zns-field-num {
  display: grid;
  grid-template-columns: minmax(4.5em, max-content) minmax(0, 1fr);
  gap: 8px;
  align-items: start;
}
.zns-field-top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
  margin-bottom: 4px;
}
.zns-field-label { color: var(--zns-text-dim); font-size: 12px; }
.zns-field-value, .zns-bar-num {
  color: var(--zns-text);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.zns-field-text .zns-field-value { text-align: left; }
.zns-field-num .zns-field-value { text-align: right; }
.zns-field.is-empty .zns-field-value, .zns-field.is-empty .zns-bar-num { color: var(--zns-text-muted); }
.zns-field.is-danger .zns-bar-num { color: var(--zns-danger); }
.zns-bar-track {
  height: 8px;
  border-radius: 999px;
  background: var(--zns-sunken);
  overflow: hidden;
  border: 1px solid var(--zns-border);
}
.zns-bar-fill {
  height: 100%;
  width: 0;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--zns-accent), var(--zns-accent-2));
}
.zns-bar-fill.is-danger { background: linear-gradient(90deg, #fb7185, var(--zns-danger)); }
.zns-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; min-width: 0; }
.zns-chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 3px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--zns-accent) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--zns-accent) 38%, var(--zns-border));
  color: var(--zns-text);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.zns-chip.is-list::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--zns-accent);
  margin-right: 6px;
  flex: none;
}
.zns-footer {
  flex: none;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 12px;
  border-top: 1px solid var(--zns-border);
}
.zns-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--zns-text-dim);
  cursor: pointer;
  user-select: none;
}
.zns-footnote { font-size: 10px; letter-spacing: 0.14em; color: var(--zns-text-muted); }
.zns-empty {
  padding: 28px 12px;
  text-align: center;
  color: var(--zns-text-muted);
  font-size: 13px;
}
@media (prefers-reduced-motion: reduce) {
  .zns-iconbtn.is-busy svg { animation: none; }
}
`;

function runSelfTest() {
  const assert = (cond, message) => {
    if (!cond) throw new Error(message);
  };

  assert(escapeHtml(`<img alt="x" src='a'>&`) === '&lt;img alt=&quot;x&quot; src=&#39;a&#39;&gt;&amp;', 'escapeHtml');

  const yaml = parseYamlish(`
# 注释
林动:
  境界: 筑基中期
  灵力: 80/120
  功法:
    - 青元剑诀
    - 风灵步
  状态: [轻伤, 灵气充盈]
  心境: "波澜不惊"
苏晚晴:
  境界: 金丹初期
  背包:
    灵石: 10
`);
  assert(yaml.林动.境界 === '筑基中期', 'yaml realm');
  assert(yaml.林动.灵力 === '80/120', 'yaml slash');
  assert(yaml.林动.功法.length === 2 && yaml.林动.功法[0] === '青元剑诀', 'yaml list');
  assert(Array.isArray(yaml.林动.状态) && yaml.林动.状态[1] === '灵气充盈', 'inline list');
  assert(yaml.林动.心境 === '波澜不惊', 'quotes');
  assert(yaml.苏晚晴.背包.灵石 === 10, 'nested number');

  const block = extractStatusBlock('前文\n<status>\n{"林动":{"境界":"筑基"}}\n</status>\n后文');
  const json = parseStatusBlock(block);
  assert(json.林动.境界 === '筑基', 'json status');

  const mvuBar = parseBarValue([80, '当前灵力，战斗会消耗'], { key: '灵力', max: 100 }, {});
  assert(mvuBar.mode === 'bar' && mvuBar.current === 80 && mvuBar.max === 100, 'mvu tuple bar');
  const pair = parseBarValue([80, 100], { key: '灵力' }, {});
  assert(pair.current === 80 && pair.max === 100, 'pair bar');
  const slash = parseBarValue('80/120', { key: '灵力', max: 100 }, {});
  assert(slash.current === 80 && slash.max === 120, 'slash wins over field max');
  const obj = parseBarValue({ 当前: 36, 上限: 100 }, { key: '修为' }, {});
  assert(obj.current === 36 && obj.max === 100, 'object bar');
  const keyed = parseBarValue(50, { key: '灵力', max: 100, maxKey: '灵力上限' }, { 灵力上限: [120, '上限说明文字'] });
  assert(keyed.current === 50 && keyed.max === 120, 'maxKey');
  const tags = parseChips(['中毒', '轻伤'], false);
  assert(tags.length === 2 && tags[1] === '轻伤', 'tags not peeled');
  const wrapped = parseChips([['青元剑诀', '风灵步'], '已学功法，不要改说明'], true);
  assert(wrapped.length === 2 && wrapped[0] === '青元剑诀', 'list mvu wrap');

  assert(barDanger({ key: '生命', danger: 'low' }, 20, 100) === true, 'low danger');
  assert(barDanger({ key: '生命', danger: 'low' }, 40, 100) === false, 'not low');
  assert(barDanger({ key: '感染度', invert: true }, 75, 100) === true, 'invert at 75');
  assert(barDanger({ key: '感染度', invert: true }, 74.9, 100) === false, 'invert below 75');
  assert(barDanger({ key: '生命', invert: true }, 10, 100) === false, 'invert does not use the low rule');
  assert(barDanger({ key: '通缉等级', invert: true }, 4, 5) === true, 'invert uses its own max');

  const multi = splitCharacters({
    角色: {
      林动: { 境界: ['筑基', '当前大境界，刚刚突破'], 灵力: '80/120' },
      苏晚晴: { 境界: '金丹' },
    },
  }, '主角');
  assert(multi.length === 2 && multi[0].name === '林动' && multi[0].data.境界[0] === '筑基', '角色 bag');

  const top = splitCharacters({
    林动: { 境界: '筑基', 灵力: 1 },
    苏晚晴: { 境界: '金丹', 灵力: 2 },
  }, '主角');
  assert(top.length === 2 && top[1].name === '苏晚晴', 'top-level chars');

  const grouped = splitCharacters({
    属性: { 境界: '筑基', 灵力: 80 },
    背包: { 功法: ['剑诀'], 灵石: 10 },
  }, '沈青禾');
  assert(grouped.length === 1 && grouped[0].name === '沈青禾', 'groups stay one char');
  assert(grouped[0].data.境界 === '筑基' && grouped[0].data.灵石 === 10, 'flatten groups');

  assert(scoreKeywords('一位筑基修士，身负灵根') === 'xiuxian', 'keyword xiuxian');
  assert(matchWorldviewToken('备注 zns:cyber') === 'cyber', 'zns tag');
  assert(matchTokenList(['世界观:西幻']) === 'xihuan', 'worldview name');
  assert(getPreset('moshi').name === '末日', 'preset');

  const view = buildView({ 境界: '筑基', 隐藏: '密道', 灵石: 0 }, getPreset('xiuxian'), false);
  const labels = view.map((group) => group.label);
  assert(labels.includes('修为') && labels.includes('其他'), 'extra group');
  const extra = view.find((group) => group.label === '其他');
  assert(extra.fields.some((field) => field.field.key === '隐藏'), 'unknown key');
  assert(!view.some((group) => group.fields.some((field) => field.field.key === '心境')), 'missing hidden');

  console.log('zns self-test ok');
}

start();

const isNodeSelfTest = typeof window === 'undefined'
  && typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && process.argv.includes('--zns-self-test');
if (isNodeSelfTest) runSelfTest();
