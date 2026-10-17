# 交接文档 / 工程日志

> 面向接手这个项目的 AI 代理或开发者。目标：读完这一篇能直接开工，不必重新踩一遍已经踩过的坑。
> 最后更新：2026-10-17（v1.0.0 发布当天）

---

## 0. 30 秒速览

- **是什么**：Windows 桌面宠物（Electron + 纯 JS，无框架、无打包器、无运行时依赖）。
- **版本**：`1.0.0`；`productName = CamelPet`；`appId = com.camelpet.desktop`。
- **入口**：发行版里 `CamelPet.exe` 是 **C# 自检启动器**，真正的 Electron 主程序是 `CamelPetCore.exe`。
- **数据**：`%APPDATA%\CamelPet\data`（纯英文路径）；旧版中文目录会在首次启动时自动迁移。
- **规矩**：面向系统的路径一律英文；面向用户的文案一律中文。
- **不能碰的三条红线**（详见第 6 节）：不要恢复 `disableHardwareAcceleration()`；不要从 asar 里读图标；不要让设置项没有 applier。

---

## 1. 当前状态

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/wearebirdman/CamelPet |
| 分支 | `main`（历史是从 v1.0.0 重新开始的根提交 + 后续提交） |
| Tag / Release | `v1.0.0`，附件三个：setup / portable / zip |
| 工作区 | 干净；`node_modules`、`dist`、`temp`、`data`、`exports`、`raw` 均被 `.gitignore` 忽略 |
| 平台 | 仅 Windows 10/11 x64 |

发布前必须全绿的四条命令（见第 8 节）：`npm run smoke`、`npm run userdata-check`、`npm run voicepack-test`、`npm run dist`。

---

## 2. 环境与前置

- Windows 10/11 x64；Node 18+（开发/构建用，运行时不需要）。
- 原生依赖只有 `electron` 与 `electron-builder`（devDependencies）。
- 编译启动器需要 .NET Framework 的 `csc.exe`（Windows 自带，路径 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`）。
- 没有 CI、没有 ESLint/Prettier；格式靠 `.editorconfig` + `.gitattributes`（LF；`.cmd/.ps1` 强制 CRLF）。

---

## 3. 五分钟跑起来

```bash
npm install
npm start          # 开发态；已内置 --no-sandbox --user-data-dir=temp/userdata
npm run smoke      # 8 秒冒烟：窗口 + 渲染层引导 + 主进程无错误
```

构建与发行：

```bash
npm run pack       # 只出 dist/win-unpacked（含启动器替换），最快
npm run dist       # NSIS 安装包 + 便携版 exe
npm run launcher   # 只重编启动器（根目录 CamelPet.exe）
```

产物：

- `dist/CamelPet-<ver>-x64-setup.exe`（NSIS，装到 `%LOCALAPPDATA%\Programs\CamelPet`）
- `dist/CamelPet-<ver>-x64-portable.exe`（单文件便携）
- `dist/CamelPet-<ver>-win-x64.zip`（绿色版；**手动产出**：把 `dist/win-unpacked` 压平 + 放入 `README.txt`）

---

## 4. 目录结构与职责

```
assets/            皮肤帧（sprites）、音频、图标（icons 会被 asarUnpack）
config/            出厂配置 + 设置界面 schema（只读，随包发布）
docs/              本文件、发布说明（release-readme.txt → 打进 zip 的 README.txt）
launcher/          启动器 C# 源码（编译产物是仓库根的 CamelPet.exe）
src/main/          Electron 主进程
src/renderer/      渲染层（原生 DOM，无框架）
src/shared/        两侧共用：IPC 通道名、常量、动作目录、JSDoc 类型
tools/             素材管线（Python）+ 自动化验证脚本（Node/Electron）
dist/ release/     构建产物（忽略）
```

主进程模块一句话职责：

| 文件 | 职责 |
|---|---|
| `index.js` | 唯一装配入口：环境体检、数据根、单实例、窗口、托盘、菜单、IPC、设置服务 |
| `config.js` | 路径体系（包根 vs 数据根）、配置读写、皮肤枚举、出厂数据播种 |
| `window.js` | 桌宠窗口创建/尺寸换算/停靠辅助 |
| `dock.js` | 自动停靠（拖出屏幕后拉回） |
| `tray.js` | 托盘图标与菜单 |
| `menu.js` / `menu-dynamic.js` | 右键菜单（静态部分来自 `config/menu.json`，动作/语音段现算） |
| `ipc.js` | 所有 `ipcMain` 处理器 |
| `preload.cjs` | `window.petAPI` 桥（contextIsolation 开启） |
| `settings.js` | 设置项的校验、互斥组、applier 表 |
| `settings-window.js` | 设置窗口 |
| `voicepacks.js` | 语音包清单/导入/删除/URL、按皮肤解析目录 |
| `auto-launch.js` | 开机自启（注册表 + 启动文件夹兜底，带回读校验） |
| `logger.js` | `main.log` 落盘（`logError(stage, detail)`） |

渲染层：`main.js` 装配动画/交互/调度器；`animation.js` 帧动画；`interaction.js` 拖拽与单击；`audio.js` 播放器；`settings.js` 设置界面（schema 驱动）；`skin.js`/`assets.js` 素材解析。

---

## 5. 架构与数据流

### 5.1 启动链路（发行版）

```
用户双击 CamelPet.exe（C# 启动器）
  ├─ 打印完整性 RID 到 launcher.log（4096=Low / 8192=Medium）
  ├─ 选数据目录：%APPDATA%\CamelPet 可写就用默认；否则 --user-data-dir=<程序目录>\data
  ├─ 标准启动 CamelPetCore.exe
  │    └─ 3.5 秒内以 0x80000003 退出？→ 加 --no-sandbox 重试
  └─ 启动成功后 WaitForExit（便携版外壳依赖这个行为，别改回立即返回）
