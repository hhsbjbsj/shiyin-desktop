/**
 * 拾音 (Shiyin) — 本地音频/视频/链接 → 文字（whisper.cpp 引擎，文件不出电脑）
 * 基于 whisper.cpp，纯本地离线：上传音视频或粘贴 B站/抖音/快手/YouTube 链接即可转文字。
 * v1.0.0：开源版功能整合——在 v0.4.0（纯本地上传）基础上合入自用改装线全部能力：
 * v0.5：链接识别（yt-dlp）+ 结果自动落盘 OUT_DIR
 * v0.6：B站链接改走官方 API 直连（yt-dlp 被 B站 412 风控全废）；有官方/AI 字幕则直接取字幕秒出，无字幕下 dash 音频转写
 * v0.7：输出位置可配置（设置面板可改任意目录，重启保留）；可选填 B站 SESSDATA 解锁官方 AI 字幕；settings.json 持久化
 * v0.9：多平台下载（抖音=浏览器代下载 / 快手=H5 直取）+ 平台适配器注册表 + JSONL 台账 + meta 增补平台/片长/大小
 * v0.9.1：字幕与功能区块加强——字幕工具（时间偏移/统计/单格式下载，纯前端）、AI 总结（OpenAI 兼容端点自配，默认关）、任务平台/片长信息回显、批量多链接、任务删除 API、settings 增 AI 配置
 * v0.9.3：四件套落盘改为「同名子文件夹」（txt/srt/vtt/meta 归入同名目录，收件箱不撒文件）
 * v0.9.4：热词机制——whisper.cpp --prompt 通道注入热词，API/settings.json 可配；实测只注入 ASCII 词
 * v0.9.5：文本整理——重复括号标签折叠（[笑声][笑声]→[笑声]）+ CJK 相邻空格删除（借鉴 VibeVoice asr_streaming tidy_body 思路）
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { sify } = require('chinese-conv');
const { version: VERSION } = require('./package.json');
// v0.9：多平台下载适配器（抖音/快手等，插件式注册表见 platforms.js）；require 失败不阻塞服务（仅平台不可用）
let detectAdapter = null;
let platformsReady = false;
try {
  ({ detectAdapter } = require('./platforms'));
  platformsReady = true;
} catch (e) {
  console.log('⚠️ 多平台适配器未就绪（' + e.message.slice(0, 120) + '），抖音/快手链接暂不可用');
}

const ROOT = __dirname;

// whisper.cpp 在 Windows 上无法处理含非 ASCII 字符的路径（UTF-8 argv + CRT 代码页限制），
// 实测：exe 在中文路径可运行，但模型/输入/输出文件路径必须是纯 ASCII。
// 因此在项目同盘符根目录建 ASCII 缓存目录，模型/工作文件全部放里面。
const VOL_ROOT = path.parse(ROOT).root; // 如 D:\
const RUNTIME = (() => {
  const rootCache = path.join(VOL_ROOT, 'shiyin-cache');
  try {
    fs.mkdirSync(rootCache, { recursive: true });
    fs.accessSync(rootCache, fs.constants.W_OK);
    return rootCache;
  } catch (e) {
    if (!process.env.LOCALAPPDATA || !['EPERM', 'EACCES', 'EROFS'].includes(e.code)) throw e;
    return path.join(process.env.LOCALAPPDATA, 'Shiyin', 'runtime');
  }
})();
const MODEL_DIR = path.join(RUNTIME, 'models');
const WORK = path.join(RUNTIME, 'work');
const UPLOAD_DIR = path.join(WORK, 'uploads');
const MEDIA_DIR = path.join(WORK, 'media'); // 转写完成后保留的原始媒体（供前端播放/字幕跳转）
const MEDIA_RETENTION_MS = 2 * 3600_000;
const TASK_ID_RE = /^[a-f0-9]{16}$/;
const MEDIA_EXT_RE = /\.(mp3|wav|m4a|flac|aac|ogg|opus|wma|mp4|mkv|mov|avi|webm|flv|ts|m4v|wmv|3gp|ogv|mpg|mpeg|aiff|ape|amr)$/i;
// 设置持久化（输出目录 / B站 SESSDATA），存 RUNTIME 下 settings.json
const SETTINGS_FILE = path.join(RUNTIME, 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8'); } catch {} }
// v0.9：数据台账（JSONL，每次任务成功/失败各记一行，失败可看台账重试）
const LEDGER_FILE = path.join(RUNTIME, 'ledger.jsonl');
function appendLedger(task) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      kind: task.sourceUrl ? 'link' : 'upload',
      url: task.sourceUrl || null,
      platform: task.platform || null,
      status: task.status,
      title: task.fileName && task.fileName.length < 300 ? task.fileName : (task.fileName || '').slice(0, 300),
      sizeMB: task.sizeMB || null,
      durationSec: task.durationSec || null,
      elapsedSec: task.elapsedSec || null,
      outDir: task.outDir || null,
      outFiles: task.outFiles || null,
      error: task.error || null,
    };
    fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch {}
}
// 落盘目录：优先级 = 设置面板(settings.json) > 环境变量 SHIYIN_OUT_DIR > 默认（用户桌面/拾音收件箱）
const DEFAULT_OUT_DIR = path.join(require('os').homedir(), 'Desktop', '拾音收件箱');
function getOutDir() { return (settings.outDir && settings.outDir.trim()) || process.env.SHIYIN_OUT_DIR || DEFAULT_OUT_DIR; }
function ensureOutDir() { try { fs.mkdirSync(getOutDir(), { recursive: true }); } catch {} }
ensureOutDir();

// ---------- 热词（v0.9.4）：whisper.cpp --prompt 通道 ----------
// 实测结论（2026-09-09 A/B，hw_ab.wav + turbo q5_0）：
//   - 英文/ASCII 热词进 --prompt 有效：Crawl4AI 无 prompt 误转为「CrossAI」，带 prompt 修正为「Crawl4AI」
//   - 中文 prompt 经 Windows ANSI argv 会乱码（实验 B：prompt 乱码导致输出标点全丢），故只注入 ASCII 词；
//     中文专名 whisper 原生识别已准，无需 prompt 兑底
//     开源版默认表留空（靠设置面板/API 按需配），避免生态词预设干扰通用场景
const DEFAULT_HOTWORDS = '';
function getHotwordsSource(task) {
  if (task && typeof task.hotwords === 'string' && task.hotwords.trim()) return task.hotwords;
  if (typeof settings.hotwords === 'string' && settings.hotwords.trim()) return settings.hotwords;
  return DEFAULT_HOTWORDS;
}
function buildHotwordPrompt(task) {
  const src = getHotwordsSource(task);
  const words = [...new Set(src.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean))];
  const ascii = words.filter((w) => /^[\x20-\x7E]+$/.test(w));
  const skipped = words.filter((w) => !/^[\x20-\x7E]+$/.test(w));
  if (!ascii.length) return null;
  return { prompt: `The following proper nouns appear: ${ascii.join(', ')}.`, used: ascii, skipped, src };
}
const VAD_MODEL = 'ggml-silero-v6.2.0.bin'; // Silero VAD（跳过静音段）
const WHISPER = path.join(ROOT, 'bin', 'Release', 'whisper-cli.exe');
// 链接下载器 yt-dlp：pip 安装到 bin/yt-dlp-pkg（独立包，不污染系统 Python），用 python -m yt_dlp 调用
const PYTHON = process.env.PYTHON || 'python';
const YTDLP_PKG = path.join(ROOT, 'bin', 'yt-dlp-pkg');
const YTDLP_MAIN = path.join(YTDLP_PKG, 'yt_dlp', '__main__.py'); // 直接执行入口（embedded Python 忽略 PYTHONPATH，靠 __main__.py 自己插 sys.path）
const FILE_YTDLP = path.join(ROOT, 'bin', 'yt-dlp.exe'); // 兼容：若用户后来放了 standalone exe 则优先用它
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const PORT = parseInt(process.env.PORT || '18900', 10);
const HOST = process.env.BIND || '127.0.0.1';
const LAUNCHER_TOKEN = process.env.SHIYIN_LAUNCHER_TOKEN;
delete process.env.SHIYIN_LAUNCHER_TOKEN;
const HF_MIRROR = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main';

// ---------- 模型注册表 ----------
const MODELS = {
  'ggml-base.bin': { sizeMB: 141, desc: '极速 · 低要求' },
  'ggml-small.bin': { sizeMB: 465, desc: '快速 · 日常够用' },
  'ggml-large-v3-turbo-q5_0.bin': { sizeMB: 547, desc: '高精度 · 性价比最优' },
};
let activeModel = 'ggml-small.bin';
const ACTIVE_FILE = path.join(MODEL_DIR, '.active');

// 恢复上次使用的模型（持久化，重启不丢）
try {
  if (fs.existsSync(ACTIVE_FILE)) {
    const saved = fs.readFileSync(ACTIVE_FILE, 'utf8').trim();
    if (MODELS[saved]) activeModel = saved;
  }
} catch {}

fs.mkdirSync(MODEL_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// 项目 models/ 里已有模型 hardlink 进缓存目录（同卷零拷贝）
for (const name of Object.keys(MODELS)) {
  const src = path.join(ROOT, 'models', name);
  const dst = path.join(MODEL_DIR, name);
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    try { fs.linkSync(src, dst); } catch { try { fs.copyFileSync(src, dst); } catch {} }
  }
}

const app = express();
let stopping = false;
let uploads = 0;
app.use((req, res, next) => {
  const host = req.get('Host');
  const origin = req.get('Origin');
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)
    || (origin && origin !== `http://${host}`)) {
    return res.status(403).json({ error: '只接受来自拾音本机页面的请求' });
  }
  next();
});
app.use(express.static(path.join(ROOT, 'public')));
app.use(express.json());
app.use((req, res, next) => {
  if (stopping) return res.status(503).json({ error: '拾音正在停止' });
  next();
});

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB 上限
  // 粗筛：只收常见音视频扩展名（避免 txt/zip 等排进队后 ffmpeg 报模糊错误）
  fileFilter: (req, file, cb) => {
    const ok = MEDIA_EXT_RE.test(file.originalname);
    if (!ok) return cb(new Error('不支持的格式：' + (file.originalname || '未命名') + '（支持常见音视频：mp3/wav/m4a/flac/mp4/mkv/mov…）'));
    cb(null, true);
  },
});

// ---------- 任务队列（并发 2，批量排队） ----------
const tasks = new Map(); // id -> task
const queue = [];        // id 数组
const running = [];      // 正在执行的任务 id（最多 CONCURRENCY 个）
const CONCURRENCY = 1;   // Whisper 每个进程都加载模型，串行避免重复占用内存和显存

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString('utf8')));
    p.stderr.on('data', (d) => (out += d.toString('utf8')));
    p.on('error', (e) => reject(new Error(`无法启动 ${cmd}: ${e.message}`)));
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${out.slice(-500)}`))
    );
  });
}

// 运行 yt-dlp：优先 standalone exe，否则 python -m yt_dlp（带 PYTHONPATH 指向本地包）
function runYtDlp(args) {
  if (fs.existsSync(FILE_YTDLP)) return run(FILE_YTDLP, args);
  return run(PYTHON, [YTDLP_MAIN, ...args]);
}

// ---------- YouTube 字幕优先（v0.8）：借鉴 BiliNote youtube_subtitle.py —— 不下载视频，字幕直取 ----------
// YouTube 自动字幕覆盖绝大多数视频：先 yt-dlp --skip-download 直取字幕（秒出零算力），
// 无字幕/网络不可达再降级整段下载转写（downloadUrl 原链路）。⚠️ 仅限网络本身可达 YouTube 时生效，不为翻墙开代理
function isYtUrl(url) {
  return /(^|\.)youtube\.com\/(watch\?|shorts\/|embed\/|live\/)|youtu\.be\//i.test(url || '');
}

// 字幕轨道语言偏好：zh > en > ja > 其他（文件名含语言代码，yt-dlp 格式 {id}.{lang}.{ext}）
function subLangScore(fn) {
  const s = fn.toLowerCase();
  if (/zh([-._]|\b)|中文/.test(s)) return 30;
  if (/en([-._]|\b)/.test(s)) return 20;
  if (/ja([-._]|\b)/.test(s)) return 10;
  return 0;
}

// YouTube 字幕文件（vtt/srt/json3）→ 段数组（{from,to,content}）→ 复用 biliSubsToFiles 统一出口
function parseSubFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const arr = [];
  const clean = (s) => String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (/\.vtt$/i.test(filePath)) {
    // WEBVTT cue："00:01.000 --> 00:04.000\n文本"（可能带小时段）
    const re = /(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
    const toSec = (t) => { const p = t.split(':'); return (p.length === 3 ? +p[0] * 3600 : 0) + +p[p.length - 2] * 60 + +parseFloat(p[p.length - 1]); };
    let m;
    while ((m = re.exec(raw))) {
      const content = clean(m[3]);
      if (content) arr.push({ from: toSec(m[1]), to: toSec(m[2]), content });
    }
  } else if (/\.srt$/i.test(filePath)) {
    const re = /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
    const toSec = (t) => { const p = t.split(':'); return +p[0] * 3600 + +p[1] * 60 + +parseFloat(p[2].replace(',', '.')); };
    let m;
    while ((m = re.exec(raw))) {
      const content = clean(m[3]);
      if (content) arr.push({ from: toSec(m[1]), to: toSec(m[2]), content });
    }
  } else if (/\.json3?$/i.test(filePath)) {
    try {
      const j = JSON.parse(raw);
      for (const e of (j.events || [])) {
        if (!e.segs || !e.segs.length) continue;
        const content = clean(e.segs.map((s) => s.utf8 || '').join(''));
        if (content) arr.push({ from: (e.tStartMs || 0) / 1000, to: ((e.tStartMs || 0) + (e.dDurationMs || 0)) / 1000, content });
      }
    } catch { /* json3 解析失败视为无字幕 */ }
  }
  return arr;
}

