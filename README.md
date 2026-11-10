# 拾音 · 本地音频/视频/链接转文字

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)](RELEASE.md)

> 桌面版 **v1.1.0** 基于 [拾音原项目](https://github.com/x1303145921/shiyin)。提供 Windows 启动器、工作台、媒体缓存清理和应用内更新。
[![Node](https://img.shields.io/badge/Node.js-18+-green.svg)](package.json)
[![CI](https://github.com/hhsbjbsj/shiyin-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/hhsbjbsj/shiyin-desktop/actions/workflows/ci.yml)

> 开口即录，落笔成文 —— 文件不出电脑的语音转文字工具。

**拾音（shiyin）** 是一个纯本地、离线运行的音频/视频/链接转文字工具，基于 [whisper.cpp](https://github.com/ggerganov/whisper.cpp) 语音识别引擎。上传音视频或**粘贴视频链接**（B站/抖音/快手/YouTube）即可转文字——文件与识别全程在本机完成，适合会议录音、课程笔记、访谈整理等重视隐私的场景。

- **纯本地**：服务仅监听 `127.0.0.1`，文件与模型均不出电脑
- **链接直转**：粘贴 B站/YouTube/抖音/快手链接即识别（有官方字幕直接秒出，零算力）
- **网页界面**：双击启动，浏览器即用，零安装依赖（需 Node.js 18+）
- **三种输出**：txt / srt / vtt 字幕格式一键切换、在线编辑、即改即存
- **字幕跟读**：内置播放器 + 字幕段落点击跳转，跟读学习两相宜
- **模型自由**：极速/均衡/高精度三档模型，面板一键下载切换

## ✨ 功能特性

| 特性 | 说明 |
|---|---|
| 🎙 **whisper.cpp 本地识别** | 音频/视频直接转文字，全程离线，文件不出电脑 |
| 📝 **三格式输出** | 全文 txt / 字幕 srt / 网页字幕 vtt，一键切换、在线编辑即存 |
| 📖 **字幕跟读** | 内置播放器 + 字幕段落列表，点击任意行精确跳转（误差 < 0.3s），当前行自动高亮，空格播放/暂停，支持音视频 |
| 🧹 **VAD 静音跳过** | 可选启用 Silero VAD，自动跳过静音段，长音频/播客显著加速，减少环境声幻觉 |
| 🧠 **重复幻觉修复** | 内置双重后处理：相邻重复段落合并 + 段内同一词重复收缩（真实音频验证：重复 40 次 → 1 次） |
| ⏱ **跳过转码提速** | 已是 16kHz 单声道 WAV 的文件直接识别，跳过 ffmpeg 预处理（秒级探测） |
| 🖱 **全局拖拽上传** | 文件拖到页面任意位置即可上传，实时进度条 + 前后端双层格式校验 |
| ↻ **失败一键重试** | 转写失败卡片一键重试，原始媒体保留期内直接复用，无需重新上传 |
| 🎚 **模型管理面板** | 极速 base / 均衡 small / 高精度 turbo 三档，一键下载、切换、删除（hf-mirror.com 镜像） |
| 🔔 **后台完成提醒** | 页面在后台时识别完成自动闪烁标签页标题 |
| 📊 **列表接口瘦身** | 任务多时按需拉取详情，长列表不卡顿 |
| ⏳ **转写耗时显示** | 完成卡片显示实际用时（60s 音频本地 CPU 约 20~30s） |
| 🔗 **链接蒸馏** | 粘贴链接即转写：B站官方 API 直连 / YouTube 字幕优先 / 抖音浏览器代下载 / 快手 H5 直取，自动落盘收件箱 |
| 🎬 **官方字幕秒出** | B站/YouTube 视频有官方/AI 字幕时直接取字幕，1 秒出结果零算力；源语言自动标注 |
| 🗂 **四件套落盘** | 转写完成自动归档 `txt/srt/vtt/meta.json` 到同名子文件夹，输出目录可配置 |
| 🔤 **热词纠错** | 设置热词表修正专有名词误转（如 Crawl4AI→CrossAI），支持 API/settings 配置 |
| 🤖 **AI 总结** | 可选配 OpenAI 兼容端点：一键摘要/要点/分章节（默认关，内容出机前明确提示） |
| 📦 **PWA 可安装** | 支持安装到桌面/任务栏，独立窗口运行 |

## 🖼 界面预览

![拾音界面预览](assets/screenshot.png)

## ⬇️ 下载

| 方式 | 适合谁 | 操作 |
|---|---|---|
| **git clone** | 查看和维护源码 | `git clone https://github.com/hhsbjbsj/shiyin-desktop.git` |
| **源码 ZIP** | 只想先看看 | 仓库页面绿色 `Code` 按钮 → `Download ZIP` |
| **Windows 桌面版** | 首次安装 | 在 [Releases](https://github.com/hhsbjbsj/shiyin-desktop/releases/latest) 下载 `Shiyin-win-x64.zip`，解压后双击 `ShiyinLauncher.exe` |

桌面包适用于 Windows x64，已包含 Node.js 和 .NET 桌面运行时。首次启动会下载缺少的转写工具，网页里的「模型管理」负责下载识别模型。已有桌面版用户以后可在启动器点「检查更新」。应用会从 Releases 下载并校验更新，队列空闲后安装。模型、识别引擎、设置和已保存字幕继续使用原来的文件。

维护者可在 Windows 上运行 `pwsh -File scripts/package-windows.ps1` 本地打包。修改 `package.json` 和 `package-lock.json` 中的版本后，推送对应的 `vX.Y.Z` 标签，GitHub Actions 会构建桌面包并发布到 Releases。应用只提示比已安装版本更高的正式版本。

## 🚀 快速开始（Windows 小白版）

### 第 1 步：准备

安装 [Node.js 18+](https://nodejs.org/zh-cn/download)（一路下一步即可）。

### 第 2 步：启动

如果项目目录中有 Windows 启动器 ShiyinLauncher.exe，双击后点「启动拾音」。启动器会在后台启动本地服务，并在默认浏览器打开转写页面。关闭启动器后服务继续运行，可重新打开启动器查看状态、打开输出目录或停止服务。

启动器源码位于 launcher，使用 .NET 10 SDK 在 Windows 上运行 launcher/build.ps1，可在项目根目录生成 ShiyinLauncher.exe。运行该 EXE 需要 .NET 10 Desktop Runtime x64。

双击 `启动拾音.bat` —— 服务自动在后台启动，浏览器自动打开 `http://127.0.0.1:18900`。

> 想固定在桌面？双击 `安装到桌面.bat`，自动生成「拾音」快捷方式（含新图标）。
> 想关闭服务？双击 `停止拾音.bat`（按端口精确停止，不误伤其它程序）。

### 第 3 步：使用

1. 首次使用先到右侧「模型管理」面板下载一个模型（推荐 **turbo**，性价比最优；日常快速用 **small**）
2. 把音频/视频文件拖进页面（或点击选择文件），选好模型与 VAD 选项；**或直接粘贴 B站/YouTube/抖音/快手链接**
3. 点击「开始识别」——完成后即可查看/编辑全文与字幕，或保存文件
4. 有官方字幕的视频自动走「字幕秒出」（1 秒出结果，标注来源）；无字幕则整段下载转写
5. 转写完成自动归档到收件箱（默认 `桌面/拾音收件箱`，设置面板可改路径）

### 其他平台（macOS / Linux）

```bash
npm install          # 安装依赖（express / multer / chinese-conv / playwright-core）
npm start            # 启动服务 → 浏览器打开 http://127.0.0.1:18900
```

> playwright-core 仅用于抖音/快手链接下载（可选能力，未装则这两平台不可用，其余功能不受影响）；yt-dlp 需自行安装（`pip install yt-dlp` 或放 `bin/yt-dlp.exe`）供 YouTube/直链下载。
> 链接蒸馏依赖网络可达对应平台（国内访问 YouTube 需自行保证网络可达，本工具不提供翻墙能力）。

## 🎙 模型管理

| 模型 | 大小 | 定位 |
|---|---|---|
| `ggml-base.bin` | 141 MB | 极速 · 低要求设备 |
| `ggml-small.bin` | 465 MB | 快速 · 日常够用 |
| `ggml-large-v3-turbo-q5_0.bin` | 547 MB | 高精度 · 性价比最优（推荐） |

- 模型从 Hugging Face 官方镜像（hf-mirror.com）下载，下载时校验 SHA256
- 缓存目录：`D:\shiyin-cache\models`（可通过服务端配置调整）
- 切换模型即时生效，无需重启服务

## 🔌 API 参考

服务默认监听 `127.0.0.1:18900`，前端即调用以下接口（也可供脚本自动化使用）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/transcribe` | 上传音频/视频并创建转写任务（multipart，字段 `file`） |
| GET | `/api/tasks` | 任务列表（含 VAD/模型/时长等元信息，不含字幕大字段，按需拉详情） |
| GET | `/api/task/:id` | 任务详情（含 txt / srt / vtt 全文与媒体信息） |
| POST | `/api/task/:id/retry` | 失败任务重试（保留原始媒体，无需重新上传） |
| GET | `/api/models` | 模型列表与下载/激活状态 |
| POST | `/api/models/use` | 切换当前使用的模型 |
| POST | `/api/models/download` | 下载模型（body: `{ "name": "ggml-small.bin" }`） |
| POST | `/api/vad/download` | 下载 Silero VAD 静音检测模型 |

## 🛠 开发与构建

```bash
# 语法检查（服务端 + 图标渲染/打包脚本）
node --check server.js
node --check scripts/render-icon.js
node --check scripts/build-ico.js

# 启动开发服务
npm start

# 图标（用户提供的麦克风图标，源文件 public/icon-source.webp）：
#   缩放各尺寸（ffmpeg lanczos）→ 打包 ICO：node scripts/build-ico.js work-ico public/app-icon.ico 16,32,48,64,128,256
#   缩放各尺寸（ffmpeg）→ 打包 ICO：node scripts/build-ico.js work-ico public/app-icon.ico 16,32,48,64,128,256
#   （渲染/打包链路细节见 scripts/ 内文件头注释与 CHANGELOG v0.4.0）
```

## 📁 项目结构

```text
拾音/
├── server.js               # 服务端（Express：上传/任务/模型/转写队列）
├── public/                 # 前端（原生 HTML/CSS/JS + PWA）
│   ├── index.html          # 主页面（拖拽上传/任务卡片/模型面板/跟读播放器）
│   ├── service-worker.js   # PWA 缓存（shiyin-v4，图标换新需 bump 版本）
│   ├── manifest.json       # PWA 清单（名称/主题色/图标）
│   └── icon-source.webp    # 图标源文件（用户提供，麦克风图标）
├── scripts/                # 工具脚本
│   ├── render-icon.js      # CDP 透明背景图标渲染（零依赖，Node 21+）
│   └── build-ico.js        # 手写 ICO 打包（ICONDIR + PNG 条目）
├── assets/                 # 截图与视觉资料
├── test-audio/             # 本地测试音频（不入库）
├── 启动拾音.bat            # Windows 启动器
├── 停止拾音.bat            # Windows 停止器（按端口精确停止）
├── 安装到桌面.bat          # 桌面快捷方式 + 图标缓存刷新
├── package.json / LICENSE / CHANGELOG.md / README.md / ...
```

## ❓ 常见问题（FAQ）

| 问题 | 解答 |
|---|---|
| **打不开页面？** | 确认已安装 Node.js 18+；双击 `启动拾音.bat` 后浏览器地址栏输入 `http://127.0.0.1:18900` |
| **识别速度慢？** | 本地 CPU 转写约为实时语速的 2~4 倍（60s 音频约 20~30s），属正常；可换 small 模型提速，或开启「跳过静音段」（VAD） |
| **识别结果有重复？** | 已内置重复幻觉修复；若仍出现，可在 GitHub Issues 附上音频特征描述（时长/环境/口音），我们针对性优化 |
| **模型下载失败？** | 模型来自 hf-mirror.com 镜像；可稍后重试，或手动放置模型文件到缓存目录 `D:\shiyin-cache\models` |
| **浏览器图标还是旧的？** | 强制刷新：浏览器 Ctrl+F5；PWA 固定图标需取消固定再重新固定；Windows 桌面图标残留请重跑 `安装到桌面.bat`（自动刷新图标缓存） |
| **支持哪些格式？** | 常见音视频格式均可（wav/mp3/m4a/flac/mp4/mkv/avi 等，内部经 ffmpeg 处理）；已是 16kHz 单声道 WAV 时跳过转码直识别 |
| **能识别方言/英文吗？** | 默认中文（`-l zh`）；whisper.cpp 支持多语言，可通过服务端参数调整 |
| **会联网吗？** | 下载模型、读取链接字幕或下载链接媒体时需要联网。本地音视频的转写在电脑上完成。 |

## 🔒 隐私与安全

- 服务仅监听 `127.0.0.1`，不对外网开放；请勿修改监听地址暴露到局域网/公网
- 链接有可用字幕时可直接取字幕。需要转写时通常只下载音轨，部分平台会下载视频再提取音轨。
- 完成后可在任务里点「清理媒体」并确认，删除跟读用的媒体缓存。服务启动时及运行期间每 10 分钟清理一次超过 2 小时的媒体缓存和中断留下的链接下载文件。字幕、文本和本地上传的源文件保留。
- 前端不依赖任何第三方 CDN，无外部脚本注入面
- 完整安全边界见 [SECURITY.md](SECURITY.md)

## 📜 许可证

[MIT License](LICENSE) © 2026 颜（x1303145921）

---

*拾音 —— 灯下拾音，纸上落字。*
