# 骆驼桌宠 CamelPet

一个 Windows 桌面宠物：像素风形象常驻桌面，会待机呼吸、眨眼、做大动作、说话，
可以拖动、点击互动，也能换皮肤和语音包。

用 Electron 写的，配置驱动——加动作、加菜单项、加设置项都尽量只改配置和素材，不写代码。

> 仓库中的图片与音频不属于代码的 MIT 许可范围，且部分素材来源于第三方形象或 AI 生成内容。
> 在取得授权前，不应公开分发这些素材；公开发布前请替换为原创或已获授权素材（见下方「素材与版权」）。

> **接手开发 / 换 AI 代理**：先读 [docs/HANDOVER.md](docs/HANDOVER.md) ——
> 里面记录了架构、构建发布流程、以及八个"不要再踩"的历史坑（沙箱崩溃、完整性降权、透明窗口合成等）。

---

## 功能

| 分类 | 内容 |
| --- | --- |
| 显示 | 透明无边框窗口、像素帧动画、三档尺寸（128 / 192 / 256）、多 DPI、不透明度 |
| 待机 | 30 帧循环（重心摆动 + 呼吸下沉），随机插播眨眼 |
| 大动作 | 庆祝 / 跳水，可按需增删（manifest 里加状态块即可） |
| 交互 | 拖拽（绝对式定位，跟手不漂）、单击触发动作或台词、右键菜单 |
| 语音 | 语音包清单 + 自定义音频导入（离线响度处理、30 秒上限）、音量与静音 |
| 设置 | 开机自启动、窗口置顶、拖拽灵敏度、自动停靠、不透明度、语音包管理 |
| 其他 | 定时随机台词/动作、对话气泡、托盘图标、单实例（重复启动会唤起已有实例） |

**自动停靠**：可以把桌宠拖到屏幕边沿甚至拖出屏幕，松手/切尺寸/开机时会自动拉回可见范围
（允许挂在边沿外，露出不足 1/3 才拉回）。

---

## 快速开始

**方式一：安装包（推荐）**

到 [Releases](../../releases) 下载：

| 文件 | 说明 |
| --- | --- |
| `CamelPet-x.y.z-x64-setup.exe` | 安装版：向导式安装到用户目录，带桌面/开始菜单快捷方式与卸载器 |
| `CamelPet-x.y.z-x64-portable.exe` | 便携版：单文件，双击即用，不写注册表不装服务 |
| `CamelPet-x.y.z-win-x64.zip` | 绿色版：解压后双击 `CamelPet.exe`，最省心的兜底形态 |

**方式二：源码运行（想改代码/换素材）**

```bash
npm install      # 只有一个运行依赖：electron
npm start        # 或 Windows 下双击 run.cmd
```

要求：Windows 10/11，Node 18+。

### 关于启动器

安装版 / 便携版 / 绿色版里的 `CamelPet.exe` 都是**自检启动器**，不是 Electron 本体
（本体是旁边的 `CamelPetCore.exe`）。它做两件事：

1. **先按标准方式启动**；只有检测到 Chromium 沙箱初始化失败（退出码 `0x80000003`）时，
   才自动加 `--no-sandbox` 重试。正常电脑上行为与未加启动器时完全一致。