// YouTube 字幕优先：成功 {done:true} 并落盘；失败抛错由 executeTask 降级整段下载转写
async function ytSubtitleProcess(task) {
  const dir = path.join(WORK, 'uploads', task.id);
  fs.mkdirSync(dir, { recursive: true });
  const outTpl = path.join(dir, 'sub.%(id)s.%(ext)s');
  const args = ['--no-playlist', '--skip-download', '--write-subs', '--write-auto-subs',
    '--socket-timeout', '10', '--retries', '2', // 字幕探测快速失败（网络不可达 ~30s 内降级，不拖慢整体）
    '--sub-langs', 'zh.*,zh-Hans,zh-CN,zh-TW,zh,en.*,en-US,en,ja,ja.*',
    '--sub-format', 'vtt/srt/best', '-o', outTpl, '--print', '%(title)s', task.sourceUrl];
  let title = '';
  try {
    title = (await runYtDlp(args)).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  } catch (e) {
    throw new Error('YouTube 字幕获取失败：' + e.message.slice(-200));
  }
  const files = fs.readdirSync(dir).filter((f) => /\.(vtt|srt|json3?)$/i.test(f));
  if (!files.length) throw new Error('YouTube 无可用字幕轨道（降级下载转写）');
  const pick = files.sort((a, b) => subLangScore(b) - subLangScore(a))[0];
  const arr = parseSubFile(path.join(dir, pick));
  if (!arr.length) throw new Error('YouTube 字幕内容为空（降级下载转写）');
  const out = biliSubsToFiles(arr);
  if (!out.txt.trim()) throw new Error('YouTube 字幕文本为空（降级下载转写）');
  task.fileName = title || 'YouTube 视频';
  task.baseName = safeBaseName(task.fileName);
  task.status = 'done';
  task.result = { text: out.txt, srt: out.srt, vtt: out.vtt, file: task.fileName, noSpeech: false, model: 'YouTube字幕', vad: false };
  task.elapsedSec = Math.round((Date.now() - (task.startAt || Date.now())) / 1000);
  persistToOutbox(task, out.txt, out.srt, out.vtt);
  return { done: true };
}

// ---------- 链接下载（yt-dlp）：B站/YouTube/直链 → 最佳音轨转 mp3（whisper 只要音频，省时省空间） ----------
async function downloadUrl(url, id) {
  const dir = path.join(UPLOAD_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const outTpl = path.join(dir, 'dl.%(ext)s');
  let title = '';
  try { title = (await runYtDlp(['--get-title', '--no-playlist', url])).trim(); } catch { /* 拿不到标题不影响下载 */ }
  await runYtDlp(['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', outTpl, '--no-playlist', url]);
  const files = fs.readdirSync(dir).filter((f) => /\.(mp3|m4a|webm|opus|wav|flac|aac|ogg)$/i.test(f));
  if (!files.length) throw new Error('下载完成但未找到音频文件（可能需登录/反爬拦截）');
  return { dlPath: path.join(dir, files[0]), title };
}

// ---------- B站官方 API 链路（v0.6）：yt-dlp 对 B站已被 412 风控（2026-09-03 实测全废），B站链接改走官方 API 直连 ----------
// 实测：Node https 匿名 + UA/Referer 可正常访问 view/player/playurl 与音频 CDN；风控若再收紧可改用 curl.exe（schannel TLS 指纹更接近浏览器）
// 实测（2026-09-03）：完整浏览器 UA（含 AppleWebKit/KHTML 段）反而触发 B站 412 风控（缺其他浏览器特征头，特征不匹配）；
// 简化 UA（无 AppleWebKit 段）稳定 200 —— 反直觉但实测复现 5/5 vs 5/5，以实测为准
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0';

// B站 buvid cookie 缓存（SPI 惰性获取，30 分钟有效）——B站风控对无 cookie 请求概率性 412，带上显著降概率
let biliCk = '';
let biliCkAt = 0;
async function biliGetCookie(force) {
  if (!force && biliCk && Date.now() - biliCkAt < 30 * 60 * 1000) return biliCk;
  try {
    const r = await biliRaw('https://api.bilibili.com/x/frontend/finger/spi', 3, null);
    const j = JSON.parse(r.body);
    if (r.status === 200 && j.data && j.data.b_3) {
      biliCk = 'buvid3=' + j.data.b_3 + (j.data.b_4 ? '; buvid4=' + j.data.b_4 : '');
      biliCkAt = Date.now();
    }
  } catch {}
  return biliCk;
}

// 裸 GET（不自动带 cookie，供 SPI 用）
function biliRaw(url, maxRedirect, cookie) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': BILI_UA, 'Referer': 'https://www.bilibili.com/' };
    const host = new URL(url).hostname;
    if (cookie && (host === 'bilibili.com' || host.endsWith('.bilibili.com'))) headers.Cookie = cookie;
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirect > 0) {
        res.resume();
        const loc = res.headers.location;
        return resolve(biliRaw(loc.startsWith('//') ? 'https:' + loc : (/^https?:/i.test(loc) ? loc : new URL(loc, url).href), maxRedirect - 1, cookie));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(20000, () => req.destroy(new Error('B站请求超时')));
    req.on('error', (e) => reject(new Error('B站请求失败：' + e.message)));
  });
}