```

启动器由 `tools/build-launcher.cjs` 编译，打包时 `tools/after-pack.cjs` 把
`CamelPet.exe`（Electron）改名为 `CamelPetCore.exe`，再把启动器复制成 `CamelPet.exe`。
所以安装包快捷方式、便携版、解压即用的 zip 走的都是同一个入口。

### 5.2 配置系统：两个根

- **包根 `ROOT_DIR`**：`src/main/config.js` 上溯两级。打包后在 `app.asar` 内，**只读**。
- **数据根 `DATA_ROOT`**：开发态等于包根；打包态是 `<userData>\data`（`setupDataRoot()`）。
- 读配置：先数据根、再包内（`loadConfig`）；`settings.json`/`menu.json` 只读包内。
- 首次运行会把包内可写数据**播种**到数据根（`seedUserData()`，只补缺不覆盖）。
- 皮肤自带数据（`dialogue.json`/`voicepacks.json`/`audio/`）也按皮肤目录播种；枚举用 `readSkinManifests()`（**不要用 `listSkins()`**，后者会过滤 `hidden`）。

### 5.3 皮肤与动作

- 皮肤 = `assets/skins/<id>/manifest.json` + `sprites/<动作>/<尺寸>/<dpr>/NNN.png`。
- 尺寸 128/192/256，dpr 1 / 1.5；画布与脚底锚点在 manifest 里。
- 当前只有一套正式皮肤 `default`（自律骆驼 · 葡萄牙 7 号），动作 `idle` / `blink` / `cheer` / `dive`。
- `sample-camel` 是**测试样本**（无精灵帧，`hidden: true`），只用于回归"皮肤自带数据播种"。

### 5.4 设置界面

- 完全由 `config/settings.json` 驱动：左侧分类、右侧按 `control` 分派控件。
- 每个 `item.id` 必须在 `src/main/index.js` 的 applier 表里有同名函数，否则写入返回 `no-applier`。
- 互斥组（`exclusiveGroup`）由主进程一次性把兄弟项关掉。
- 目前**没有**"占位/未实现"的设置项，也不该再加回来。

### 5.5 语音包

- 清单在 `config/voicepacks.json`（数据根优先），音频落在 `assets/audio`（皮肤可自带）。
- `decorate()` 生成 `url`（`file://`）与 `exists`；文件丢失时界面上标"文件已丢失"。
- 播放固定在桌宠窗口的同一个 `<audio>` 元素上，避免叠音与句柄泄漏。

---

