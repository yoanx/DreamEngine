# DreamEngine Hub

## 开发运行

```powershell
npm install
npm start
```

## 构建

```powershell
npm run pack      # dist/win-unpacked
npm run dist      # NSIS 安装器
npm run test:package
npm run test:release
```

## 测试

```powershell
npm test          # Node 22+ 内置 test runner，无需 Electron / After Effects
```

测试只覆盖不依赖 GUI 的纯逻辑：路径与目录解析、插件目录 / 外部预设索引、效果库合并
与取消渲染、渲染任务的 spawn 参数、AE 侧 `plugin_state.jsx` / `viewmodel.js` 的纯函数。
全部使用临时目录，不读写真实用户数据。

## 离线预设渲染

- 默认每个专用 AE 实例连续处理最多 40 条预设。
- 成功一条会立即写入结果并继续下一条，不会每 12 条主动重启。
- 只有 AE 崩溃、实例超时或达到 40 条上限时才启动下一个 AE 实例。
- 超时下限为 240 秒，并会按每条 30 秒自动放大，避免大批次被误判超时。
- 动态预设按 6 fps 抽取，最多保留 36 帧；面板按真实源时长播放，不再压缩成 0.5 秒快放。

## 选择性预览渲染

- 插件效果目录扫描：`tools/generate_plugin_effects.ps1 -CatalogOnly`，产物是
  `DreamEngineProbe/plugin_effect_catalog.tsv` + `.meta.json`，只读清单、不渲染。
- 效果与预设渲染共用所选 AE 的版本化 PNG 模板；首次使用某个 AE 主版本时由该 AE
  生成 `DreamEngineProbe/render_templates/DreamEnginePNG-ae<年份>-v1.aep`，后续直接复用。
- AE 外部预设索引：Hub 读取所选 AE 的 `Support Files\Presets` 和
  `文档\Adobe\After Effects <年份>\User Presets`，写
  `DreamEngineProbe/preset_catalog.json`；只建索引、不复制 `.ffx`。
  预设页的「同步 AE 预设」可手动刷新，左侧分类栏按来源文件夹分组；
  勾选外部预设后通过 `-PresetList` 渲染。
- 只渲染所选效果：Hub 写 `DreamEngineProbe/next_plugin_batch.tsv`（`matchName \t frames \t plugin`），
  再调用 `-Todo <file>`；`-Force` 表示忽略已生成/黑名单并重渲所选。
- 只渲染所选预设：Hub 写 `DreamEngineProbe/next_preset_selection.tsv`（每行一个绝对路径），
  再调用 `generate_plugin_presets.ps1 -PresetList <file> [-Force]`。
- 文本 / 变换 / 蒙版类 AE 预设不新增效果，「是否应用成功」不能只数效果：
  引擎同时统计整树关键帧、Text Animator、蒙版数与图层数；落错层时先换合成里的
  文本层，再退回「文字」素材重试一次（Text 分类 300 条曾全被误判为失败）。
- `no_effect`（预设类型落不上）与 `render_error`（渲染报错）分开记入黑名单；
  `-RetryFailed` 会同时清理这两种记录，避免逻辑问题把预设永久藏起来。
- 离线渲染的中间帧固定在 `%TEMP%\DreamEnginePluginRunner\template_out\`，模板队列项
  本身不参与渲染（只给 duplicate 继承输出设置），每轮开始先清残留；成品帧渲染前也会
  清同名旧帧与 `_raw_` 中间帧，避免 AE 弹「文件已存在，是否覆盖」。
- 选择模式不会写 `plugin_auto_catalog.enabled`，避免 JSX 重建清单覆盖用户选择。

## 效果库

- 效果库只读合并四份数据，不写任何索引文件：
  - `data/manifest.json`：面板 L1 内置效果预览（8×8 拼图，含单帧静图条目）；
  - `data/plugin_manifest.json`：Hub 离线生成的插件效果预览（1×N 单行拼图）；
  - `DreamEngineProbe/plugin_effect_catalog.tsv`：AE 扫描到的第三方插件条目与分类；
    其中可渲染（非 excluded / noPreview）但没有预览的条目以「待渲染」占位卡片出现；
  - `data/names.json`：双语名称与 AE 分类（内置效果的分类来源）。
- 顺序：内置按 `manifest.items` 顺序在前，插件按目录 TSV 行序在后；左侧按来源分组
  （AE 内置 / BCC / Sapphire / Red Giant / RE:Vision / Video Copilot / 其它插件），
  组头可展开折叠（状态存 `dreamengine.hub.effectGroupCollapsed.v1`），组内分类保持 AE 首次出现顺序。
- 归类以名字表 + AE 分类为准：`names.json` 里 `pluginHint` 为「内置」的目录条目，以及
  插件未知（其它插件）但落在 AE 内置分类（`沉浸式视频`、`生成` 等）里的条目，都归回
  「AE 内置」分组 —— 扫描的 matchName 前缀启发式会漏判 Keylight、VISINF 颗粒、
  Mettle VR 效果等 AE 自带/随附效果，不算第三方插件。
- 分类栏只读（不支持新建/重命名）；「同步 AE 分类」复用
  `generate_plugin_effects.ps1 -CatalogOnly`，只刷新 `plugin_effect_catalog.tsv`，不渲染。
- 卡片用 CSS 背景百分比裁切精灵图（公式与面板 `js/viewmodel.js` 的 `spriteSlice` 一致），
  内置条目取 8×8 整网的格子、插件条目取单行 8 格中的一格；有预览的动图悬停按 12 fps 播放帧序列。

## 持久构建缓存

默认位置：

```text
%LOCALAPPDATA%\DreamEngine\build-cache
```

其中：

- `electron-dist/<版本>/`：已解包 Electron，构建时直接复用；
- `electron-builder/`：NSIS、7zip 等工具；
- `electron/`：Electron 下载归档缓存。

只有主动删除这个目录才会重新准备构建依赖。`npm run pack` 不会重新下载 Electron。

## 安装器说明

NSIS 安装器会调用现有的 `install_dreamengine.ps1` 安装 CEP 面板和 L1 预览。
卸载器会调用 `uninstall_dreamengine.ps1`，清理 CEP 面板、预设库、背景、缓存、日志和安装时写入的 CEP 调试设置。升级路径不会执行这些清理。
安装器当前未配置代码签名，Windows SmartScreen 可能提示。
