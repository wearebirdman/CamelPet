/**
 * 渲染层入口。
 * 只做装配与生命周期编排，具体行为都在各自的控制器里：
 *   skin（皮肤/配置加载）→ assets（素材解析）→ animation（帧动画）
 *   → dialogue（气泡）→ interaction（拖拽/点击）→ menu（菜单动作分发）
 *
 * 大中小尺寸切换：主进程落盘并调整窗口后发来 SPRITE_SIZE_CHANGED，
 * 这里重建素材解析器（释放旧 blob）→ 重新布局 → 重播默认状态。
 */
import { loadSkin, fetchConfigJson } from './skin.js';
import { createAssetResolver } from './assets.js';
import { createAnimationController } from './animation.js';
import { createDialogueRenderer } from './dialogue.js';
import { createInteractionController } from './interaction.js';
import { createMenuController } from './menu.js';
import { createIdleScheduler } from './idle-scheduler.js';
import { createAudioPlayer } from './audio.js';
import { createVoiceScheduler } from './voice-scheduler.js';
import { createRandomScheduler } from './random-scheduler.js';
import { createDiagnostics } from './diagnostics.js';
import { listBigActions } from '../shared/action-catalog.js';

/** 项目根目录（src/renderer/main.js → 上溯两级），所有资源与配置都相对它定位 */
const ROOT_URL = new URL('../../', import.meta.url);

