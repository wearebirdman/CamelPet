/**
 * 设置窗口渲染层。
 *
 * 完全由 config/settings.json 这份 schema 驱动：
 *   - 左侧导航按 schema.categories 渲染
 *   - 右侧内容按每个 item 的 control 字段分派到对应控件
 *   → 新增设置项只改 settings.json，本文件不用动。
 *
 * schema 里的每一项都有对应的主进程 applier，改动会真实落盘并即时生效；
 * 不再有"只改界面不保存"的占位项（那套机制连同「待实现」角标已在清理中移除）。
 */
import { createDiagnostics } from './diagnostics.js';
import { prepareAudioImport } from './audio-import.js';
import { MAX_AUDIO_SECONDS } from '../shared/constants.js';

const api = globalThis.petAPI;
const diagnostics = createDiagnostics();

/** @type {{categories: Array}|null} */
let schema = null;
/** @type {Record<string, unknown>} */
let values = {};
let activeCategoryId = null;
/** itemId → 同步控件显示的回调（外部改了值时用来刷新 UI） */
const syncers = new Map();
/**
 * 语音包列表的刷新回调。
 * 语音包是"资源"，不走 setValue/applier 那条设置通道，而是由主进程在增删改后广播整份清单；
 * 这里登记渲染回调，收到广播就整体重画（清单很短，重画比做差异更新简单且不会不同步）。
 */
let voicePackRefreshers = [];
/**
 * 带 parentId 的设置项（"开关 + 绑定子控件"）。
 * 每次重渲染内容区时重建，只跟踪当前可见分类里的行。
 * @type {Array<{item: object, row: HTMLElement}>}
 */
let parentedRows = [];

/**
 * 可用皮肤列表 —— schema 里标了 `optionsFrom: 'skins'` 的项用它当选项。
 *
 * 来自主进程（枚举 assets/skins/ 需要读目录，页面读不到），取不到就退化成空列表，
 * 界面显示空提示，不让整页挂掉。
 * @type {Array<{id: string, label: string}>}
 */
let skins = [];

/* ---------------- 启动 ---------------- */