// B站 API/网页 GET：自动带 buvid cookie；412 风控时刷新 cookie + 退避重试（最多 3 轮）
// 可选 SESSDATA（设置面板）：B站 AI 字幕需登录态才可见，填了可解锁官方字幕秒出
async function biliApi(url, maxRedirect = 3) {
  const ck = await biliGetCookie(false);
  const sess = settings.biliSessdata ? 'SESSDATA=' + settings.biliSessdata.trim() + '; ' : '';
  let r = await biliRaw(url, maxRedirect, sess + ck);
  for (let i = 0; i < 3 && r.status === 412; i++) {
    await new Promise((res) => setTimeout(res, 1500 + Math.random() * 2000));
    const fresh = sess + (await biliGetCookie(true));
    r = await biliRaw(url, maxRedirect, fresh);
  }
  return r;
}

// B站 JSON 接口：code!==0 抛错
async function biliJson(url) {
  const r = await biliApi(url);
  if (r.status !== 200) throw new Error('B站接口 HTTP ' + r.status + '：' + String(r.body).slice(0, 160).replace(/\s+/g, ' ') + ' ← ' + url);
  const j = JSON.parse(r.body);
  if (j.code !== 0) throw new Error('B站接口错误 code=' + j.code + (j.message ? '（' + j.message + '）' : ''));
  return j.data;
}

// 短链解析：b23.tv → 跟随重定向拿最终 URL
function biliRedirect(url) {
  return new Promise((resolve, reject) => {
    const hop = (u, n) => {
      const req = https.get(u, { headers: { 'User-Agent': BILI_UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n > 0) {
          res.resume();
          const loc = res.headers.location;
          return hop(loc.startsWith('//') ? 'https:' + loc : (/^https?:/i.test(loc) ? loc : new URL(loc, u).href), n - 1);
        }
        res.resume();
        resolve({ status: res.statusCode, url: u });
      });
      req.setTimeout(15000, () => req.destroy(new Error('短链解析超时')));
      req.on('error', (e) => reject(new Error('短链解析失败：' + e.message)));
    };
    hop(url, 5);
  });
}

function isBiliUrl(url) { return /bilibili\.com|b23\.tv/i.test(url); }

// 解析 B站链接 → { bvid|aid, page, qs }；b23.tv 先解短链；支持 ?p=N 分P
async function resolveBiliId(url) {
  let u = String(url);
  if (/b23\.tv/i.test(u)) u = (await biliRedirect(u)).url;
  const bv = u.match(/BV[0-9A-Za-z]{10}/);
  const av = u.match(/av(\d+)/i);
  if (!bv && !av) throw new Error('无法识别的 B站链接（仅支持 bilibili.com/video/BVxxx、av 号、b23.tv 短链）');
  const page = Math.max(1, parseInt((u.match(/[?&]p=(\d+)/i) || [])[1] || '1', 10));
  const q = bv ? 'bvid=' + bv[0] : 'aid=' + av[1];
  return { bvid: bv ? bv[0] : null, aid: av ? av[1] : null, page, qs: q };
}

// 字幕挑选：中文字幕优先，人工字幕（ai_type=0）优先于 AI 字幕
function pickBiliSubtitle(subs) {
  if (!Array.isArray(subs) || !subs.length) return null;
  const score = (s) => {
    const lan = String(s.lan || '');
    const doc = String(s.lan_doc || '');
    let sc = 0;
    if (/^zh/i.test(lan) || /中文|简体|繁体/.test(doc)) sc += 10;
    if (String(s.ai_type) === '0') sc += 5;
    return sc;
  };
  return subs.filter((s) => s.subtitle_url).sort((a, b) => score(b) - score(a))[0] || null;
}

// B站字幕 json（body[]: {from,to,content}）→ txt/srt/vtt 三件套（剥标签 + 繁转简）
function biliSubsToFiles(arr) {
  const pad = (n, l) => String(n).padStart(l || 2, '0');
  const fmtSrt = (t) => {
    const d = new Date(Math.round(t * 1000));
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ',' + pad(d.getUTCMilliseconds(), 3);
  };
  const fmtVtt = (t) => fmtSrt(t).replace(',', '.');
  const txt = [], srt = [], vtt = [];
  for (const it of arr) {
    const text = sify(String(it.content || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
    if (!text) continue;
    txt.push(text);
    const from = Number(it.from) || 0;
    const to = Number(it.to) || from;
    srt.push((srt.length + 1) + '\n' + fmtSrt(from) + ' --> ' + fmtSrt(to) + '\n' + text);
    vtt.push(fmtVtt(from) + ' --> ' + fmtVtt(to) + '\n' + text);
  }
  return { txt: txt.join('\n'), srt: srt.join('\n\n'), vtt: 'WEBVTT\n\n' + vtt.join('\n\n') };
}

// 通用下载（B站 CDN 需 UA/Referer）：流式 + 进度回调
function biliDownload(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': BILI_UA, 'Referer': 'https://www.bilibili.com/' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      let done = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => { done += c.length; if (onProgress && total) onProgress(done, total); });
      res.pipe(out);
      out.on('finish', () => { if (onProgress && total) onProgress(total, total); resolve(); });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error('下载超时')));
    req.on('error', (e) => reject(new Error('下载失败：' + e.message)));
  });
}

