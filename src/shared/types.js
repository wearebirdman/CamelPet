/**
 * 前后端共享的类型约束与常量。
 * 仅用于文档与 IDE 提示，运行时不做校验；避免各处对配置结构产生隐式假设。
 */

/**
 * @typedef {object} WindowState
 * @property {number} width  窗口宽（px）
 * @property {number} height 窗口高（px）
 * @property {number} x      初始屏幕 X 坐标
 * @property {number} y      初始屏幕 Y 坐标
 * @property {boolean} alwaysOnTop 是否置顶
 * @property {boolean} transparent 是否透明无边框
 */

/**
 * @typedef {object} SkinAsset
 * @property {'svg'|'png'|'frames'|string} [type] 素材类型，决定加载方式
 * @property {string} path 相对皮肤根目录的路径，如 'sprites/idle/000.png'
 * @property {number} [durationMs] 该帧停留时长（ms），覆盖状态级 frameDurationMs
 */

/**
 * @typedef {object} AnimationState
 * @property {boolean} [loop] 是否循环，默认 true
 * @property {SkinAsset[]} assets 帧序列
 * @property {number} [frameDurationMs] 帧间隔（ms），默认 120
 */

/**
 * @typedef {object} SkinManifest
 * @property {string} id 皮肤 id，与目录名一致
 * @property {string} name 展示名
 * @property {number} width 素材单帧宽（px）
 * @property {number} height 素材单帧高（px）
 * @property {number} [baseScale] 统一缩放倍率，默认 1
 * @property {'feet'|'center'} [anchor] 角色在窗口内的对齐方式，默认 feet
 * @property {Record<string, AnimationState>} states 动作状态表
 * @property {string} [defaultState] 默认状态，默认 'idle'
 */

/**
 * @typedef {object} MenuItem
 * @property {string} [id] 渲染层动作 id（对应 manifest.states 的键）
 * @property {string} [label] 菜单文案
 * @property {'separator'|'menu'|'radio'} [type] 特殊类型
 * @property {'quit'|'hide'|'show'|string} [action] 主进程内置动作
 * @property {boolean} [enabled] 置 false 则灰显不可点，默认 true
 * @property {boolean|Function} [checked] radio 项的勾选态，函数形式每次弹菜单实时求值
 * @property {MenuItem[]} [items] 子菜单
 */

/**
 * @typedef {object} SettingOption
 * @property {string|number} value 选项值
 * @property {string} label 选项文案
 */

/**
 * @typedef {object} SettingItem
 * @property {string} id 设置项标识，同时作为 SET_SETTING 的 key
 * @property {string} label 显示名
 * @property {string} [description] 辅助说明
 * @property {'select'|'switch'|'slider'|'textarea'|'switchList'} control 控件类型
 * @property {string} [channel] 专用的 IPC 通道（如 'set-sprite-size'），缺省走 SET_SETTING
 * @property {string} [exclusiveGroup] 互斥组名：同组内最多只能有一项为 true，
 *           打开某项时主进程会把同组其他项自动置 false
 * @property {string} [parentId] 父设置项 id：父项为 true 时本项才显示（用于"开关 + 绑定子控件"）
 * @property {{file: string, key: string}} [source] 配置来源，file 相对 config/，key 支持点号路径
 * @property {*} [default] 文件或键缺失时的回退值
 * @property {SettingOption[]} [options] select / switchList 的候选项
 * @property {number} [min] slider 最小值
 * @property {number} [max] slider 最大值
 * @property {number} [step] slider 步长
 * @property {string} [unit] 数值单位后缀
 * @property {string} [note] 附加提示（如「改动需重启生效」）
 */

/**
 * @typedef {object} SettingsCategory
 * @property {string} id 分类标识
 * @property {string} label 分类显示名
 * @property {'about'} [kind] 特殊分类：内容由 GET_APP_INFO 填充
 * @property {SettingItem[]} items 该分类下的设置项
 */

/**
 * @typedef {object} SettingsSchema
 * @property {SettingsCategory[]} categories 分类列表，左侧导航按此渲染
 */

/**
 * @typedef {object} DialogueConfig
 * @property {number} [bubbleDurationMs] 气泡显示时长（ms）
 * @property {{lines?: string[], states?: string[]}} [click] 单击行为配置
 */

/**
 * 语音包（config/voicepacks.json 的 packs 数组元素）。
 * `file` 永远是 assets/audio/ 下的文件名（不含路径），保证项目整体搬移后仍可用；
 * 原始路径记录在 source 里仅作备查。
 * @typedef {object} VoicePack
 * @property {string} id 稳定唯一标识，同时是音频文件名主体（由名称派生，重名自动加序号）
 * @property {string} name 界面显示名
 * @property {string} file assets/audio/ 下的文件名
 * @property {boolean} [enabled] 是否参与随机播放，默认 true
 * @property {string} [source] 添加时用户选的原始路径（备查）
 * @property {string} [addedAt] ISO 时间戳
 */

/**
 * 渲染层读到的语音包（主进程 decorate 后的形态，比磁盘上的多三个派生字段）。
 * @typedef {object} VoicePackView
 * @property {boolean} exists 音频文件是否还在（丢失的包界面标"文件丢失"且不可试听）
 * @property {string} url 可直接喂给 <audio> 的 file:// URL；文件丢失时为空串
 * @property {number} bytes 文件体积（字节），丢失时为 0
 */

export {};