async function bootstrap() {
  const nav = document.getElementById('nav');
  const content = document.getElementById('content');

  if (!api?.getSettings) {
    content.innerHTML = '<p class="panel-hint">未能连接主进程（设置界面需在应用内打开）。</p>';
    return;
  }

  ({ schema, values } = await api.getSettings());
  activeCategoryId = schema.categories[0]?.id ?? null;

  /** 皮肤列表要在首次渲染前拿到（「皮肤」下拉用的是运行期数据源） */
  try {
    const list = await api.getSkins?.();
    skins = Array.isArray(list) ? list : [];
  } catch (error) {
    console.error('[settings] 读取皮肤列表失败：', error);
    skins = [];
  }

  renderNav(nav);
  await renderContent(content);

  // 尺寸可能在别处被改（如右键菜单已移除，但未来其他入口），保持下拉同步
  api.onSpriteSizeChanged?.((size) => {
    values.spriteSize = size;
    syncers.get('spriteSize')?.(size);
  });
  api.onSettingsChanged?.(({ key, value, transient }) => {
    // 预览（transient，拖动滑块时的 PREVIEW_SETTING 广播）只驱动控件跟随，
    // 不进持久值缓存：预览值没落盘，若后续写入被拒，values 里残留的
    // 就是"从没保存过的值"，切分类重画时会拿它冒充已保存配置（审查 L1）
    if (!transient) {
      values[key] = value;
    }
    syncers.get(key)?.(value);
    // 互斥组连带关闭、以及开关型父项变化，都要跟着刷新子控件显隐
    syncChildVisibility();
  });

  // 语音包增删改：主进程广播整份清单，这里整体重画列表
  api.onVoicePacksChanged?.(({ packs }) => {
    for (const refresh of voicePackRefreshers) {
      refresh(packs ?? []);
    }
  });

  /**
   * 皮肤已切换：台词池、语音包、动作目录**全部随皮肤换**，
   * 所以这里要重新拉一遍所有数据源并重画整页（不是只更新一个下拉）。
   */
  api.onSkinChanged?.(async ({ skinId }) => {
    try {
      values.activeSkin = skinId;
      const latest = await api.getSettings?.();
      if (latest?.values) {
        values = latest.values;
      }
      const packs = await api.getVoicePacks?.();
      for (const refresh of voicePackRefreshers) {
        refresh(Array.isArray(packs) ? packs : []);
      }
      const content = document.getElementById('content');
      if (content) {
        await renderContent(content);
      }
    } catch (error) {
      console.error('[settings] 皮肤切换后刷新失败：', error);
    }
  });

  // 调试入口：与桌宠的 window.__pet 对齐，供脚本/截图工具驱动
  window.__settings = {
    get schema() {
      return schema;
    },
    get values() {
      return values;
    },
    /** 展平后的全部设置项（分类可能用 groups 分组，脚本里直接按 id 找更省事） */
    get items() {
      return schema.categories.flatMap((category) => {
        if (category.kind === 'about') return [];
        if (Array.isArray(category.groups)) {
          return category.groups.flatMap((group) => group.items ?? []);
        }
        return category.items ?? [];
      });
    },
    findItem(id) {
      return window.__settings.items.find((item) => item.id === id);
    },
    /** 某个设置项当前是否可见（绑定在开关下的子控件关闭时会隐藏） */
    isItemVisible(id) {
      const row = document.querySelector(`[data-item-id="${id}"]`);
      return row ? !row.hidden : null;
    },
    /** 是否处于"两个都开着"的违规状态（互斥组每组最多一个 true） */
    exclusiveViolations() {
      const groups = new Map();
      for (const item of window.__settings.items) {
        if (!item.exclusiveGroup) continue;
        if (!groups.has(item.exclusiveGroup)) groups.set(item.exclusiveGroup, []);
        groups.get(item.exclusiveGroup).push(item.id);
      }
      const bad = [];
      for (const [name, ids] of groups) {
        const on = ids.filter((id) => values[id] === true);
        if (on.length > 1) bad.push(`${name}: ${on.join(', ')}`);
      }
      return bad;
    },
    selectCategory,
    setValue,
    get activeCategoryId() {
      return activeCategoryId;
    },
    /** 当前渲染出来的语音包行（验证脚本用） */
    voicePackRows() {
      return [...document.querySelectorAll('.voice-pack-row')].map((row) => ({
        id: row.dataset.packId,
        name: row.querySelector('.voice-pack-name')?.textContent ?? '',
        enabled: row.dataset.enabled === 'true',
        missing: row.dataset.missing === 'true',
      }));
    },
    openVoiceDialog,
    closeVoiceDialog,
    /** 直接跑一遍"填写 → 提交"，验证脚本不必真去点 DOM */
    submitVoiceDialog,
  };

  await diagnostics.write({
    stage: 'settings-boot-end',
    categories: schema.categories.length,
    items: schema.categories.reduce((sum, category) => sum + (category.items?.length ?? 0), 0),
  });
}

/* ---------------- 左侧导航 ---------------- */

function renderNav(nav) {
  nav.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'nav-title';
  title.textContent = '设置';
  nav.appendChild(title);

  for (const category of schema.categories) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-item';
    button.textContent = category.label;
    button.dataset.categoryId = category.id;
    button.setAttribute('aria-current', String(category.id === activeCategoryId));
    button.addEventListener('click', () => selectCategory(category.id));
    nav.appendChild(button);
  }
}

function selectCategory(categoryId) {
  const category = schema.categories.find((candidate) => candidate.id === categoryId);
  if (!category) {
    return false;
  }
  activeCategoryId = categoryId;
  for (const button of document.querySelectorAll('.nav-item')) {
    button.setAttribute('aria-current', String(button.dataset.categoryId === categoryId));
  }
  renderContent(document.getElementById('content'));
  return true;
}

/* ---------------- 右侧内容 ---------------- */

/** 每次渲染内容区自增；异步回调靠它判断自己是否已被作废（与 animation.js 同款手法） */
let renderToken = 0;