// B站链接统一处理：返回 { done:true }（字幕秒出已落盘）或 { done:false, dlPath, title }（音频供 whisper）
async function biliProcess(task) {
  const { bvid, aid, page, qs } = await resolveBiliId(task.sourceUrl);
  const view = await biliJson('https://api.bilibili.com/x/web-interface/view?' + qs);
  const pages = view.pages || [];
  const pg = pages[Math.min(page - 1, pages.length - 1)] || {};
  const cid = pg.cid;
  if (!cid) throw new Error('B站：未取到视频 cid（可能为付费/会员内容）');
  const title = String(view.title || '').trim() || 'B站视频';
  const vq = bvid ? 'bvid=' + bvid : 'aid=' + aid;
  task.progress = 6;

  // 1) 字幕优先：有官方/AI 字幕直接秒出，跳过 whisper
  try {
    const pid = await biliJson('https://api.bilibili.com/x/player/wbi/v2?' + vq + '&cid=' + cid);
    const subs = (pid.subtitle && pid.subtitle.subtitles) || [];
    const picked = pickBiliSubtitle(subs);
    if (picked) {
      const su = String(picked.subtitle_url);
      const r = await biliApi(su.startsWith('//') ? 'https:' + su : su);
      if (r.status === 200) {
        const arr = JSON.parse(r.body).body;
        if (Array.isArray(arr) && arr.length) {
          const files = biliSubsToFiles(arr);
          if (files.txt.trim()) {
            // 源标注：中文字幕 → 「官方字幕」；非中文（英/日等）→ 附语言名，避免误当中文内容
            const lan = String((picked && picked.lan) || '');
            const lanDoc = String((picked && picked.lan_doc) || '').replace(/\([^)]*\)/g, '');
            const srcTag = /^zh/i.test(lan) || /中文|简体|繁体/.test(lanDoc) ? '官方字幕' : '官方字幕（' + (lanDoc || lan || '非中文') + '）';
            task.fileName = title;
            task.baseName = safeBaseName(title);
            task.status = 'done';
            task.result = { text: files.txt, srt: files.srt, vtt: files.vtt, file: title, noSpeech: false, model: srcTag, vad: false };
            task.elapsedSec = Math.round((Date.now() - (task.startAt || Date.now())) / 1000);
            persistToOutbox(task, files.txt, files.srt, files.vtt);
            return { done: true };
          }
        }
      }
    }
  } catch { /* 字幕探测/解析失败不阻塞，降级走音频转写 */ }

  // 2) 无字幕 → dash 音频下载（音质从高到低逐个尝试，会员音质 403 自动跳过）
  task.progress = 8;
  const pl = await biliJson('https://api.bilibili.com/x/player/playurl?' + vq + '&cid=' + cid + '&fnval=16');
  const auds = ((pl.dash && pl.dash.audio) || []).slice().sort((a, b) => b.id - a.id);
  if (!auds.length) throw new Error('B站：未取到可用音频流（该视频可能需要登录/大会员）');
  const dir = path.join(UPLOAD_DIR, task.id);
  fs.mkdirSync(dir, { recursive: true });
  let lastErr = null;
  for (const a of auds) {
    const u = a.baseUrl || a.base_url;
    if (!u) continue;
    try {
      const m4s = path.join(dir, 'dl.m4s');
      await biliDownload(u, m4s, (done, total) => { task.progress = Math.max(task.progress || 0, 8 + Math.round((done / total) * 52)); });
      // dash 音频是裸 fMP4（m4s），播放器兼容性差 → 顺手转 mp3（给 whisper 抽音与前端播放共用）
      const mp3 = path.join(dir, 'dl.mp3');
      await run(FFMPEG, ['-y', '-v', 'error', '-i', m4s, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', mp3]);
      fs.promises.unlink(m4s).catch(() => {});
      return { done: false, dlPath: mp3, title };
    } catch (e) { lastErr = e; }
  }
  throw new Error('B站：音频下载失败' + (lastErr ? '：' + lastErr.message : ''));
}

function runWhisper(inputWav, task, outPrefix) {
  return new Promise((resolve, reject) => {
    task.model = activeModel;
    const model = path.join(MODEL_DIR, task.model);
    // 输出前缀统一由调用方指定（WORK/id）——即使输入是媒体目录文件（重试场景），输出也写工作区，不污染媒体目录
    const base = outPrefix || inputWav.replace(/\.wav$/, '');
    // 反幻觉参数（借鉴 WhisprRT）：temperature=0.0（默认）、禁用温度回退（-tpi 0）、no_speech 阈值 0.6
    // -pp 只打印识别进度，字幕时间戳仍由 Whisper 正常生成。
    const args = [
      '-m', model, '-l', 'zh', '-f', inputWav,
      '-otxt', '-osrt', '-ovtt', '-of', base,
      '-t', '8', '-nth', '0.60', '-tpi', '0.0', '-pp',
    ];
    // v0.9.4：热词 prompt（仅 ASCII 词，中文词自动跳过，原因见 buildHotwordPrompt 注释）
    const hw = buildHotwordPrompt(task);
    if (hw) {
      args.push('--prompt', hw.prompt);
      task.hotwordsUsed = hw.used;
      task.hotwordsSkipped = hw.skipped;
    } else {
      task.hotwordsUsed = [];
      task.hotwordsSkipped = [];
    }
    // v0.3：VAD 静音跳过（长音频/播客显著加速 + 减少环境声幻觉）；需 ggml-silero-v6.2.0.bin 已下载
    if (task.useVad) {
      const vadPath = path.join(MODEL_DIR, VAD_MODEL);
      if (!fs.existsSync(vadPath)) {
        return reject(new Error('VAD 模型未下载，请先在右侧面板下载「静音检测模型」'));
      }
      args.push('--vad', '-vm', vadPath);
    }
    const p = spawn(WHISPER, args, { cwd: ROOT });
    let err = '';
    const parseProgress = (d) => {
      const m = d.toString('utf8').match(/progress\s*=\s*(\d+)%/);
      if (m) task.progress = Math.max(task.progress || 0, parseInt(m[1], 10));
    };
    p.stdout.on('data', parseProgress);
    p.stderr.on('data', (d) => { parseProgress(d); err = (err + d.toString('utf8')).slice(-4096); });
    p.on('error', (e) => reject(new Error(`无法启动 whisper: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0) return resolve();
      if (/out of memory|failed to allocate|cudaErrorMemoryAllocation|ctx->mem_buffer != NULL/i.test(err)) {
        return reject(new Error('识别引擎分配内存或显存失败。可切换较小的模型或关闭静音检测后重新上传。'));
      }
      reject(new Error(`识别失败（退出码 ${code}）：${err.slice(-500)}`));
    });
  });
}

async function executeTask(task) {
  let uploadPath = task.uploadPath;
  let wavPath = path.join(WORK, task.id + '.wav');
  const base = path.join(WORK, task.id);
  try {
    // 0. 链接任务：先下载到工作区，再走统一转写流程
    //    B站 → 官方 API 直连（yt-dlp 已被 B站 412 风控）：有字幕直接秒出（done），无字幕下音频转写
    //    非 B站（YouTube/直链等）→ yt-dlp（原链路）
    if (task.sourceUrl && !task.uploadPath) {
      task.status = 'downloading';
      const adapter = detectAdapter && detectAdapter(task.sourceUrl); // v0.9 插件平台（抖音/快手）
      if (isBiliUrl(task.sourceUrl)) {
        task.platform = 'bilibili';
        const r = await biliProcess(task);
        if (r.done) return; // 字幕模式已产出结果并落盘，提前结束（finally 兜底清理）
        task.uploadPath = r.dlPath;
        uploadPath = r.dlPath;
        if (r.title) { task.fileName = r.title + path.extname(r.dlPath); task.baseName = safeBaseName(r.title); }
      } else if (isYtUrl(task.sourceUrl)) {
        task.platform = 'youtube';
        // YouTube：字幕优先（v0.8）——有自动/人工字幕直接秒出；无字幕或网络不可达降级整段下载转写
        try {
          const yr = await ytSubtitleProcess(task);
          if (yr.done) return; // 字幕模式已产出并落盘（finally 兜底清理）
        } catch (e) {
          console.log(`YouTube 字幕降级下载转写：${String(e.message).slice(0, 140)}`);
        }
        const { dlPath, title } = await downloadUrl(task.sourceUrl, task.id);
        task.uploadPath = dlPath;
        uploadPath = dlPath;
        if (title) { task.fileName = title + path.extname(dlPath); task.baseName = safeBaseName(title); }
      } else if (adapter) {
        // 插件平台：适配器负责把视频落到工作目录，其余复用统一转写流水线（platform 提前标记：下载失败也进台账带平台）
        task.platform = adapter.id;
        const r = await adapter.download(task, path.join(UPLOAD_DIR, task.id));
        task.platform = adapter.id;
        task.uploadPath = r.dlPath;
        uploadPath = r.dlPath;
        if (r.title) { task.fileName = r.title + path.extname(r.dlPath); task.baseName = safeBaseName(r.title); }
        if (r.sizeMB) task.sizeMB = r.sizeMB;
      } else {
        task.platform = 'direct';
        const { dlPath, title } = await downloadUrl(task.sourceUrl, task.id);
        task.uploadPath = dlPath;
        uploadPath = dlPath;
        if (title) { task.fileName = title + path.extname(dlPath); task.baseName = safeBaseName(title); }
      }
      // 链接任务统一补元信息：大小 + 片长（ffprobe），供 meta.json / 台账
      try {
        const st = fs.statSync(uploadPath);
        if (st && st.size > 0) task.sizeMB = Math.round((st.size / 1048576) * 10) / 10;
      } catch {}
      if (!task.durationSec) {
        try {
          const probe = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', uploadPath]);
          const d = parseFloat(String(probe).trim());
          if (d > 0) task.durationSec = Math.round(d);
        } catch { /* 探测失败不阻塞 */ }
      }
    }
    // 1. 已是 whisper 输入格式（16kHz 单声道 WAV）？直接跳过转码（音频上传最省时的场景）
    //    ffprobe 秒级探测；仅 .wav 值得探测（mp3/flac/视频一律走 ffmpeg）
    let skipConvert = false;
    if (path.extname(task.fileName).toLowerCase() === '.wav') {
      try {
        const probe = await run(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', uploadPath]);
        const m = probe.trim().match(/^(\d+),(\d+)$/);
        if (m && m[1] === '16000' && m[2] === '1') {
          wavPath = uploadPath; // 直接用原文件喂 whisper（输出文件写在 uploadPath 旁）
          skipConvert = true;
        }
      } catch { /* 探测失败走正常转码 */ }
    }
    // 1. 预处理：16kHz 单声道 WAV（whisper 硬性要求），视频自动抽音轨
    task.status = 'preprocess';
    if (!skipConvert) {
      await run(FFMPEG, ['-y', '-v', 'error', '-i', uploadPath, '-vn', '-ac', '1', '-ar', '16000', wavPath]);
    }
    // 2. 识别
    task.status = 'transcribing';
    task.progress = 0;
    await runWhisper(wavPath, task, base);
    // 3. 读取结果 + 繁转简（whisper 中文输出偏繁体）；输出统一在 WORK/id.*（runWhisper 用 -of 指定）
    const resBase = base;
    const read = (ext) => (fs.existsSync(resBase + ext) ? sify(fs.readFileSync(resBase + ext, 'utf8')) : '');
    let txt = read('.txt');
    let srt = read('.srt');
    let vtt = read('.vtt');
    // 3.5 重复幻觉后处理：whisper 在长音频/模糊音频上偶尔会把一句话重复输出多次（"说一遍变十遍"），
    //     这里合并时间上相邻、文本完全相同的段落（txt 按行去重；srt/vtt 解析 cue 去重后重新编号）
    // v0.9.5 文本整理（借鉴 microsoft/VibeVoice vllm_plugin/asr_streaming.py tidy_body 思路）：
    //   - 重复括号标签折叠：[笑声][笑声] → [笑声]（backreference 只折相同标签，[笑声][音乐] 不折）
    //   - CJK 相邻空格删除：「你 好」→「你好」（whisper 偶发在中文内插空格，英文不误伤）
    //   - 行内多空白收敛为单空格
    const CJK_RANGE = '\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef';
    const tidyText = (text) => String(text)
      .replace(/(\[[^\[\]]*\])(?:\s*\1)+/g, '$1')
      .replace(new RegExp(`(?<=[${CJK_RANGE}]) (?=[${CJK_RANGE}])`, 'g'), '')
      .split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n');
    const norm = (s) => String(s).replace(/[\s，。！？、,.!?;；：:…"'“”‘’()（）\[\]【】-]/g, '').toLowerCase();
    // 「A - A - A - A」或「A A A」整段同一词重复（whisper 对无语音段/模糊音频的典型幻觉）→ 收缩为单个
    const shrinkRepeatWords = (text) => {
      // 剥星号标记 + 只保留中日韩/字母数字（清掉 whisper 输出的 � 等噪音字节）
      const cleaned = String(text).replace(/^\s*\*+\s*/, '');
      const body = cleaned.replace(/[^\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]/g, '');
      // 整段为同一词（≥2 字符）重复 3 次以上 → 收缩为单个；1 字单元（哈哈哈/嗯嗯嗯）不动
      const m = body.length >= 6 ? body.match(/^(.{2,}?)\1{2,}$/) : null;
      if (m) return m[1];
      return text;
    };
    const dedupe = (() => {
      // srt/vtt 通用：解析 cue → 合并相邻相同 → 重新序列化
      // text 形如: "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n内容\n\n..." 或 srt 带序号
      function parseCues(text, isSrt) {
        const cues = [];
        const lines = String(text).split(/\r?\n/);
        let i = 0;
        while (i < lines.length) {
          const l = lines[i].trim();
          if (isSrt && /^\d+$/.test(l)) { i++; continue; } // srt 序号行
          if (/-->/.test(l)) {
            const time = l;
            const buf = [];
            i++;
            while (i < lines.length && lines[i].trim() !== '') { buf.push(lines[i]); i++; }
            cues.push({ time, text: buf.join('\n').trim() });
          } else i++;
        }
        return cues;
      }
      function norm(s) { return String(s).replace(/[\s，。！？、,.!?;；：:…"'“”‘’()（）\[\]【】-]/g, '').toLowerCase(); }
      function dedupeCues(cues, isSrt) {
        const out = [];
        let removed = 0;
        let shrunk = false;
        let tidied = false;
        for (const c of cues) {
          // 先收缩 cue 内重复词 + 文本整理，再判相邻重复
          const text = tidyText(shrinkRepeatWords(c.text));
          if (text !== c.text) { if (text.length < c.text.length) shrunk = true; else tidied = true; }
          const prev = out[out.length - 1];
          if (prev && norm(prev.text) !== '' && norm(prev.text) === norm(text)) {
            // 合并：保留前一条的起点 + 当前条的终点（时间轴连续），文本不变
            const mergedTime = mergeTime(prev.time, c.time);
            out[out.length - 1] = { time: mergedTime, text: prev.text };
            removed++;
          } else out.push({ time: c.time, text });
        }
        return { out, removed, shrunk };
      }
      function mergeTime(a, b) {
        // a/b 均形如 "HH:MM:SS,mmm --> HH:MM:SS,mmm"（srt）或 ".mmm"（vtt），分隔符同为 " --> "
        const start = String(a).split(' --> ')[0].trim();
        const end = String(b).split(' --> ')[1].trim();
        return start + ' --> ' + end;
      }
      function serialize(cues, isSrt, withHeader) {
        let out = withHeader ? 'WEBVTT\n\n' : '';
        cues.forEach((c, idx) => {
          if (isSrt) out += idx + 1 + '\n';
          out += c.time + '\n' + c.text + '\n\n';
        });
        return out;
      }
      return { parseCues, dedupeCues, serialize };
    })();
    if (srt) {
      const r = dedupe.dedupeCues(dedupe.parseCues(srt, true), true);
      // 有相邻去重或 cue 内收缩都重新序列化
      srt = r.removed || r.shrunk || r.tidied ? dedupe.serialize(r.out, true, false) : srt;
    }
    if (vtt) {
      const r = dedupe.dedupeCues(dedupe.parseCues(vtt, false), false);
      vtt = r.removed || r.shrunk || r.tidied ? dedupe.serialize(r.out, false, true) : vtt;
    }
    if (txt) {
      const tl = txt.split(/\r?\n/);
      const out = [];
      let changed = false;
      for (const l of tl) {
        const line = tidyText(shrinkRepeatWords(l)); // 收缩行内重复词幻觉（如「屁股 - 屁股 - 屁股」）+ 文本整理
        if (line !== l) changed = true;
        const prev = out[out.length - 1];
        if (prev && norm(prev) !== '' && norm(prev) === norm(line)) { changed = true; continue; }
        out.push(line);
      }
      if (changed) txt = out.join('\n');
    }
    // 4. 保留原始媒体供前端播放（字幕点击跳转）：移到 media/<taskId>/<taskId><ext>
    //    文件名用纯 ASCII（taskId 前缀），避免中文 URL 问题；原名已存在 task.fileName
    try {
      const ext = path.extname(task.fileName).toLowerCase() || '';
      const mediaDir = path.join(MEDIA_DIR, task.id);
      fs.mkdirSync(mediaDir, { recursive: true });
      const mediaPath = path.join(mediaDir, task.id + ext);
      // 重试场景：uploadPath 已是媒体文件（同路径），不重复 rename
      if (fs.existsSync(uploadPath) && path.resolve(uploadPath) !== path.resolve(mediaPath)) {
        await fs.promises.rename(uploadPath, mediaPath);
      }
      task.mediaUrl = '/media/' + task.id + '/' + task.id + ext;
      task.mediaType = /^(mp4|mkv|mov|avi|webm|flv|ts|m4v|wmv|3gp|ogv|mpg|mpeg)$/i.test(ext.slice(1)) ? 'video' : 'audio';
    } catch (e) {
      // 媒体保留失败不影响转写结果（仅失去播放联动）
      task.mediaUrl = null;
    }
    // 无语音判定：空文本，或全是 (小声)/(音乐)/(笑声) 类括号标记
    const bracketOnly = /^\s*[\[\(（][^\]\)）]*[\]\)）]\s*$/;
    // 重复词幻觉判定：whisper 对纯环境声常输出「屁股 - 屁股 - 屁股 …」这类一个词反复
    function isRepeatHallucination(text) {
      const cleaned = text.replace(/[\s\-–—,，。.、:：;；!！?？()（）\[\]【】*]/g, ' ').trim();
      const words = cleaned.split(/\s+/).filter(Boolean);
      if (words.length < 3) return false;
      return new Set(words).size === 1;
    }
    const lines = txt.trim().split(/\r?\n/).filter(Boolean);
    const noSpeech = !txt.trim() || (lines.length > 0 && lines.every((l) => bracketOnly.test(l))) || isRepeatHallucination(txt);
    task.status = 'done';
    task.result = { text: txt, srt, vtt, file: task.fileName, noSpeech, model: task.model, vad: !!task.useVad };
    task.elapsedSec = Math.round((Date.now() - (task.startAt || Date.now())) / 1000);
    // 5. 落盘：转写成品自动落到收件箱（可配置目录）
    persistToOutbox(task, txt, srt, vtt);
  } catch (e) {
    task.status = 'failed';
    task.error = e.message;
  } finally {
    // 重试所用的媒体交给统一的保留期清理；失败时只清理工作区临时输入。
    const inMedia = (p) => String(p).startsWith(MEDIA_DIR);
    if (task.status !== 'done' && task.uploadPath && !inMedia(task.uploadPath)) fs.promises.unlink(task.uploadPath).catch(() => {});
    for (const f of [wavPath, base + '.txt', base + '.srt', base + '.vtt']) {
      if (!inMedia(f)) fs.promises.unlink(f).catch(() => {});
    }
    // 链接任务：清理下载工作目录（成功时媒体已迁走，失败时清残留）
    if (task.sourceUrl) fs.promises.rm(path.join(UPLOAD_DIR, task.id), { recursive: true, force: true }).catch(() => {});
    task.finishedAt = Date.now();
    // v0.9：台账记录（无论成败，字幕秒出模式同样记）
    appendLedger(task);
  }
}

function pump() {
  while (running.length < CONCURRENCY && queue.length > 0) {
    const id = queue.shift();
    running.push(id);
    executeTask(tasks.get(id))
      .catch(() => {})
      .finally(() => {
        const i = running.indexOf(id);
        if (i >= 0) running.splice(i, 1);
        pump();
      });
  }
}

// full=true：详情接口返回完整 srt/vtt；列表接口默认裁剪大字段（30 任务 × 数百 KB 的 srt/vtt 会让 /api/tasks 变慢）
function publicTask(t, full) {
  const base = {
    id: t.id, status: t.status, progress: t.progress,
    error: t.error, result: null, file: t.fileName, baseName: t.baseName,
    sizeMB: t.sizeMB, model: t.model, createdAt: t.createdAt, elapsedSec: t.elapsedSec,
    mediaUrl: t.mediaUrl || null, mediaType: t.mediaType, useVad: !!t.useVad,
    platform: t.platform || null, durationSec: t.durationSec || null, sourceUrl: t.sourceUrl || null,
    outDir: t.outDir, outFiles: t.outFiles, outError: t.outError,
    hotwords: t.hotwords || null, hotwordsUsed: t.hotwordsUsed || null, hotwordsSkipped: t.hotwordsSkipped || null,
  };
  if (t.result) {
    const r = t.result;
    base.result = {
      file: r.file, noSpeech: r.noSpeech, model: r.model, vad: r.vad,
      text: r.text,
    };
    if (full) {
      base.result.srt = r.srt;
      base.result.vtt = r.vtt;
    } else {
      base.result._trimmed = true; // 前端展开时按需拉详情
    }
  }
  return base;
}

// ---------- 模型下载器（断点续传 + SHA256 尽力校验 + 单下载锁） ----------
let downloadJob = null; // { name, status, progress, speedMBs, error }
let downloadPromise = null;

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function fetchSha256(name) {
  return new Promise((resolve) => {
    https.get(`${HF_MIRROR}/${name}.sha256`, (res) => {
      if (res.statusCode !== 200) return resolve(null);
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => { const m = data.match(/[0-9a-fA-F]{64}/); resolve(m ? m[0] : null); });
    }).on('error', () => resolve(null));
  });
}

function downloadToPart(name) {
  return new Promise((resolve, reject) => {
    const dest = path.join(MODEL_DIR, name);
    const part = dest + '.part';
    const url = `${HF_MIRROR}/${name}`;
    // hf-mirror 链接是 302 重定向（Node https.get 不跟随），改用 curl：
    // -L 跟随重定向，-C - 断点续传（自动 Range），-f HTTP 错误时不写 body
    const p = spawn('curl', ['-L', '-C', '-', '-f', '-s', '-o', part, url], { cwd: ROOT });
    p.on('error', (e) => reject(new Error('无法启动 curl: ' + e.message)));
    p.on('close', (code) => (code === 0 ? resolve(part) : reject(new Error('下载失败，curl 退出码 ' + code))));
  });
}

function startDownload(name) {
  if (downloadPromise) return { started: false, reason: '已有模型正在下载' };
  if (!MODELS[name]) return { started: false, reason: '未知模型' };
  downloadJob = { name, status: 'downloading', progress: 0, speedMBs: 0, error: null };
  // 进度轮询：以 .part 文件大小估算（curl 静默下载，无内建进度回调）
  const totalBytes = MODELS[name].sizeMB * 1048576;
  const progTimer = setInterval(() => {
    if (!downloadJob || downloadJob.status !== 'downloading') return;
    try {
      const p = path.join(MODEL_DIR, name) + '.part';
      if (!fs.existsSync(p)) return;
      const size = fs.statSync(p).size;
      const now = Date.now();
      if (downloadJob._last) {
        const dt = (now - downloadJob._last.t) / 1000;
        if (dt > 0) downloadJob.speedMBs = (size - downloadJob._last.s) / dt / 1048576;
      }
      downloadJob._last = { t: now, s: size };
      downloadJob.progress = Math.min(99, Math.round((size / totalBytes) * 100));
    } catch {}
  }, 1000);
  downloadPromise = (async () => {
    try {
      const part = await downloadToPart(name);
      clearInterval(progTimer);
      const sha = await fetchSha256(name);
      if (sha) {
        const actual = await sha256File(part);
        if (actual.toLowerCase() !== sha.toLowerCase()) {
          fs.unlinkSync(part);
          throw new Error('SHA256 校验失败（已删除不完整文件），请重试');
        }
      }
      fs.renameSync(part, path.join(MODEL_DIR, name));
      downloadJob.status = 'done';
      downloadJob.progress = 100;
    } catch (e) {
      clearInterval(progTimer);
      if (downloadJob) { downloadJob.status = 'failed'; downloadJob.error = e.message; }
    } finally {
      downloadPromise = null;
    }
  })();
  return { started: true };
}

// ---------- API ----------
// multer/busboy 对非 ASCII 文件名按 latin1 解码导致中文名乱码，这里修复为 UTF-8
function fixOriginalName(name) {
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    // 修复后含中文（或常见 CJK 范围）才采用，避免破坏本就正确的名字
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(fixed)) return fixed;
  } catch {}
  return name;
}

// 清洗 Windows 非法文件名字符，并保留扩展名
function safeBaseName(name) {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_');
  return cleaned.replace(/\.[^.]+$/, '');
}

// ---------- 落盘：转写成品写到收件箱（四件套进「同名子文件夹」，重名自动加序号防覆盖） ----------
function persistToOutbox(task, txt, srt, vtt) {
  const dir = getOutDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try {
    const base = task.baseName && task.baseName.trim() ? task.baseName.trim() : '转写结果';
    // 重名处理：以「同名子文件夹」是否已存在为准，已存在则加 " (2)" / " (3)"…
    let stem = base;
    let i = 2;
    const subProbe = () => path.join(dir, stem);
    while (fs.existsSync(subProbe())) { stem = `${base} (${i++})`; }
    const sub = subProbe();
    fs.mkdirSync(sub, { recursive: true });
    const write = (ext, content) => fs.promises.writeFile(path.join(sub, stem + ext), content, 'utf8');
    // .txt 全文（空也不落空文件——无语音时 txt 留占位说明）；srt/vtt 非空才写
    write('.txt', txt || (task.result && task.result.noSpeech ? '（未检测到语音）' : ''));
    if (srt) write('.srt', srt);
    if (vtt) write('.vtt', vtt);
    const meta = {
      原名: task.fileName,
      平台: task.platform || (task.sourceUrl ? '直链' : '本地上传'),
      来源: (task && task.sourceUrl) ? task.sourceUrl : `本地上传 · ${task.fileName}`,
      模型: (task.result && task.result.model) || task.model,
      片长秒: task.durationSec || null,
      大小MB: task.sizeMB || null,
      转写用时秒: task.elapsedSec || 0,
      生成时间: new Date().toISOString(),
      字数: (txt || '').length,
      无语音: !!(task.result && task.result.noSpeech),
      热词生效: (task.hotwordsUsed && task.hotwordsUsed.length) ? task.hotwordsUsed.join('、') : '无',
      热词跳过: (task.hotwordsSkipped && task.hotwordsSkipped.length) ? task.hotwordsSkipped.join('、') : null,
    };
    write('.meta.json', JSON.stringify(meta, null, 2));
    const files = [`${stem}.txt`];
    if (srt) files.push(`${stem}.srt`);
    if (vtt) files.push(`${stem}.vtt`);
    files.push(`${stem}.meta.json`);
    task.outDir = dir;
    // outFiles 记录相对子文件夹的路径（前端下载走 Blob 不依赖此字段，仅台账/审计用）
    task.outFiles = files.map(f => path.join(stem, f));
  } catch (e) {
    // 落盘失败不影响转写结果（仅失去自动落盘能力）
    task.outDir = dir;
    task.outError = e.message;
  }
}

app.get('/api/config', (req, res) => {
  res.json({ outDir: getOutDir(), defaultOutDir: DEFAULT_OUT_DIR, hasSessdata: !!settings.biliSessdata, version: VERSION, platforms: platformsReady ? ['douyin', 'kuaishou'] : [] });
});

function isLauncher(req) {
  return !!LAUNCHER_TOKEN && req.socket.remoteAddress === '127.0.0.1'
    && req.get('Authorization') === 'Bearer ' + LAUNCHER_TOKEN;
}

function launcherBusy() {
  return !!(running.length || queue.length || uploads || downloadJob?.status === 'downloading' || vadDownloadPromise);
}

app.get('/api/launcher/status', (req, res) => {
  res.json({
    app: 'shiyin', version: VERSION, model: activeModel, outDir: getOutDir(),
    running: running.length, queued: queue.length, busy: launcherBusy(), managed: isLauncher(req),
  });
});

app.post('/api/launcher/stop', (req, res) => {
  if (!isLauncher(req)) return res.status(403).json({ error: '此服务未由当前启动器启动' });
  if (launcherBusy()) return res.status(409).json({ error: '正在处理文件或下载模型，完成后才能停止' });
  stopping = true;
  res.once('finish', () => {
    server.close();
    server.closeIdleConnections?.();
  });
  res.json({ ok: true });
});

// ---------- 设置（v0.7+）：输出目录 / B站 SESSDATA / AI 总结配置，持久化 settings.json，重启保留 ----------
app.get('/api/settings', (req, res) => {
  res.json({ outDir: getOutDir(), defaultOutDir: DEFAULT_OUT_DIR, envOutDir: process.env.SHIYIN_OUT_DIR || null, hasSessdata: !!settings.biliSessdata, hasAi: !!(settings.aiEndpoint && settings.aiKey), aiEndpoint: settings.aiEndpoint || null, aiModel: settings.aiModel || null, hotwords: (typeof settings.hotwords === 'string' && settings.hotwords.trim()) ? settings.hotwords : null, defaultHotwords: DEFAULT_HOTWORDS });
});
app.post('/api/settings', (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.outDir === 'string') {
      const d = body.outDir.trim();
      if (d) {
        if (!path.isAbsolute(d)) return res.status(400).json({ error: '请填写绝对路径（如 D:/xx/yy）' });
        try {
          fs.mkdirSync(d, { recursive: true });
          const probe = path.join(d, '.write-probe');
          fs.writeFileSync(probe, 'ok');
          fs.unlinkSync(probe);
        } catch { return res.status(400).json({ error: '目录不可写：' + d }); }
        settings.outDir = d;
      } else delete settings.outDir; // 空 = 恢复默认
    }
    if (typeof body.sessdata === 'string') {
      const s = body.sessdata.trim();
      if (s) settings.biliSessdata = s; else delete settings.biliSessdata;
    }
    // AI 总结（OpenAI 兼容端点；留空 = 保持不变/清除）
    if (typeof body.aiEndpoint === 'string') { const v = body.aiEndpoint.trim(); if (v) settings.aiEndpoint = v; else delete settings.aiEndpoint; }
    if (typeof body.aiKey === 'string') { const v = body.aiKey.trim(); if (v) settings.aiKey = v; else if (!body.aiEndpoint) delete settings.aiKey; }
    if (typeof body.aiModel === 'string') { const v = body.aiModel.trim(); if (v) settings.aiModel = v; else delete settings.aiModel; }
    if (typeof body.hotwords === 'string') { const v = body.hotwords.trim(); if (v) settings.hotwords = v; else delete settings.hotwords; }
    saveSettings();
    ensureOutDir();
    res.json({ ok: true, outDir: getOutDir(), hasSessdata: !!settings.biliSessdata, hasAi: !!(settings.aiEndpoint && settings.aiKey) });
  } catch (e) {
    res.status(400).json({ error: '保存失败：' + e.message });
  }
});

app.post('/api/transcribe', (req, res) => {
  uploads++;
  res.once('close', () => { uploads--; });
  upload.single('file')(req, res, (err) => {
    if (err) {
      // multer 错误（格式拒绝 / 超 2GB）→ 4xx 友好提示
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件超过 2GB 上限' : (err.message || '上传失败');
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: '没有收到文件' });
  const envMissing = [];
  if (!fs.existsSync(WHISPER)) envMissing.push('引擎缺失');
  if (!fs.existsSync(path.join(MODEL_DIR, activeModel))) envMissing.push(`模型未下载：${activeModel}`);
  if (envMissing.length) {
    fs.unlink(req.file.path, () => {});
    return res.status(500).json({ error: envMissing.join('；') });
  }
  const id = crypto.randomBytes(8).toString('hex');
  const origName = fixOriginalName(req.file.originalname || '未命名文件');
  const task = {
    id,
    status: 'queued',
    progress: 0,
    error: null,
    result: null,
    fileName: origName,
    baseName: safeBaseName(origName), // 供前端默认保存文件名（无扩展名）
    sizeMB: Math.round((req.file.size / 1048576) * 10) / 10,
    model: activeModel,
    uploadPath: req.file.path,
    useVad: !!(req.body && req.body.useVad),
    hotwords: (req.body && typeof req.body.hotwords === 'string') ? req.body.hotwords : null,
    startAt: Date.now(),
    createdAt: Date.now(),
  };
  tasks.set(id, task);
  queue.push(id);
  pump();
  res.json({ taskId: id });
  }); // upload.single 回调结束
}); // app.post 结束

// ---------- 链接识别入口：粘贴 URL → yt-dlp 下载 → 复用统一转写 ----------
app.post('/api/transcribe-url', (req, res) => {
  const raw = (req.body && req.body.url && String(req.body.url)) || '';
  const mm = raw.trim().match(/https?:\/\/[A-Za-z0-9\-._~:\/?#@!$&*+,;=%[\]]+/i);
  if (!mm) return res.status(400).json({ error: '未识别到链接（需包含 http(s):// 开头的网址）' });
  const url = mm[0].replace(/[),.;，。]+$/, '');

  if (!isBiliUrl(url) && !detectAdapter?.(url)
    && !fs.existsSync(FILE_YTDLP) && !fs.existsSync(path.join(YTDLP_PKG, 'yt_dlp', '__init__.py'))) {
    return res.status(500).json({ error: '下载器未就绪（yt-dlp 缺失），请先安装后再试' });
  }
  const envMissing = [];
  if (!fs.existsSync(WHISPER)) envMissing.push('引擎缺失');
  if (!fs.existsSync(path.join(MODEL_DIR, activeModel))) envMissing.push(`模型未下载：${activeModel}`);
  if (envMissing.length) return res.status(500).json({ error: envMissing.join('；') });
  const id = crypto.randomBytes(8).toString('hex');
  const task = {
    id,
    status: 'queued',
    progress: 0,
    error: null,
    result: null,
    fileName: url,
    baseName: '链接识别',
    sizeMB: null,
    model: activeModel,
    uploadPath: null,
    sourceUrl: url,
    useVad: !!(req.body && req.body.useVad),
    hotwords: (req.body && typeof req.body.hotwords === 'string') ? req.body.hotwords : null,
    startAt: Date.now(),
    createdAt: Date.now(),
  };
  tasks.set(id, task);
  queue.push(id);
  pump();
  res.json({ taskId: id });
});

app.get('/api/tasks', (req, res) => {
  const list = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map((t) => publicTask(t, false));
  res.json({ list, running: running.length, queueLen: queue.length });
});

app.get('/api/task/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  res.json(publicTask(t, true));
});

// 失败任务重试：原始媒体文件仍在保留期内（2 小时）则重新入队转写
app.post('/api/task/:id/retry', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  if (t.status !== 'failed') return res.status(400).json({ error: '只有失败的任务可以重试' });
  const ext = path.extname(t.fileName).toLowerCase() || '';
  const mediaPath = path.join(MEDIA_DIR, t.id, t.id + ext);
  // 本地任务需原始媒体在保留期内；链接任务（sourceUrl）失败时无本地媒体，重新走链接下载
  if (!t.sourceUrl && !fs.existsSync(mediaPath)) return res.status(400).json({ error: '原始音频已超过保留期（2 小时），请重新上传后再试' });
  t.status = 'queued';
  t.progress = 0;
  t.error = null;
  t.result = null;
  t.uploadPath = t.sourceUrl ? null : mediaPath; // 链接任务重新下载；本地任务复用保留的媒体文件（executeTask 会保护不删除）
  t.startAt = Date.now();
  queue.push(t.id);
  pump();
  res.json({ ok: true });
});

app.get('/api/models', (req, res) => {
  const list = Object.keys(MODELS).map((name) => {
    const p = path.join(MODEL_DIR, name);
    const downloaded = fs.existsSync(p);
    return {
      name, sizeMB: MODELS[name].sizeMB, desc: MODELS[name].desc,
      downloaded, active: name === activeModel,
      size: downloaded ? fs.statSync(p).size : 0,
    };
  });
  const vadPath = path.join(MODEL_DIR, VAD_MODEL);
  const vadDownloaded = fs.existsSync(vadPath);
  res.json({
    list, active: activeModel, download: downloadJob,
    vad: { name: VAD_MODEL, downloaded: vadDownloaded, size: vadDownloaded ? fs.statSync(vadPath).size : 0 },
  });
});

// ---------- VAD 模型下载（885KB，curl 单文件） ----------
let vadDownloadPromise = null;
app.post('/api/vad/download', (req, res) => {
  const vadPath = path.join(MODEL_DIR, VAD_MODEL);
  if (fs.existsSync(vadPath)) return res.json({ ok: true, already: true });
  if (vadDownloadPromise) return res.status(409).json({ error: 'VAD 模型正在下载' });
  const part = vadPath + '.part';
  const url = 'https://hf-mirror.com/ggml-org/whisper-vad/resolve/main/' + VAD_MODEL;
  vadDownloadPromise = new Promise((resolve, reject) => {
    const p = spawn('curl', ['-L', '-f', '-s', '-o', part, url], { cwd: ROOT });
    p.on('error', (e) => reject(new Error('无法启动 curl: ' + e.message)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('下载失败，curl 退出码 ' + code))));
  })
    .then(() => fs.promises.rename(part, vadPath))
    .catch((e) => { try { fs.unlinkSync(part); } catch {} throw e; })
    .finally(() => { vadDownloadPromise = null; });
  vadDownloadPromise.catch(() => {}); // 防未处理 rejection
  res.json({ ok: true });
});

// 台账查询（最近 20 条，供验证/前端后续扩展）
app.get('/api/ledger', (req, res) => {
  try {
    if (!fs.existsSync(LEDGER_FILE)) return res.json({ list: [], total: 0 });
    const lines = fs.readFileSync(LEDGER_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    const list = lines.slice(-20).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    res.json({ list, total: lines.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- v0.9.1 AI 总结：字幕/全文 → 摘要/要点/章节（OpenAI 兼容端点，默认关闭、用户自配 key） ----------
// 隐私提示：内容会发送到所填端点（出本机）；不配置时该功能不启用。
function aiSummarizeText(content, mode) {
  const ep = (settings.aiEndpoint || '').trim();
  const key = (settings.aiKey || '').trim();
  if (!ep || !key) return Promise.reject(new Error('未配置 AI 总结（设置 → AI 总结：端点 + Key）。内容默认不出本机'));
  if (!/^https?:\/\//.test(ep)) return Promise.reject(new Error('AI 端点需完整 URL（如 https://api.deepseek.com/chat/completions）'));
  const maxChars = 6000; // 中文约 1-1.5 token/字，6k 字内兼容多数 8k 上下文模型；超出截断并标注
  const cut = content.length > maxChars;
  const text = content.slice(0, maxChars);
  const system =
    '你是「拾音」的字幕总结助手。根据用户提供的视频字幕/全文，输出结构化中文结果，直接给内容不要客套。';
  const prompts = {
    summary: '请给出：① 一句话摘要（≤40 字）② 3~8 条要点（每条 ≤30 字，分条列出）。使用 Markdown 列表。',
    bullets: '请提炼 5~10 条要点（每条 ≤40 字），用 Markdown 无序列表。',
    chapters: '若输入含时间戳（SRT/VTT 风格），请按话题分章节：每节给「章节标题」+ 起止时间 + 2~3 句内容摘要；若不含时间戳则按内容自然分段并给出起始句摘录。使用 Markdown 标题。',
  };
  const user = `${prompts[mode] || prompts.summary}\n\n——字幕内容${cut ? '（过长已截断前 ' + maxChars + ' 字）' : ''}——\n${text}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  return fetch(ep, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: settings.aiModel || undefined,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.3,
    }),
    signal: controller.signal,
  }).then(async (r) => {
    clearTimeout(timer);
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error('AI 端点返回 ' + r.status + (txt ? '：' + txt.slice(0, 200) : ''));
    }
    const j = await r.json();
    const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!out) throw new Error('AI 返回格式异常（无 choices[0].message.content）');
    return out;
  }).catch((e) => {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('AI 请求超时（>90s）');
    throw e;
  });
}

app.post('/api/summarize', (req, res) => {
  const task = tasks.get((req.body || {}).taskId || '');
  if (!task || !task.result) return res.status(404).json({ error: '任务不存在或尚无结果，请先展开任务' });
  const mode = ['summary', 'bullets', 'chapters'].includes((req.body || {}).mode) ? req.body.mode : 'summary';
  const r = task.result;
  // 章节模式优先 SRT（含时间戳）；其余用全文
  const content = mode === 'chapters' && r.srt ? r.srt : (r.text || r.srt || '');
  if (!content.trim()) return res.status(400).json({ error: '任务没有可总结的文本' });
  aiSummarizeText(content, mode).then((out) => {
    res.json({ ok: true, mode, text: out, chars: content.length });
  }).catch((e) => {
    res.status(400).json({ error: e.message });
  });
});

function isActiveTask(id) {
  const task = tasks.get(id);
  return task && task.status !== 'done' && task.status !== 'failed';
}

function removeTaskMedia(id) {
  const dir = path.join(MEDIA_DIR, id);
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && path.parse(entry.name).name === id && MEDIA_EXT_RE.test(entry.name)) {
        fs.rmSync(path.join(dir, entry.name), { force: true });
      }
    }
    try { fs.rmdirSync(dir); } catch (e) { if (e.code !== 'ENOTEMPTY' && e.code !== 'ENOENT') throw e; }
  }
  const task = tasks.get(id);
  if (task) task.mediaUrl = null;
}