async function bootstrap() {
  const diagnostics = createDiagnostics();
  // dataRootUrl 一起记下来：打包后排查"设置改了不生效"时，
  // 第一件事就是看渲染层拿到的是不是那个可写数据根（而不是只读的 app.asar）
  await diagnostics.write({ stage: 'bootstrap-start', dataRootUrl: window.petAPI?.dataRootUrl ?? '' });

  const petElement = document.getElementById('pet');
  const container = document.getElementById('app');

  const { id: skinId, manifest, spriteSize, dialogue: dialogueConfig } = await loadSkin(ROOT_URL);
  // voice/behavior 都是"用户可改配置"：可写数据根优先、包内兜底（开发态两者同一处）
  const voiceConfig = await fetchConfigJson(ROOT_URL, 'config/voice.json');
  const behaviorConfig = await fetchConfigJson(ROOT_URL, 'config/behavior.json');

  let resolver = createAssetResolver(ROOT_URL, skinId, spriteSize, window.devicePixelRatio);

  const animation = createAnimationController({
    element: petElement,
    container,
    manifest,
    resolver,
    spriteSize,
  });
  const dialogue = createDialogueRenderer({
    container,
    petElement,
    durationMs: dialogueConfig.bubbleDurationMs,
  });

  /** 语音播放器：静音/音量来自 config/voice.json，语音包清单来自主进程 */
  const player = createAudioPlayer();
  player.setMuted(voiceConfig.muted);
  player.setVolume(Number.isFinite(Number(voiceConfig.volume)) ? voiceConfig.volume : 70);
  await player.refresh();

  const interaction = createInteractionController({
    animation,
    manifest,
    dialogue,
    onVoiceTrigger: () => player.playRandom(),
    behaviors: {
      ...(dialogueConfig.click ?? {}),
      linesEnabled: dialogueConfig.clickLinesEnabled !== false,
      actionsEnabled: dialogueConfig.clickActionsEnabled !== false,
      voiceEnabled: voiceConfig.clickTriggerEnabled === true,
      // 拖拽阈值来自 config/behavior.json（设置界面「拖拽灵敏度」可改）
      dragThresholdPx: behaviorConfig.dragThresholdPx,
    },
  });
  const menu = createMenuController({ animation, manifest, interaction });
  /**
   * 待机动作插播：待机时随机眨眼等（池 = manifest 里标记 ambient 的状态）。
   * 节奏由 config/behavior.json 的 idleFrequency 决定，设置界面「待机动作频率」可改。
   */
  const idleScheduler = createIdleScheduler({
    animation,
    manifest,
    frequency: behaviorConfig.idleFrequency,
  });
  /** 定时随机语音：分钟级，档位与设置界面「随机语音频率」一致 */
  const voiceScheduler = createVoiceScheduler({
    player,
    enabled: voiceConfig.randomEnabled === true,
    interval: voiceConfig.randomInterval,
  });
  voiceScheduler.schedule();

  /**
   * 台词池：定时随机对话与单击台词共用一份 —— 设置界面「台词管理」编辑的就是它，
   * 改完广播过来时这里同步更新，不用等重启。
   */
  let idleLines = Array.isArray(dialogueConfig.click?.lines) ? dialogueConfig.click.lines : [];

  /**
   * 定时随机对话（idleDialogueEnabled / idleDialogueInterval，设置「对话」分组）：
   * 分钟级从台词池挑一句冒气泡。池子为空时保持节奏但不出声 ——
   * 与 voice-scheduler 没有可播包时的行为一致。
   */
  const idleDialogueScheduler = createRandomScheduler({
    enabled: dialogueConfig.idleDialogueEnabled === true,
    interval: dialogueConfig.idleDialogueInterval,
    onFire: () => {
      if (idleLines.length === 0) {
        return false;
      }
      dialogue.show(idleLines[Math.floor(Math.random() * idleLines.length)]);
      return true;
    },
  });

  /**
   * 定时随机大动作（idleActionEnabled / idleActionInterval，设置「动作」分组）：
   * 待机时偶尔自己来一段庆祝/跳水。动作池 = manifest 的大动作（listBigActions），
   * 让路规则与 idle-scheduler 相同 —— 不在待机状态（正在播别的动作）就跳过本次。
   */
  const bigActionPool = listBigActions(manifest).map((action) => action.value);
  const defaultStateId = manifest.defaultState || 'idle';
  const idleActionScheduler = createRandomScheduler({
    enabled: behaviorConfig.idleActionEnabled === true,
    interval: behaviorConfig.idleActionInterval,
    onFire: () => {
      if (animation.currentState !== defaultStateId) {
        return false; // 正在播其他动作，让路
      }
      if (bigActionPool.length === 0) {
        return false;
      }
      animation.playState(bigActionPool[Math.floor(Math.random() * bigActionPool.length)]);
      return true;
    },
  });

  animation.applyLayout();
  animation.startIdle();
  idleScheduler.schedule();
  idleDialogueScheduler.schedule();
  idleActionScheduler.schedule();

  window.petAPI?.onMenuAction((item) => menu.handleMenuAction(item));

  /** 试听：由主进程转发过来，走的是和随机触发完全相同的播放链路 */
  window.petAPI?.onPlayVoice?.(({ pack }) => player.play(pack));

  /**
   * 皮肤已切换：形象素材 + 台词 + 语音包 + 动作整套换。
   *
   * 做法是**整体重载渲染层**（reload）而不是就地重建：动画、菜单、台词池、
   * 三个调度器都是启动时按 manifest 与配置装配的，逐个重建很容易漏掉某个定时器
   * 或事件监听（残留的旧监听会和新皮肤的对象打架，表现为"点了没反应/播错动作"）。
   * reload 让所有状态随页面一起销毁，干净且零残留；皮肤切换是低频操作，
   * 一次重载的代价远小于热更新带来的不确定性。窗口位置不变（只重载内容）。
   */
  window.petAPI?.onSkinChanged?.(({ skinId: nextSkin }) => {
    if (!nextSkin || nextSkin === skinId) {
      return;
    }
    diagnostics.write({ stage: 'skin-changed', from: skinId, to: nextSkin });
    window.location.reload();
  });

  /** 语音包增删改后刷新可播池 */
  window.petAPI?.onVoicePacksChanged?.(({ packs }) => player.setPacks(packs));

  /**
   * 设置变更广播：设置界面改完某项后主进程会广播出来，这里按 key 即时生效。
   * 新增"即时生效"的设置项时，在此加一个分支即可（主进程侧记得同步登记 applier）。
   */
  window.petAPI?.onSettingsChanged?.(({ key, value }) => {
    if (key === 'bubbleDurationMs') {
      dialogue.setDuration(value);
    } else if (key === 'clickLines') {
      interaction.setLines(value);
      idleLines = Array.isArray(value) ? value : []; // 定时随机对话共用这份台词池
    } else if (key === 'clickLinesEnabled') {
      interaction.setClickEnabled({ lines: value });
    } else if (key === 'clickActionsEnabled') {
      interaction.setClickEnabled({ actions: value });
    } else if (key === 'clickVoiceEnabled') {
      interaction.setClickEnabled({ voice: value });
    } else if (key === 'voiceMuted') {
      player.setMuted(value);
    } else if (key === 'voiceVolume') {
      player.setVolume(value);
    } else if (key === 'voiceRandomEnabled') {
      voiceScheduler.setEnabled(value);
    } else if (key === 'voiceRandomInterval') {
      voiceScheduler.setInterval(value);
    } else if (key === 'dragThresholdPx') {
      interaction.setDragThreshold(value);
    } else if (key === 'idleFrequency') {
      idleScheduler.setFrequency(value);
    } else if (key === 'idleDialogueEnabled') {
      idleDialogueScheduler.setEnabled(value);
    } else if (key === 'idleDialogueInterval') {
      idleDialogueScheduler.setInterval(value);
    } else if (key === 'idleActionEnabled') {
      idleActionScheduler.setEnabled(value);
    } else if (key === 'idleActionInterval') {
      idleActionScheduler.setInterval(value);
    }
    // 窗口置顶 / 开机自启动没有渲染层要同步的东西：
    // 前者由主进程直接调 window.setAlwaysOnTop，后者只影响操作系统登录项。
  });

  /** 尺寸档位变更：换素材 → 重新布局 → 重播（窗口由主进程负责调整） */
  window.petAPI?.onSpriteSizeChanged?.(async (nextSize) => {
    await diagnostics.write({ stage: 'sprite-size-changed', from: animation.spriteSize, to: nextSize });
    const previous = resolver;
    resolver = createAssetResolver(ROOT_URL, skinId, nextSize, window.devicePixelRatio);
    // animation 内部持有 resolver 引用，这里通过替换 manifest 无效，改为直接重设：
    animation.setResolver?.(resolver);
    animation.setSpriteSize(nextSize);
    await previous.dispose();
    animation.startIdle();
  });

  await diagnostics.write({ stage: 'bootstrap-end', skinId, spriteSize, state: animation.currentState });

  // 调试入口（只读触发器）：截图验证/开发新动作时用 __pet.animation.playState('xxx') 定格任意状态
  window.__pet = {
    animation,
    dialogue,
    interaction,
    player,
    voiceScheduler,
    idleScheduler,
    idleDialogueScheduler,
    idleActionScheduler,
    /** 当前皮肤 id 与台词池：换皮肤验证用（skin-check 断言"台词真的跟着换了"） */
    skinId,
    getLines: () => idleLines,
  };
}

bootstrap().catch((error) => {
  console.error('骆驼桌宠启动失败：', error);
  createDiagnostics().write({ stage: 'bootstrap-error', error: String(error) });
});