async function renderContent(content) {
  const myToken = ++renderToken;
  const category = schema.categories.find((candidate) => candidate.id === activeCategoryId);
  content.innerHTML = '';
  parentedRows = []; // 内容区重建，旧的父子关联一并失效
  voicePackRefreshers = []; // 语音包列表也随之重建，旧回调不能再指向已移除的 DOM
  syncers.clear(); // 旧 syncer 闭包攥着已卸载的 DOM 节点，不清会缓慢泄漏（审查 L5）
  if (!category) {
    return;
  }

  const heading = document.createElement('h1');
  heading.className = 'panel-title';
  heading.textContent = category.label;
  content.appendChild(heading);

  if (category.kind === 'about') {
    const hint = document.createElement('p');
    hint.className = 'panel-hint';
    hint.textContent = '版本与运行环境信息';
    content.appendChild(hint);
    const about = await renderAbout();
    if (myToken !== renderToken) {
      return; // 等待期间用户已切走：不能把 about 内容叠进新分类的页面（审查 M1）
    }
    content.appendChild(about);
    return;
  }

  /**
   * 已经没有"待实现"占位项了：气泡样式与动作管理在清理中移除，
   * 不透明度补上了真实实现。这里连提示语一起删掉，避免出现
   * "本页还有 N 项尚未接入"这种自我拆台的文案。
   */
  if (Array.isArray(category.groups)) {
    // 分组分类（行为）：每组渲染一个小标题，下面跟该组的设置项
    for (const group of category.groups) {
      content.appendChild(renderGroupTitle(group.label));
      for (const item of group.items ?? []) {
        content.appendChild(renderItem(item));
      }
    }
  } else {
    for (const item of category.items ?? []) {
      content.appendChild(renderItem(item));
    }
  }

  syncChildVisibility();
}

/** 组内小标题：用于把长分类切成"对话 / 动作 / 语音"这样的段落 */
function renderGroupTitle(label) {
  const title = document.createElement('h2');
  title.className = 'group-title';
  title.textContent = label;
  return title;
}

function renderItem(item) {
  // 列表型控件（一个设置项下挂多个开关 / 语音包列表）改成上下排布：
  // 标题与说明占满整行，内容各自成行，
  // 与页面上其他设置项完全对齐。挤在右侧控制列里会让标签和控件被撑开、配对关系变模糊。
  const stacked = item.control === 'switchList' || item.control === 'voicePacks';

  const row = document.createElement('div');
  row.className = stacked ? 'item item-stacked' : 'item';
  row.dataset.itemId = item.id;

  const main = document.createElement('div');
  main.className = 'item-main';

  const label = document.createElement('div');
  label.className = 'item-label';
  label.append(item.label);
  main.appendChild(label);

  if (item.description) {
    const desc = document.createElement('div');
    desc.className = 'item-desc';
    desc.textContent = item.description;
    main.appendChild(desc);
  }
  if (item.note) {
    const note = document.createElement('div');
    note.className = 'item-note';
    note.textContent = item.note;
    main.appendChild(note);
  }

  const control = document.createElement('div');
  control.className = 'item-control';
  buildControl(item, control);

  row.append(main, control);

  // "开关 + 绑定子控件"：子项是否显示由父项的值决定，注册后由 syncChildVisibility 统一刷新
  if (item.parentId) {
    parentedRows.push({ item, row });
  }

  return row;
}

/**
 * 刷新"开关 + 子控件"的显隐：父开关为真时子控件才显示。
 * 每次值变化（本地改动、主进程广播、互斥连带关闭）后都要调一次。
 */
function syncChildVisibility() {
  for (const { item, row } of parentedRows) {
    row.hidden = !values[item.parentId];
  }
}

/* ---------------- 控件 ---------------- */

function buildControl(item, host) {
  switch (item.control) {
    case 'select':
      return buildSelect(item, host);
    case 'switch':
      return buildSwitch(item, host);
    case 'slider':
      return buildSlider(item, host);
    case 'textarea':
      return buildTextarea(item, host);
    case 'switchList':
      return buildSwitchList(item, host);
    case 'voicePacks':
      return buildVoicePacks(item, host);
    default:
      host.textContent = String(values[item.id] ?? '');
  }
}