app.delete('/api/task/:id/media', (req, res) => {
  const id = req.params.id;
  if (!TASK_ID_RE.test(id)) return res.status(400).json({ error: '无效的任务编号' });
  if (isActiveTask(id)) return res.status(409).json({ error: '任务正在处理中，请稍后再清理媒体' });
  try {
    removeTaskMedia(id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: '媒体清理失败，请关闭播放器后重试' });
  }
});

// 删除任务：移除内存任务和缓存媒体，保留落盘结果。
app.delete('/api/task/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.json({ ok: true, gone: true });
  if (isActiveTask(t.id)) return res.status(409).json({ error: '任务正在处理中，请稍后再删除' });
  try {
    removeTaskMedia(t.id);
    tasks.delete(t.id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: '任务删除失败，请关闭播放器后重试' });
  }
});

// 媒体文件静态服务（express.static 自带 Range 支持，播放器 seek 可用）
app.use('/media', express.static(MEDIA_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

app.post('/api/models/use', (req, res) => {
  const name = req.body && req.body.name;
  if (!MODELS[name]) return res.status(400).json({ error: '未知模型' });
  if (!fs.existsSync(path.join(MODEL_DIR, name))) return res.status(400).json({ error: '该模型未下载' });
  activeModel = name;
  try { fs.writeFileSync(ACTIVE_FILE, name, 'utf8'); } catch {}
  res.json({ ok: true, active: activeModel });
});

app.post('/api/models/download', (req, res) => {
  const name = req.body && req.body.name;
  if (!MODELS[name]) return res.status(400).json({ error: '未知模型' });
  if (fs.existsSync(path.join(MODEL_DIR, name))) return res.json({ ok: true, already: true });
  const r = startDownload(name);
  if (!r.started) return res.status(409).json({ error: r.reason });
  res.json({ ok: true });
});

// 从磁盘识别过期缓存，覆盖服务重启前留下的媒体和下载残留。
function cleanupTaskCache() {
  const now = Date.now();
  for (const root of [MEDIA_DIR, UPLOAD_DIR, WORK]) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const id = root === WORK
        ? (entry.isFile() && /^([a-f0-9]{16})\.wav$/.exec(entry.name)?.[1])
        : (entry.isDirectory() && TASK_ID_RE.test(entry.name) && entry.name);
      if (!id || isActiveTask(id)) continue;
      const target = path.join(root, entry.name);
      try {
        if (now - fs.statSync(target).mtimeMs < MEDIA_RETENTION_MS) continue;
        if (root === MEDIA_DIR) removeTaskMedia(id);
        else fs.rmSync(target, { recursive: root === UPLOAD_DIR, force: true });
      } catch { /* 文件占用等情况在下次清理时重试。 */ }
    }
  }
  for (const [id, t] of tasks) {
    if (t.finishedAt && !isActiveTask(id) && now - t.finishedAt >= MEDIA_RETENTION_MS) tasks.delete(id);
  }
}
cleanupTaskCache();
setInterval(cleanupTaskCache, 600_000).unref();

