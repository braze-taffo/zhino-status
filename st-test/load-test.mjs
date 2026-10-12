/**
 * Real SillyTavern + Tavern Helper load test for zhino-status.
 *
 * Expects:
 *   SillyTavern at http://127.0.0.1:8000
 *   dist/index.js at http://127.0.0.1:8787/index.js (CORS)
 *   Google Chrome at /usr/bin/google-chrome
 *
 * Does not call any LLM and does not send an API key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ST_URL = process.env.ST_URL || 'http://127.0.0.1:8000/';
const OUT_DIR = '/workspace/zhino-status/screens';
const RESULT_PATH = process.env.ZNS_RESULT || '/workspace/zhino-status/st-test/last-run.json';

const ZNS_IMPORT = process.env.ZNS_IMPORT || "import 'http://localhost:8787/index.js'";
const ZHINO_IMPORT = "import 'https://cdn.jsdelivr.net/gh/sillytavner-jpg/zhino-script@v5.2.9/dist/index.js'";

const XIUXIAN_STAT = {
  角色: {
    林动: {
      境界: '筑基中期',
      灵根: '变异风灵根',
      修为: 36,
      修为上限: 100,
      灵力: [82, '战斗消耗后的灵力'],
      灵力上限: 120,
      寿元: 186,
      寿元上限: 400,
      心境: '沉稳',
      功法: ['青元剑诀 · 第三层', '风灵步'],
      法宝: ['青冥剑', '储物戒'],
      灵石: 1280,
      状态: ['轻伤', '灵气充盈'],
    },
    苏晚晴: {
      境界: '金丹初期',
      灵根: '水灵根',
      修为: 71,
      修为上限: 100,
      灵力: '96/140',
      寿元: 240,
      寿元上限: 800,
      心境: '波澜不惊',
      功法: ['玄水诀'],
      法宝: ['霜魄针'],
      灵石: 860,
      状态: ['闭关'],
    },
  },
};

const CYBER_STAT = {
  角色: {
    林朔: {
      HP: 76,
      人性: 22,
      赛博精神病: 68,
      RAM: '6/12',
      义体: ['军用臂 · 左', '视界义眼', '反射神经'],
      欧元币: 18420,
      声望: 35,
      通缉等级: 2,
      状态: ['淋雨', '义眼过热'],
    },
    乔琪: {
      HP: 90,
      人性: 64,
      赛博精神病: 30,
      RAM: '4/8',
      义体: ['皮下甲'],
      欧元币: 4200,
      声望: 18,
      通缉等级: 0,
      状态: ['潜伏'],
    },
  },
};

const STATUS_MESSAGE = [
  '夜色压在旧印刷厂上。',
  '<status>',
  '角色:',
  '  周晚:',
  '    职业: 调查记者',
  '    金钱: 3200',
  '    体力: 64',
  '    精力: 40',
  '    心情: 紧绷',
  '    好感度: 28',
  '    身份: 临江晚报记者',
  '    位置: 旧印刷厂',
  '    状态:',
  '      - 加班',
  '      - 缺觉',
  '</status>',
].join('\n');

function classify(entry) {
  const blob = `${entry.text || ''}\n${entry.stack || ''}\n${entry.url || ''}`;
  if (/localhost:8787|127\.0\.0\.1:8787|\bzns[-.]|ZNS\b|人物状态栏/.test(blob)) return 'zns';
  return 'other';
}

function isErrorEntry(entry) {
  return entry.kind === 'pageerror' || entry.kind === 'requestfailed' || entry.type === 'error';
}

async function shot(page, name) {
  const file = path.join(OUT_DIR, `st-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const logs = [];
  const result = {
    startedAt: new Date().toISOString(),
    stUrl: ST_URL,
    scripts: { zns: ZNS_IMPORT, zhino: ZHINO_IMPORT },
    steps: [],
    checks: {},
    screenshots: [],
    error: null,
  };

  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  await context.addInitScript(() => {
    window.__znsAppReady = false;
    const timer = setInterval(() => {
      const st = window.SillyTavern;
      if (!st || typeof st.getContext !== 'function') return;
      let ctx;
      try {
        ctx = st.getContext();
      } catch {
        return;
      }
      if (!ctx?.eventSource || !ctx?.eventTypes?.APP_READY) return;
      clearInterval(timer);
      ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
        window.__znsAppReady = true;
      });
    }, 25);
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    const loc = msg.location();
    logs.push({
      kind: 'console',
      type: msg.type(),
      text: msg.text(),
      url: loc?.url || '',
      line: loc?.lineNumber ?? null,
    });
  });
  page.on('pageerror', (err) => {
    logs.push({
      kind: 'pageerror',
      type: 'pageerror',
      text: String(err && err.message ? err.message : err),
      stack: err && err.stack ? String(err.stack) : '',
      url: '',
    });
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure();
    logs.push({
      kind: 'requestfailed',
      type: 'requestfailed',
      text: `${failure?.errorText || 'failed'} ${req.method()} ${req.url()}`,
      url: req.url(),
      stack: '',
    });
  });

  try {
    await page.goto(ST_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    result.steps.push('opened');

    await page.waitForFunction(() => {
      const onboarding = document.querySelector('dialog.popup #onboarding_ui_language_select');
      return Boolean(onboarding) || window.__znsAppReady === true;
    }, { timeout: 180000 });

    const hadOnboarding = await page.locator('dialog.popup #onboarding_ui_language_select').count();
    if (hadOnboarding) {
      const dialog = page.locator('dialog.popup').filter({ has: page.locator('#onboarding_ui_language_select') });
      await dialog.locator('textarea.popup-input').fill('Tester');
      await dialog.locator('.popup-button-ok').click();
      await page.waitForFunction(() => !document.querySelector('dialog.popup #onboarding_ui_language_select'), { timeout: 30000 });
      result.steps.push('onboarding-dismissed');
    } else {
      result.steps.push('onboarding-already-done');
    }

    await page.waitForFunction(() => window.__znsAppReady === true && window.TavernHelper, { timeout: 180000 });
    result.steps.push('app-ready');

    const scriptState = await page.evaluate(({ znsImport, zhinoImport }) => {
      window.TavernHelper.replaceScriptTrees([
        {
          type: 'script',
          enabled: true,
          name: 'zns',
          id: 'zns-status-bar',
          content: znsImport,
          info: 'zhino-status load test',
          button: { enabled: false, buttons: [] },
          data: {},
        },
        {
          type: 'script',
          enabled: true,
          name: 'zhino',
          id: 'zhino-script',
          content: zhinoImport,
          info: 'zhino v5.2.9 load test',
          button: { enabled: false, buttons: [] },
          data: {},
        },
      ], { type: 'global' });
      const trees = window.TavernHelper.getScriptTrees({ type: 'global' });
      return trees.map((item) => ({
        type: item.type,
        name: item.name,
        id: item.id,
        enabled: item.enabled,
        content: item.content,
      }));
    }, { znsImport: ZNS_IMPORT, zhinoImport: ZHINO_IMPORT });
    result.checks.scripts = scriptState;
    result.steps.push('scripts-configured');

    await page.waitForFunction(() => {
      const ids = [...document.querySelectorAll('iframe')].map((frame) => frame.id);
      return ids.some((id) => id.includes('zns-status-bar')) && ids.some((id) => id.includes('zhino-script'));
    }, { timeout: 30000 });
    result.steps.push('script-iframes');

    await page.waitForFunction(() => window.ZNS && document.querySelector('#zns-fab') && document.querySelector('#zns-panel'), { timeout: 60000 });
    result.steps.push('zns-mounted');

    const character = await page.evaluate(async () => {
      const names = window.TavernHelper.getCharacterNames();
      if (!names.includes('ZnsTester')) {
        await window.TavernHelper.createCharacter('ZnsTester', {
          description: '人物状态栏加载测试。文本里同时有灵根和义体，避免只靠关键词。',
          personality: '冷静',
          scenario: '测试场景',
          first_messages: ['夜风穿过问剑坪，灵气很稳。'],
          creator_notes: 'st load test',
        });
      }
      const ctx = window.SillyTavern.getContext();
      const idx = ctx.characters.findIndex((item) => item.name === 'ZnsTester');
      if (idx < 0) {
        throw new Error(`ZnsTester missing after create: ${ctx.characters.map((item) => item.name).join(', ')}`);
      }
      await ctx.selectCharacterById(idx);
      return {
        idx,
        avatar: ctx.characters[idx].avatar,
        name: ctx.characters[idx].name,
        chatLength: Array.isArray(ctx.chat) ? ctx.chat.length : 0,
      };
    });
    result.checks.character = character;
    await page.waitForFunction(() => {
      const ctx = window.SillyTavern.getContext();
      return ctx?.name2 === 'ZnsTester' && Array.isArray(ctx.chat) && ctx.chat.length > 0;
    }, { timeout: 30000 });
    result.steps.push('character-chat');

    let zhinoFab = false;
    try {
      await page.waitForFunction(() => document.querySelector('.zhino-fab'), { timeout: 90000 });
      zhinoFab = true;
      result.steps.push('zhino-fab');
    } catch {
      result.steps.push('zhino-fab-missing');
    }

    const fabLayout = await page.evaluate(() => {
      const zns = document.querySelector('#zns-fab');
      const zhino = document.querySelector('.zhino-fab');
      const rect = (el) => {
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, className: el.className, id: el.id };
      };
      const before = { zns: rect(zns), zhino: rect(zhino) };
      let overlap = null;
      if (before.zns && before.zhino) {
        const a = before.zns;
        const b = before.zhino;
        const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        overlap = { area: ix * iy, separated: ix * iy === 0 };
        if (ix * iy > 0) {
          zns.style.top = `${Math.max(8, b.y - a.height - 16)}px`;
          zns.style.left = `${b.x}px`;
          zns.style.right = 'auto';
          zns.style.bottom = 'auto';
        }
      }
      return {
        before,
        after: { zns: rect(zns), zhino: rect(zhino) },
        overlap,
        znsRootClass: document.querySelector('#zns-root')?.className || '',
        zhinoRoot: Boolean(document.querySelector('.zhino-root')),
        iframeIds: [...document.querySelectorAll('iframe')].map((frame) => frame.id).filter(Boolean),
      };
    });
    result.checks.fabLayout = fabLayout;
    result.checks.zhinoFab = zhinoFab;

    async function hideToasts() {
      return page.evaluate(() => {
        const texts = [...document.querySelectorAll('#toast-container .toast, .toast')].map((node) => node.innerText.trim()).filter(Boolean);
        document.getElementById('toast-container')?.remove();
        return texts;
      });
    }

    async function readPanel() {
      return page.evaluate(async () => {
        if (window.ZNS?.refresh) await window.ZNS.refresh();
        const panel = document.querySelector('#zns-panel');
        if (panel && !panel.classList.contains('is-open')) {
          document.querySelector('#zns-fab')?.click();
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const body = document.querySelector('#zns-body');
        return {
          open: Boolean(panel?.classList.contains('is-open')),
          hidden: panel ? panel.hidden : null,
          source: document.querySelector('.zns-source')?.textContent || '',
          title: document.querySelector('.zns-title')?.textContent || '',
          worldview: document.querySelector('#zns-worldview')?.value || '',
          tabs: [...document.querySelectorAll('#zns-tabs .zns-tab')].map((node) => node.textContent),
          text: body?.innerText || '',
          zhinoFab: Boolean(document.querySelector('.zhino-fab')),
          znsFab: Boolean(document.querySelector('#zns-fab')),
        };
      });
    }

    async function scenario(name, apply) {
      const applied = await page.evaluate(apply);
      const panel = await readPanel();
      const toasts = await hideToasts();
      const file = await shot(page, name);
      result.screenshots.push(file);
      result.checks[name] = { applied, panel, toasts };
      result.steps.push(`shot-${name}`);
      return panel;
    }

    await scenario('xiuxian', async () => {
      const helper = window.TavernHelper;
      const stat = {
        角色: {
          林动: {
            境界: '筑基中期',
            灵根: '变异风灵根',
            修为: 36,
            修为上限: 100,
            灵力: [82, '战斗消耗后的灵力'],
            灵力上限: 120,
            寿元: 186,
            寿元上限: 400,
            心境: '沉稳',
            功法: ['青元剑诀 · 第三层', '风灵步'],
            法宝: ['青冥剑', '储物戒'],
            灵石: 1280,
            状态: ['轻伤', '灵气充盈'],
          },
          苏晚晴: {
            境界: '金丹初期',
            灵根: '水灵根',
            修为: 71,
            修为上限: 100,
            灵力: '96/140',
            寿元: 240,
            寿元上限: 800,
            心境: '波澜不惊',
            功法: ['玄水诀'],
            法宝: ['霜魄针'],
            灵石: 860,
            状态: ['闭关'],
          },
        },
      };
      try {
        helper.replaceVariables({}, { type: 'message', message_id: 'latest' });
      } catch (error) {
        /* no message yet */
      }
      helper.replaceVariables({ zns_worldview: 'xiuxian', stat_data: stat }, { type: 'chat' });
      const chat = helper.getVariables({ type: 'chat' });
      return { worldview: chat.zns_worldview, statKeys: Object.keys(chat.stat_data?.角色 || {}) };
    });

    await scenario('cyber', async () => {
      const helper = window.TavernHelper;
      const stat = {
        角色: {
          林朔: {
            HP: 76,
            人性: 22,
            赛博精神病: 68,
            RAM: '6/12',
            义体: ['军用臂 · 左', '视界义眼', '反射神经'],
            欧元币: 18420,
            声望: 35,
            通缉等级: 2,
            状态: ['淋雨', '义眼过热'],
          },
          乔琪: {
            HP: 90,
            人性: 64,
            赛博精神病: 30,
            RAM: '4/8',
            义体: ['皮下甲'],
            欧元币: 4200,
            声望: 18,
            通缉等级: 0,
            状态: ['潜伏'],
          },
        },
      };
      helper.replaceVariables({ zns_worldview: 'cyber' }, { type: 'chat' });
      await helper.createChatMessages([
        { role: 'user', message: '把义体状态报一下。' },
        { role: 'assistant', message: '雨还在下。', data: { stat_data: stat } },
      ], { refresh: 'affected' });
      const message = helper.getVariables({ type: 'message', message_id: 'latest' });
      const chat = helper.getVariables({ type: 'chat' });
      return {
        worldview: chat.zns_worldview,
        chatHasStat: Boolean(chat.stat_data),
        messageKeys: Object.keys(message.stat_data?.角色 || {}),
      };
    });

    await scenario('status', async () => {
      const helper = window.TavernHelper;
      const statusMessage = [
        '夜色压在旧印刷厂上。',
        '<status>',
        '角色:',
        '  周晚:',
        '    职业: 调查记者',
        '    金钱: 3200',
        '    体力: 64',
        '    精力: 40',
        '    心情: 紧绷',
        '    好感度: 28',
        '    身份: 临江晚报记者',
        '    位置: 旧印刷厂',
        '    状态:',
        '      - 加班',
        '      - 缺觉',
        '</status>',
      ].join('\n');
      helper.replaceVariables({ zns_worldview: 'dushi' }, { type: 'chat' });
      await helper.createChatMessages([
        { role: 'user', message: '换一条不含变量的状态。' },
        { role: 'assistant', message: statusMessage },
      ], { refresh: 'affected' });
      const message = helper.getVariables({ type: 'message', message_id: 'latest' });
      const chat = helper.getVariables({ type: 'chat' });
      const latest = helper.getChatMessages(-1)[0];
      return {
        worldview: chat.zns_worldview,
        chatHasStat: Boolean(chat.stat_data),
        messageHasStat: Boolean(message.stat_data),
        hasStatusTag: Boolean(latest && String(latest.message || '').includes('<status>')),
      };
    });

    const panelOk = (panel, { title, bits, source }) => {
      const text = `${panel.title}\n${(panel.tabs || []).join('\n')}\n${panel.text || ''}`;
      return panel.open === true
        && panel.title === title
        && bits.every((bit) => text.includes(bit))
        && source.test(panel.source || '');
    };
    result.checks.passed = {
      xiuxian: panelOk(result.checks.xiuxian.panel, {
        title: '修仙',
        bits: ['林动', '苏晚晴', '筑基中期', '青元剑诀'],
        source: /聊天变量/,
      }),
      cyber: panelOk(result.checks.cyber.panel, {
        title: '赛博朋克',
        bits: ['林朔', '乔琪', '义眼过热'],
        source: /消息变量/,
      }),
      status: panelOk(result.checks.status.panel, {
        title: '都市',
        bits: ['周晚', '调查记者', '缺觉'],
        source: /正文/,
      }),
      znsMounted: true,
      zhinoFab,
      fabsSeparated: fabLayout?.overlap?.separated === true,
      bothEnabled: scriptState.every((item) => item.enabled) && scriptState.length === 2,
    };
  } catch (error) {
    result.error = { message: String(error && error.message ? error.message : error), stack: error && error.stack ? String(error.stack) : '' };
    try {
      const file = await shot(page, 'failure');
      result.screenshots.push(file);
    } catch {
      /* screenshot itself failed */
    }
    try {
      result.checks.dom = await page.evaluate(() => ({
        ready: window.__znsAppReady === true,
        tavernHelper: Boolean(window.TavernHelper),
        zns: Boolean(window.ZNS),
        title: document.title,
        dialog: [...document.querySelectorAll('dialog')].map((node) => node.innerText.slice(0, 400)),
        iframes: [...document.querySelectorAll('iframe')].map((frame) => frame.id),
      }));
    } catch {
      /* page may be gone */
    }
  } finally {
    const errors = logs.filter(isErrorEntry).map((entry) => ({ ...entry, bucket: classify(entry) }));
    const warnings = logs
      .filter((entry) => entry.type === 'warning')
      .map((entry) => ({ ...entry, bucket: classify(entry) }));
    result.console = {
      errorCount: errors.length,
      znsErrors: errors.filter((entry) => entry.bucket === 'zns'),
      otherErrors: errors.filter((entry) => entry.bucket === 'other'),
      warningCount: warnings.length,
      warnings: warnings.slice(0, 40),
    };
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
    await browser.close();
  }

  if (result.error) {
    console.error(result.error.message);
    process.exitCode = 1;
  }
  console.log(JSON.stringify({
    steps: result.steps,
    passed: result.checks.passed || null,
    error: result.error && result.error.message,
    znsErrors: (result.console.znsErrors || []).length,
    otherErrors: (result.console.otherErrors || []).length,
    screenshots: result.screenshots,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