function buildSelect(item, host) {
  const select = document.createElement('select');
  /**
   * 选项必须走 resolveOptions，不能直接读 item.options：
   * 「皮肤」「动作管理」这类项的选项是运行期数据源（optionsFrom），schema 里没有 options 数组，
   * 直接读会让下拉框一个选项都没有 —— 点开是一片空白，看上去像"下拉框坏了"。
   */
  const options = resolveOptions(item);
  for (const option of options) {
    const node = document.createElement('option');
    node.value = String(option.value);
    node.textContent = option.label;
    select.appendChild(node);
  }
  select.value = String(values[item.id] ?? item.default);
  // 等提交完成再回写控件 —— live 项要 await 主进程，否则会读到还没更新的旧值
  select.addEventListener('change', async () => {
    const raw = select.value;
    const matched = options.find((option) => String(option.value) === raw);
    await commit(item, matched ? matched.value : raw);
    select.value = String(values[item.id] ?? item.default);
  });
  syncers.set(item.id, (value) => {
    select.value = String(value);
  });
  host.appendChild(select);
}

function buildSwitch(item, host) {
  const wrapper = document.createElement('label');
  wrapper.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(values[item.id]);
  const track = document.createElement('span');
  track.className = 'switch-track';
  wrapper.append(input, track);
  input.addEventListener('change', async () => {
    await commit(item, input.checked);
    input.checked = Boolean(values[item.id]);
  });
  syncers.set(item.id, (value) => {
    input.checked = Boolean(value);
  });
  host.appendChild(wrapper);
}

function buildSlider(item, host) {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(item.min ?? 0);
  input.max = String(item.max ?? 100);
  input.step = String(item.step ?? 1);
  input.value = String(values[item.id] ?? item.default);

  const readout = document.createElement('span');
  readout.className = 'value-text';
  const format = (value) => `${value}${item.unit ?? ''}`;
  readout.textContent = format(input.value);

  input.addEventListener('input', () => {
    readout.textContent = format(input.value);
    /**
     * 标了 preview 的项（音量）在拖动过程中就临时应用一次 —— 只广播、不落盘。
     * 这类设置"拖的时候听不见"就等于没反馈，用户会直接判定功能没作用；
     * 落盘仍然留给下面的 change，避免拖动途中反复写配置文件。
     */
    if (item.preview) {
      api.previewSetting?.(item.id, Number(input.value));
    }
  });
  input.addEventListener('change', async () => {
    await commit(item, Number(input.value));
    input.value = String(values[item.id] ?? item.default);
    readout.textContent = format(input.value);
  });
  syncers.set(item.id, (value) => {
    input.value = String(value);
    readout.textContent = format(value);
  });
  host.append(input, readout);

  /**
   * 音量这类"必须用耳朵确认"的设置，旁边给一个试听入口。
   * 没有它的话，调完音量无从判断是否生效 —— 声音要等下一次触发才会响。
   */
  if (item.sample) {
    const sample = document.createElement('button');
    sample.type = 'button';
    sample.className = 'btn btn-mini';
    sample.textContent = '试听';
    sample.dataset.action = 'sample';
    sample.addEventListener('click', async () => {
      if (values.voiceMuted === true) {
        // 静音时播放器会直接早退，不解释一句就是"点了完全没反应"
        toast('当前是静音状态，先关闭「静音」再试听');
        return;
      }
      const packs = (await api.getVoicePacks?.()) ?? [];
      const playable = packs.filter((pack) => pack.enabled !== false && pack.exists !== false);
      if (playable.length === 0) {
        toast('还没有可播放的语音包');
        return;
      }
      // 随机挑一个，和单击桌宠触发的是同一批声音
      const pick = playable[Math.floor(Math.random() * playable.length)];
      const result = await api.previewVoicePack?.(pick.id);
      if (!result?.ok) {
        toast(result?.message ?? '试听失败');
      }
    });
    host.appendChild(sample);
  }
}