2. **选一个能写的数据目录**：优先 `%APPDATA%\CamelPet`；写不了（受限令牌/便携模式）时
   退回程序目录下的 `data\`。整个过程记在 `launcher.log`。

为什么需要：某些被安全策略托管的 Windows（例如装有 `CodexSandboxUsers` 这类沙箱服务）里，
Chromium 的沙箱初始化会被拒绝，进程在 `main.js` 执行之前就崩溃，表现为"双击完全没反应"。
这个参数只能从命令行传，在 JS 里 `appendSwitch('no-sandbox')` 太晚、无效。

---

## 数据位置

- 普通安装：`%APPDATA%\CamelPet\data\`
- 便携/受限：程序目录下的 `data\`

设置、台词、语音包都在里面，卸载重装不丢（卸载时不会删除）。设置「关于」页能看到实际路径。

**已知限制**：本程序没有代码签名，Windows 可能提示"无法验证发布者"。
点"更多信息 → 仍要运行"即可；要彻底消除需要购买代码签名证书（OV/EV）。

---

## 打包发布

```bash
npm run pack     # 只出解包目录 dist/win-unpacked/（快速实机验证用，最快）
npm run dist     # 出 NSIS 安装包 + 便携版 exe（产物在 dist/）
```

两者都会先编译启动器（`tools/build-launcher.cjs`，用系统自带 .NET Framework 的 `csc.exe`），
再在打包后把入口换成启动器（`tools/after-pack.cjs`）。

配置在 `electron-builder.yml`。要点：

- 素材与源码按白名单进包（`files`），`tools/ raw/ temp/` 不进
- 示例皮肤 `sample-camel` 不进安装包，仓库里也只保留它的台词/语音数据（精灵帧已删除），
  仅用于回归测试"皮肤自带数据如何播种"这条链路
- 应用图标 `assets/icons/app-icon.ico` 含 16–256 七档（`tools/append-ico-entry.py` 负责补尺寸档）
- 没有配置 `publish`：产物在本地产出，由你手动上传到 GitHub Releases

发布前自查：产物能装、能跑、设置能存（重开设置页不弹回）、语音包能导入并试听。

---

## 开发命令

回归测试都是"跑完即退"的短命令（不会留后台进程）：

```bash
npm run smoke              # 冒烟：启动窗口、无渲染层/主进程错误（约 8 秒）
npm run dock-check         # 自动停靠：边界、漂移、左右对称
npm run drag-check         # 拖拽：全程跟手、无死区、坏坐标防呆
npm run scheduler-check    # 定时随机台词/动作
npm run menu-actions-check # 右键菜单动作段
npm run voicepack-test     # 语音包：导入/删除/播放/上限
npm run settings-shot      # 设置界面全量断言
npm run skin-check         # 换肤端到端（形象+台词+语音+动作+设置读值）
npm run userdata-check     # 打包态"可写数据与包分离"链路（不启 Electron，纯 Node）
npm run capture            # 抓屏出图，人工看效果
npm run launcher           # 只重新编译启动器
```

素材管线（换形象、加动作走这里，都是 Python 脚本）：

```bash
python tools/make_action_pack.py raw/source_videos/跳水.mp4 dive --label 跳水 --cutout ai --write-manifest
python tools/make_idle_pack.py raw/idle_new/000.png --foot-y 256 --eyes "92,27,111,39" "134,27,153,39"
python tools/finalize_sprite_tiers.py dive --palette-from temp/_audit_probes/palette_dive.png --rederive
python tools/check_edge_fringe.py assets/skins/default/sprites/dive/256/1 --depth 3   # 白边体检，返回 0 才算干净
```

Python 依赖：`pillow numpy imageio-ffmpeg`（可选：`rembg onnxruntime opencv-python-headless`，
AI 抠图路线用）。

---

## 目录结构

```
assets/           皮肤帧、音频与应用图标
config/           默认配置与设置 schema
docs/             发布说明（打进绿色版 zip 的那份 README）
launcher/         启动器源码（C#，编译产物是根目录的 CamelPet.exe）
src/main/         Electron 主进程：窗口、IPC、菜单、托盘、设置与数据服务
src/renderer/     渲染层：帧动画、交互、气泡、设置界面与音频播放
src/shared/       主进程与渲染层共用定义
tools/            素材管线与自动化验证脚本
dist/             构建产物：安装包、便携版、绿色版 zip、解包目录（已忽略）
```

---

## 换皮肤 / 自制素材

皮肤 = 一个 manifest + 一组 PNG，放 `assets/skins/<skinId>/` 即可，代码零改动：

- 素材路径：`sprites/<动作>/<尺寸>/<dpr>/NNN.png`，尺寸档位 128 / 192 / 256，dpr 1 / 1.5
- 帧序：`000.png` 起连续编号
- 画布：在 `manifest.json` 的 `states.<id>.canvas` 里写 `{width, height}`，
  渲染层按它算元素高度；**脚底位置必须与待机一致**，否则切动作会上下跳
- 新增大动作：manifest 里加一个 `states.<id>`（`label` + `loop` + `frameDurationMs`）
  并放好素材目录，右键菜单「动作」段、单击动作池会自动出现
- 不想让它出现在「皮肤」下拉里：给 manifest 加 `"hidden": true`（回归测试用的 sample-camel 就是这么做的）

素材生成工具位于 `tools/`，包括视频抽帧、动作素材生成、像素清理与尺寸档位收尾脚本；
处理源视频或生成中间帧需要安装上文列出的 Python 依赖。

---

## 素材与版权

- **代码**：MIT（见 LICENSE）。
- **素材**：`assets/` 下的图片与音频**不在 MIT 授权范围内**。部分素材来源于第三方形象或 AI 生成视频；本仓库不授予这些素材的任何分发许可。仅标注为「演示用途」不等于获得授权。公开仓库或安装包前，请先替换为原创或已获授权素材。

---

## 许可证

MIT（仅适用于代码；图片与音频素材的授权范围见上方「素材与版权」）。