const server = app.listen(PORT, HOST, () => {
  console.log(`拾音 v${VERSION} 已启动: http://${HOST}:${PORT}`);
  console.log(`  收件箱（落盘目录）: ${getOutDir()}`);
  console.log(`  多平台适配器: ${platformsReady ? '✅ 抖音/快手已就绪' : '❌ 未就绪（playwright-core 缺失）'}`);
  console.log(`  yt-dlp 链接下载器: ${fs.existsSync(path.join(YTDLP_PKG, 'yt_dlp', '__init__.py')) || fs.existsSync(FILE_YTDLP) ? '✅ 就绪' : '❌ 缺失（链接识别不可用）'}`);
  const vadPath = path.join(MODEL_DIR, VAD_MODEL);
  console.log(`  VAD 静音检测: ${fs.existsSync(vadPath) ? '✅ 已就绪' : '❌ 未下载（面板可一键下载）'}`);
  for (const name of Object.keys(MODELS)) {
    const p = path.join(MODEL_DIR, name);
    console.log(`  模型 ${name}: ${fs.existsSync(p) ? '✅ 已就绪' : '❌ 未下载'}${name === activeModel ? '（当前）' : ''}`);
  }
  if (!fs.existsSync(WHISPER)) console.log('  ⚠️ 引擎缺失: ' + WHISPER);
});