function buildTextarea(item, host) {
  const area = document.createElement('textarea');
  const list = Array.isArray(values[item.id]) ? values[item.id] : [];
  area.value = list.join('\n');
  area.spellcheck = false;
  area.addEventListener('change', () => {
    const lines = area.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    commit(item, lines);
    area.value = (Array.isArray(values[item.id]) ? values[item.id] : []).join('\n');
  });
  syncers.set(item.id, (value) => {
    area.value = (Array.isArray(value) ? value : []).join('\n');
  });
  host.appendChild(area);
}

function resolveOptions(item) {
  /**
   * 选项来自两处：
   *   - schema 里写死的 `options`（编译期枚举，如频率档位）
   *   - 运行期数据源 `optionsFrom: 'skins'`（要枚举 assets/skins/ 目录，页面读不到）
   */
  if (item.optionsFrom === 'skins') {
    // 皮肤列表是 [{ id, label }]，控件统一认 { value, label }
    return skins.map((skin) => ({ value: skin.id, label: skin.label }));
  }
  return item.options ?? [];
}

function buildSwitchList(item, host) {
  const options = resolveOptions(item);
  if (options.length === 0) {
    // 空列表要给出明确提示，否则界面上一片空白，用户会以为是坏了。
    // 具体原因交给左侧的 note 说明，这里只放一句通用占位，避免两处重复同一句话。
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = '暂无可管理的项';
    host.appendChild(empty);
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'switch-list';
  const current = () => (Array.isArray(values[item.id]) ? values[item.id] : []);

  for (const option of options) {
    const row = document.createElement('div');
    row.className = 'switch-list-row';

    const text = document.createElement('span');
    text.textContent = option.label;

    const toggle = document.createElement('label');
    toggle.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = current().includes(option.value);
    const track = document.createElement('span');
    track.className = 'switch-track';
    toggle.append(input, track);

    input.addEventListener('change', () => {
      const set = new Set(current());
      if (input.checked) {
        set.add(option.value);
      } else {
        set.delete(option.value);
      }
      commit(item, options.map((o) => o.value).filter((value) => set.has(value)));
    });

    row.append(text, toggle);
    wrapper.appendChild(row);
  }

  syncers.set(item.id, (value) => {
    const set = new Set(Array.isArray(value) ? value : []);
    const inputs = wrapper.querySelectorAll('input[type="checkbox"]');
    options.forEach((option, index) => {
      if (inputs[index]) {
        inputs[index].checked = set.has(option.value);
      }
    });
  });
  host.appendChild(wrapper);
}

/* ---------------- 语音包管理 ---------------- */

/**
 * 语音包列表控件。
 *
 * 与 switchList 的区别：switchList 的选项来自 schema（编译期固定），
 * 语音包是运行期增删的资源，所以清单必须从主进程实时取，且增删后要能整体重画。
 * 行内除了启用开关，还有试听与删除。
 */
function buildVoicePacks(item, host) {
  const wrapper = document.createElement('div');
  wrapper.className = 'voice-packs';

  const list = document.createElement('div');
  list.className = 'voice-pack-list';

  const actions = document.createElement('div');
  actions.className = 'voice-pack-actions';
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'btn btn-primary';
  addButton.textContent = '添加音频';
  addButton.addEventListener('click', () => openVoiceDialog());
  actions.appendChild(addButton);

  wrapper.append(list, actions);
  host.appendChild(wrapper);

  const refresh = (packs) => renderVoicePackRows(list, packs);
  voicePackRefreshers.push(refresh);

  // 首屏先放空提示，拿到清单再画 —— 避免列表区域在异步返回前是一片空白
  refresh([]);
  (async () => {
    try {
      const packs = await api.getVoicePacks?.();
      refresh(Array.isArray(packs) ? packs : []);
    } catch (error) {
      console.error('[settings] 读取语音包失败：', error);
      refresh([]);
    }
  })();
}

function renderVoicePackRows(list, packs) {
  list.innerHTML = '';

  if (packs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = '还没有语音包，点下方「添加音频」加入一个';
    list.appendChild(empty);
    return;
  }

  for (const pack of packs) {
    const row = document.createElement('div');
    row.className = 'voice-pack-row';
    row.dataset.packId = pack.id;
    row.dataset.enabled = String(pack.enabled !== false);
    row.dataset.missing = String(pack.exists === false);

    const name = document.createElement('span');
    name.className = 'voice-pack-name';
    name.textContent = pack.name;
    name.title = pack.file || '';
    row.appendChild(name);

    if (pack.exists === false) {
      const tag = document.createElement('span');
      tag.className = 'voice-pack-tag';
      tag.textContent = '文件丢失';
      row.appendChild(tag);
    } else {
      const meta = document.createElement('span');
      meta.className = 'voice-pack-meta';
      // 标出这个包是不是导入时做过响度处理 —— 用户能一眼看出素材攒了没有
      meta.textContent = pack.optimized ? `${formatBytes(pack.bytes)} · 已优化` : formatBytes(pack.bytes);
      meta.title = pack.optimized
        ? '导入时做过响度归一化（单声道 32kHz）'
        : '直接复制了原始文件，未做响度处理';
      row.appendChild(meta);
    }

    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'btn btn-mini';
    preview.textContent = '试听';
    preview.dataset.action = 'preview';
    preview.disabled = pack.exists === false;
    preview.addEventListener('click', async () => {
      if (values.voiceMuted === true) {
        toast('当前是静音状态，先关闭「静音」再试听');
        return;
      }
      const result = await api.previewVoicePack?.(pack.id);
      if (!result?.ok) {
        toast(result?.message ?? '试听失败');
      }
    });
    row.appendChild(preview);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-mini btn-danger';
    remove.textContent = '删除';
    remove.dataset.action = 'remove';
    remove.addEventListener('click', async () => {
      // 删除会连带删掉 assets/audio 里的副本（用户原始文件不受影响），先问一句
      if (!window.confirm(`删除语音包「${pack.name}」？\n（只删除应用内的副本，你原来的音频文件还在）`)) {
        return;
      }
      const result = await api.removeVoicePack?.(pack.id);
      if (result?.ok) {
        // 清单更新成功 ≠ 文件删除成功：删不掉时必须说出来，否则就是静默残留
        toast(result.warning ?? `已删除「${pack.name}」`);
      } else {
        toast(result?.message ?? '删除失败');
      }
    });
    row.appendChild(remove);

    const toggle = document.createElement('label');
    toggle.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = pack.enabled !== false;
    input.dataset.action = 'toggle';
    const track = document.createElement('span');
    track.className = 'switch-track';
    toggle.append(input, track);
    input.addEventListener('change', async () => {
      const result = await api.setVoicePackEnabled?.(pack.id, input.checked);
      if (!result?.ok) {
        input.checked = !input.checked; // 落盘失败就把开关拨回去，别让界面撒谎
        toast(result?.message ?? '保存失败');
      }
    });
    row.appendChild(toggle);

    list.appendChild(row);
  }
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return '—';
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(0)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------------- 添加音频对话框 ---------------- */

/** 对话框元素缓存（只在首次打开时查询一次 DOM） */
let dialogNodes = null;

function getDialogNodes() {
  if (dialogNodes) {
    return dialogNodes;
  }
  dialogNodes = {
    mask: document.getElementById('voice-dialog'),
    name: document.getElementById('voice-name'),
    path: document.getElementById('voice-path'),
    browse: document.getElementById('voice-browse'),
    hint: document.getElementById('voice-hint'),
    error: document.getElementById('voice-error'),
    cancel: document.getElementById('voice-cancel'),
    confirm: document.getElementById('voice-confirm'),
  };

  dialogNodes.browse.addEventListener('click', browseForAudio);
  dialogNodes.cancel.addEventListener('click', closeVoiceDialog);
  dialogNodes.confirm.addEventListener('click', submitVoiceDialog);
  // 点遮罩空白处等于取消（点面板内部不关）
  dialogNodes.mask.addEventListener('pointerdown', (event) => {
    if (event.target === dialogNodes.mask) {
      closeVoiceDialog();
    }
  });
  // 回车提交、Esc 取消
  dialogNodes.mask.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeVoiceDialog();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitVoiceDialog();
    }
  });

  return dialogNodes;
}