## 6. 红线与历史坑（**最重要**）

### 6.1 不要重新启用 `app.disableHardwareAcceleration()`

- 症状：进程在、窗口 `IsWindowVisible=true`、`capturePage` 能抓到骆驼，但**屏幕上什么都没有**。
- 根因：关掉 GPU 后，`transparent: true` 的窗口不参与桌面合成（2026-10-17 实测）。
- 规则：默认保留硬件加速；真要关，用环境变量 `CAMEL_PET_DISABLE_GPU=1`。

### 6.2 Chromium 沙箱崩溃（退出码 `0x80000003`）

- 症状：双击完全没反应、没有 `main.log`；崩溃早于 `main.js` 第一行。
- 根因：受限环境里 Chromium 建不出沙箱 IPC（`platform_channel.cc Check failed: 拒绝访问`）。
- 规则：**只能在命令行**传 `--no-sandbox`；在 JS 里 `appendSwitch` 太晚、无效。这件事由启动器负责。

### 6.3 Low 完整性会同时杀死托盘、开机自启和 `%APPDATA%`

- 症状：托盘没有图标、`reg add` 报"拒绝访问"、数据被迫落到程序目录 `data\`。
- 根因：**目录带 `Low Mandatory Level` 标签**时，从该目录启动的进程也会被降权（即使父进程是 Medium 的 explorer）。
- 判断：`launcher.log` 里 `RID=4096` 就是 Low；`main.log` 的 `[env] integrity=Low runKeyWritable=false` 同样说明。
- 处理：`icacls "<项目目录>" /setintegritylevel Medium /T`，然后重启应用。（2026-10-17 就是这么修的。）

### 6.4 图标必须从 `app.asar.unpacked` 读

- `nativeImage.createFromPath()` / `BrowserWindow.icon` **不走** Electron 的 asar 重定向，传 `app.asar/...` 会得到空图（托盘"创建了但看不见"）。
- 规则：图标路径统一走 `resolveReadable('assets','icons',...)`。

### 6.5 asar 里不能用 `fs.copyFileSync`

- 打包态播种会报 `ENOENT: config\config\xxx.json not found in app.asar`。
- 规则：`copyMissing()` 里已对 `ENOENT` 回退为「读出来再写」，别删掉这段。

### 6.6 单实例锁失败时不能静默退出

- 旧实现 `if (!gotTheLock) app.quit()` 完全没有日志，用户只看到"双击没反应"。
- 现在：写 `[single-instance]` 日志；`second-instance` 事件用 `ensureWindow()`（窗口被销毁时重建）而不是 `getWindow()`。

### 6.7 皮肤下拉必须是运行期选项

- `buildSelect()` 必须走 `resolveOptions(item)`；直接读 `item.options` 会让"皮肤"下拉一个选项都没有。
- 皮肤列表来自主进程 `listSkins()`，标签取 manifest 的 `name`。

### 6.8 桌面快捷方式/卸载项的显示名要中文，路径要英文

- 用户数据、安装目录、包内文件名、zip 内路径：全英文。
- 窗口标题、托盘提示、设置标题、快捷方式名、卸载项名：中文。
- 旧的中文数据目录 `%APPDATA%\骆驼桌宠` 有一次性迁移逻辑（`index.js` 顶部）。

---

## 7. 构建与发布

```bash
npm run dist                     # 产出 setup + portable
# 绿色版：把 dist/win-unpacked 压成 zip（不套多一层目录），并放入 docs/release-readme.txt → README.txt
```

发布清单（手动，无 CI）：

1. 改版本号：`package.json` + `package-lock.json`（根级两处）。
2. `npm run dist`，确认 `dist/` 里三个文件版本号正确。
3. 确认 `app.asar` 内 `package.json` 版本、`manifest.states` 正确（可用 `@electron/asar` 读）。
4. 建 Release（tag 形如 `v1.0.1`），上传 setup / portable / zip。
5. 若 tag 已存在且指向旧提交，先 `git push origin :refs/tags/<tag>` 再发。

> 上传走 GitHub API（`uploads.github.com`）。本机被 Steam++ 劫持了 GitHub 域名，
> 需要 `rejectUnauthorized:false` 的 Node 请求；`git`/`curl` 表现不同，别被误导。

---

## 8. 测试与验证

| 命令 | 验证内容 | 参考结果 |
|---|---|---|
| `npm run smoke` | 启动、渲染层引导、主进程无新错误 | PASS |
| `npm run userdata-check` | 包内/数据根分离、播种、幂等 | 32 项全过 |
| `npm run voicepack-test` | 语音包导入/删除/播放/上限 | 43 项全过 |
| `npm run dock-check` | 自动停靠边界 | — |
| `npm run drag-check` | 拖拽跟手、坏坐标防呆 | — |
| `npm run scheduler-check` | 定时台词/动作调度 | — |
| `npm run settings-shot` | 设置界面全量断言 + 截图 | — |
| `npm run skin-check` | 换肤端到端 | — |
| `npm run capture` | 抓图人工看效果 | 输出到 `temp/capture` |

`smoke-test.cjs` 会把 `main.log` 的新增行当错误——`[boot] [env] [tray] [single-instance] [window-all-closed] [will-quit]` 是信息行，已在 `INFO_STAGES` 白名单里；**新增信息类日志时记得同步**。

---

## 9. 故障排查速查

| 症状 | 先看 | 常见原因 |
|---|---|---|
| 双击没反应 | `launcher.log` | `RID=4096`（完整性标签）；或 Chromium 崩溃 |
| 有进程但屏幕无窗口 | `main.log` 的 `[env]`/`[tray]` | 硬件加速被关（6.1） |
| 托盘没图标 | 任务栏 `^` 展开区；`[tray]` 日志 | Win11 默认收纳；或图标路径未走 unpacked |
| 开机自启报错 | 提示文案 + `main.log` | `HKCU\Run` 被拒（Low 完整性 / 策略）；已回退启动文件夹 |
| 设置改了不生效 | 是否 `no-applier` | applier 表漏项 |
| 数据没保存 | 设置「关于」页的路径 | 可写目录退化到 `data\` |
| 语音没声音 | 设置里是否静音；`readyState` | 默认静音或文件丢失 |

日志位置：`<dataRoot>` 的上一级 `main.log`（打包态即 `%APPDATA%\CamelPet\main.log`）、`launcher.log`（启动器目录）。

---

## 10. 已知限制 / 待办

- **没有代码签名**：SmartScreen 会提示"未知发布者"。要根除需 OV/EV 证书，可接进 `electron-builder.yml` 的 `win` 签名配置。
- 仅 x64、仅 Windows。
- 无自动更新（未配置 `publish`）。
- 素材版权：`assets/` 下图片/音频不在 MIT 范围内，公开分发前需替换为原创或已授权素材。
- 未接 CI；全部验证靠本地命令。

---

## 11. 交接清单

**改代码前**

- [ ] `npm install`，`npm run smoke` 应为 PASS
- [ ] 确认 `launcher.log` 的 `RID=8192`（不是 4096）
- [ ] 读第 6 节红线，尤其 6.1/6.3/6.4

**改设置项**

- [ ] 改 `config/settings.json`，同步在 `src/main/index.js` 加 applier
- [ ] 若用运行期选项，确认 `resolveOptions` 分支与数据源

**发布前**

- [ ] 版本号两处同步
- [ ] 四条命令全绿（smoke / userdata-check / voicepack-test / dist）
- [ ] 解压目录实跑一次，确认托盘 + 开机自启 + 数据落 `%APPDATA%\CamelPet`
- [ ] 三个产物均为纯英文文件名，zip 内无中文路径

---

## 12. 术语

| 词 | 含义 |
|---|---|
| 包根 / 数据根 | `ROOT_DIR`（只读，asar 内）/ `DATA_ROOT`（可写，userData） |
| 大动作 | manifest 里非 `idle`、非 `ambient` 的状态（`cheer` / `dive`） |
| 待机动作 | `ambient: true` 的状态（`blink`），待机时随机插播 |
| 播种 | 首次运行把包内默认数据复制到数据根 |
| 启动器 | `CamelPet.exe`（C#），负责完整性检查、数据目录选择、沙箱降级重试 |
| 核心 | `CamelPetCore.exe`（Electron），真正的应用 |