function openVoiceDialog() {
  const nodes = getDialogNodes();
  nodes.name.value = '';
  nodes.path.value = '';
  // 把限制摆在提交之前 —— 用户挑文件时就能排除整段录音，而不是等到被拒绝才回头改
  if (nodes.hint) {
    nodes.hint.hidden = false;
    nodes.hint.textContent =
      `支持 mp3 / wav / ogg / m4a / aac / flac，时长不超过 ${MAX_AUDIO_SECONDS} 秒；` +
      '导入时会自动统一响度并存为单声道 WAV。';
  }
  setDialogError('');
  nodes.confirm.disabled = false;
  nodes.mask.hidden = false;
  nodes.name.focus();
}

function closeVoiceDialog() {
  const nodes = getDialogNodes();
  nodes.mask.hidden = true;
  setDialogError('');
}

function setDialogError(message) {
  const nodes = getDialogNodes();
  nodes.error.textContent = message || '';
  nodes.error.hidden = !message;
  return false;
}

/** 浏览本地文件；选完顺手把名称填上（用户在多数情况下就是想叫这个名字） */
async function browseForAudio() {
  const nodes = getDialogNodes();
  const picked = await api.pickAudioFile?.();
  if (!picked?.path) {
    return; // 用户取消
  }
  nodes.path.value = picked.path;
  if (!nodes.name.value.trim() && picked.name) {
    nodes.name.value = String(picked.name).slice(0, 24);
  }
  setDialogError('');
  nodes.confirm.focus();
}

/**
 * 提交添加。
 * 校验主要在**主进程**做（格式白名单、体积上限、重名等），这里只挡两个最基本的空值 ——
 * 界面校验只是提前反馈，真正的守门人必须是不受界面影响的那一层。
 */
/** 把处理报告压成一句人话，让用户知道程序对音频做了什么 */
function describeProcessing(report) {
  if (!report) {
    return '';
  }
  const parts = [];
  if (report.gainDb >= 0.5) {
    parts.push(`响了 ${Math.round(report.gainDb * 10) / 10} dB`);
  }
  if (report.gateApplied) {
    parts.push('已压间隙底噪');
  }
  if (report.peakLimit?.applied) {
    parts.push('已修过冲峰值');
  }
  return parts.length > 0 ? `（${parts.join('，')}）` : '（已按标准电平存档）';
}

/**
 * 提交「添加音频」。
 *
 * 顺序上值得注意：**先把音频取回来做响度处理，再把成品交给主进程落盘**。
 * 这样用户之后挪走或删掉原始文件都不影响；处理失败就退回"原样复制"，
 * 不让"优化"变成"加不进来"。
 */
async function submitVoiceDialog() {
  const nodes = getDialogNodes();
  const name = nodes.name.value.trim();
  const source = nodes.path.value.trim();

  if (!name) {
    return setDialogError('请填写语音包名称');
  }
  if (!source) {
    return setDialogError('请选择或填写音频地址');
  }

  const confirmLabel = nodes.confirm.textContent;
  nodes.confirm.disabled = true;
  try {
    nodes.confirm.textContent = '处理中…';
    let optimized = null;
    let hint = '';
    try {
      const read = await api.readAudioFile?.(source);
      if (read?.ok && read.bytes) {
        const processed = await prepareAudioImport(read.bytes);
        optimized = {
          bytes: processed.bytes,
          ext: '.wav',
          // 时长一并回传：主进程据它做守门（成品 WAV 头是另一道，但万一 ext 被改成别的就只剩这一道）
          duration: processed.report?.duration ?? null,
        };
        hint = describeProcessing(processed.report);
      } else if (read && read.ok === false) {
        console.warn('[settings] 读取音频失败，改为原样导入：', read.message);
      }
    } catch (error) {
      /**
       * 时长超限必须**原样抛出**，不能落进下面的"降级为原样导入"分支 ——
       * 那条降级是给"这个编码解不开"准备的，用它放行超长音频等于校验根本没做。
       */
      if (error?.code === 'too-long') {
        return setDialogError(error.message);
      }
      // 解码不了（编码太冷门、文件损坏等）不该阻断导入，退回复制原始文件
      console.warn('[settings] 音频优化失败，改为原样导入：', error);
    }

    const result = await api.addVoicePack?.(name, source, optimized);
    if (result?.ok) {
      closeVoiceDialog();
      toast(`已添加「${result.pack?.name ?? name}」${hint}`);
      return true;
    }
    return setDialogError(result?.message ?? '添加失败');
  } catch (error) {
    console.error('[settings] 添加语音包异常：', error);
    return setDialogError('添加失败，请查看诊断日志');
  } finally {
    nodes.confirm.disabled = false;
    nodes.confirm.textContent = confirmLabel;
  }
}

/* ---------------- 关于页 ---------------- */

async function renderAbout() {
  const info = (await api.getAppInfo?.()) ?? {};
  const rows = [
    ['应用名称', info.name],
    ['版本', info.version],
    ['Electron', info.electron],
    ['Chromium', info.chrome],
    ['Node', info.node],
    ['平台', info.platform],
    ['用户数据目录', info.userDataPath],
    // 用户改的设置/语音包落在哪。打包后它是 userData 下的独立目录（app.asar 只读），
    // 开发态与下面的项目根目录相同 —— 排查"设置改了不生效"时先看这两行
    ['数据目录（可写）', info.dataRoot],
    ['项目根目录', info.rootPath],
  ];

  const fragment = document.createDocumentFragment();
  for (const [key, value] of rows) {
    const row = document.createElement('div');
    row.className = 'about-row';
    const keyNode = document.createElement('div');
    keyNode.className = 'about-key';
    keyNode.textContent = key;
    const valueNode = document.createElement('div');
    valueNode.className = 'about-value';
    valueNode.textContent = value ?? '—';
    row.append(keyNode, valueNode);
    fragment.appendChild(row);
  }
  return fragment;
}

/* ---------------- 写入 ---------------- */

/**
 * 提交一项设置。
 * @param {object} item schema 里的设置项
 * @param {unknown} value 新值
 */
async function setValue(item, value, { silent = false } = {}) {
  const finish = () => {
    syncChildVisibility();
  };

  // 尺寸有专用通道（唯一已打通的"改配置并即时生效"链路）
  if (item.channel === 'set-sprite-size') {
    const ok = await api.setSpriteSize?.(value);
    if (ok) {
      values[item.id] = value;
      finish();
      return { ok: true, value };
    }
    toast('尺寸切换失败');
    finish();
    return { ok: false, reason: 'rejected' };
  }

  const result = await api.setSetting?.(item.id, value);
  if (result?.ok) {
    values[item.id] = result.value ?? value;
    if (result.warning) {
      // 主进程说"写成功了但有隐患"（例如开机项命令行对不上）。这类消息比成功提示重要，直接顶掉。
      toast(`「${item.label}」${result.warning}`);
    }
    finish();
    return result;
  }
  // message 优先：只有 applier 知道具体原因（例如被安全软件拦截），
  // 只显示 reason 的话用户看到的是 "rejected"，等于没说。
  toast(`「${item.label}」保存失败（${result?.message ?? result?.reason ?? 'unknown'}）`);
  finish();
  return result ?? { ok: false, reason: 'unknown' };
}

/** setValue 的薄包装：找到 item 再提交 */
function commit(item, value) {
  return setValue(item, value);
}

/* ---------------- 提示 ---------------- */

let toastTimer = null;
function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.dataset.show = 'false';
  }, 2200);
}

/* ---------------- 装配 ---------------- */

bootstrap().catch((error) => {
  console.error('[settings] 初始化失败：', error);
  diagnostics.write({ stage: 'settings-boot-error', error: String(error) });
  const content = document.getElementById('content');
  if (content) {
    content.innerHTML = '<p class="panel-hint">设置界面初始化失败，请查看诊断日志。</p>';
  }
});
