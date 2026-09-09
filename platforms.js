/**
 * platforms.js — 多平台下载适配器（v0.9.0 新增）
 *
 * 设计：插件式注册表。新增平台 = 在 ADAPTERS 里加一个 { id, label, test, download }，
 *       其余（识别 → 下载 → 统一转写落盘）零改动。
 *
 * 现状（2026-09-04 实测勘察，详见《视频蒸馏-多平台下载优化-计划与思路-2026-09-04》）：
 *  - 抖音：web API 需 a_bogus JS 签名（匿名 200 空 body），桌面/分享页 SSR 无水印数据，
 *           yt-dlp DouyinIE 半废 → 唯一稳路 = 真实浏览器代下载（headless 系统 Edge 打开视频页，
 *           点击触发播放，轮询 video.currentSrc 拿带签名真源直链，立即下载）。
 *  - 快手：yt-dlp 无 Kuaishou 提取器；short-video 页是 SPA 壳；
 *           m.gifshow.com/fw/photo/{id}（手机 UA）仍 SSR 内嵌 backupUrl 无水印 mp4 直链 → 纯 HTTP 可解。
 *
 * 红线：不翻墙（两平台国内可达）；不逆向签名（抖音用浏览器本身完成）；不破验证码；
 *       直链带签名有有效期 → 拿到即下、带 Referer。
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const REDIRECT_MAX = 5;

// ---------- 通用 HTTP 工具 ----------

// 跟随重定向 GET，返回 { status, headers, body }（小响应，页面类）
function httpGet(url, { ua = DESKTOP_UA, referer = null, timeout = 20000, maxRedirect = REDIRECT_MAX } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const headers = { 'User-Agent': ua, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' };
    if (referer) headers.Referer = referer;
    const req = lib.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirect > 0) {
        res.resume();
        const loc = res.headers.location;
        const next = loc.startsWith('//') ? (url.startsWith('https') ? 'https:' : 'http:') + loc
          : /^https?:/i.test(loc) ? loc : new URL(loc, url).href;
        return resolve(httpGet(next, { ua, referer, timeout, maxRedirect: maxRedirect - 1 }));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => reject(new Error('网络请求失败：' + e.message)));
  });
}

// 流式下载大文件（视频）到本地，跟随重定向
function httpDownload(url, dest, { ua = DESKTOP_UA, referer = null, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const headers = { 'User-Agent': ua, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' };
    if (referer) headers.Referer = referer;
    const req = lib.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpDownload(res.headers.location, dest, { ua, referer, timeout }));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error('下载失败 HTTP ' + res.statusCode));
      }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => { const size = fs.statSync(dest).size; f.close(); resolve(size); });
      f.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('下载超时')));
    req.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
  });
}

// ---------- URL 归一化 ----------

const RE_DOUYIN_VIDEO = /(?:douyin\.com\/video\/|iesdouyin\.com\/share\/video\/|m\.douyin\.com\/share\/video\/|douyin\.com\/note\/)(\d+)/i;
const RE_KUAISHOU_ID = /kuaishou\.com\/short-video\/([\w]+)|gifshow\.com\/(?:fw\/)?photo\/([\w]+)/i;

async function douyinPageUrl(raw) {
  let u = String(raw).trim();
  if (/^https?:\/\/(?:v|www|m)\.douyin\.com\//i.test(u) && !RE_DOUYIN_VIDEO.test(u)) {
    // 短链（v.douyin.com/xxx）或其它形态：跟随重定向展开，最多 5 跳
    try {
      const r = await httpGet(u, { referer: 'https://www.douyin.com/' });
      if (r.headers.location) u = r.headers.location;
      else if (r.status === 200) u = r.headers['x-final-url'] || u;
    } catch {}
  }
  const m = String(u).match(RE_DOUYIN_VIDEO);
  if (!m) throw new Error('无法解析抖音链接（仅支持 douyin.com/video/{id}、分享页、v.douyin.com 短链）');
  return { id: m[1], pageUrl: `https://www.douyin.com/video/${m[1]}` };
}

async function kuaishouId(raw) {
  let u = String(raw).trim();
  // v.kuaishou.com 短链 → 展开拿真实 id
  if (/v\.kuaishou\.com/i.test(u) && !RE_KUAISHOU_ID.test(u)) {
    try {
      const r = await httpGet(u, { referer: 'https://www.kuaishou.com/' });
      u = r.headers.location || u;
    } catch {}
  }
  const m = String(u).match(RE_KUAISHOU_ID);
  if (!m) throw new Error('无法解析快手链接（仅支持 v.kuaishou.com 短链、kuaishou.com/short-video/{id}）');
  return m[1] || m[2];
}

// ---------- 标题清洗 ----------

// 抖音页面 title 常形如 "https://ww.douyin.com/video/7 #话题#话题 描述 - 抖音"（URL 可能带或不带协议头、www/ww/m 前缀），剥 URL 前缀 + 话题 + 站名后缀
function cleanDouyinTitle(title, id) {
  let t = String(title || '')
    .replace(/^https?:\/\/[^\s]+?\s*/i, '')                       // 带协议的 URL 前缀
    .replace(/^(?:www|ww|m)\.douyin\.com\/[^\s#]*/i, '')          // 无协议的 URL 前缀（ww.douyin.com/video/7 形态）
    .replace(/\s*[-–—|]\s*抖音\s*$/i, '')                            // - 抖音 后缀
    .replace(/^抖音\s*$/, '')
    .trim();
  // 话题标签（#xxx）统一剥掉，避免文件名过载
  t = t.replace(/#[^\s#]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) t = `抖音视频_${id}`;
  return t.slice(0, 60);
}

// 快手 H5 页抓 og:title / description
function extractKsTitle(body, id) {
  let t = '';
  const og = body.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (og) t = og[1];
  if (!t) {
    const d = body.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if (d) t = d[1];
  }
  t = String(t).replace(/快手/g, '').replace(/[-\s]+$/, '').trim();
  return t ? t.slice(0, 60) : `快手视频_${id}`;
}

// ---------- 抖音适配器（浏览器代下载） ----------

let browserPromise = null; // 单例浏览器（复用进程，每任务新 context 保干净）
let dyChain = Promise.resolve(); // 串行互斥：同一时刻最多 1 个浏览器下载任务

async function getEdge() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ channel: 'msedge', headless: true })
      .catch((e) => { browserPromise = null; throw new Error('无法启动 Edge（抖音下载依赖系统 Edge 浏览器，请确认已安装）：' + String(e.message).slice(0, 120)); });
  }
  return browserPromise;
}

// 打开抖音视频页 → 点击触发播放 → 轮询真源直链（排除 uuu_265 占位引导动画）
// 2026-09-05 适配：抖音网页播放器已改走 MSE 流（video.src = blob:，不再暴露 http 直链），
// 真源改为在网络层嗅探 douyinvod.com 的音/视频分片流（media-audio-* 纯音频优先，体积小）；老版 http 直链保留为 fallback
async function grabDouyinSrc(pageUrl) {
  const browser = await getEdge();
  const ctx = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  try {
    // MSE 网络层嗅探：捕获 douyinvod 真实媒体分片流（带签名，有时效，拿到即下）
    const netMedia = { audio: '', video: '' };
    const sniff = (req) => {
      if (netMedia.audio && netMedia.video) return;
      const u = req.url();
      if (/uuu_265/.test(u)) return; // 占位引导动画
      if (!/douyinvod\.com\//.test(u) || !/\/video\/tos\//.test(u)) return;
      if (!netMedia.audio && /media-audio-/.test(u)) netMedia.audio = u;
      else if (!netMedia.video && /media-video-/.test(u)) netMedia.video = u;
    };
    page.on('request', sniff);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('video', { timeout: 12000 }).catch(() => null);
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return;
      const r = v.getBoundingClientRect();
      const el = document.elementFromPoint(
        Math.min(r.x + r.width / 2, window.innerWidth - 5),
        Math.min(r.y + r.height / 2, window.innerHeight - 5)
      );
      if (el) { el.click(); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      if (v.play) v.play().catch(() => {});
    }).catch(() => {});
    let src = '';
    const title = await page.title().catch(() => '');
    for (let i = 0; i < 14; i++) { // ≤ ~21s：等老版 http 直链 或 MSE 网络层嗅探命中
      await page.waitForTimeout(1500);
      src = await page.evaluate(() => {
        const v = document.querySelector('video');
        return v ? (v.currentSrc || v.src || '') : '';
      }).catch(() => '');
      if (src && !/uuu_265/.test(src) && /^https?:/.test(src) && !src.startsWith('blob:')) break; // 老版直链
      if (netMedia.audio || netMedia.video) break; // MSE 新版已嗅探到真实分片流
    }
    const finalSrc = netMedia.audio || netMedia.video || src;
    if (!finalSrc || /uuu_265/.test(finalSrc) || finalSrc.startsWith('blob:')) {
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 800)).catch(() => '');
      if (/验证码|安全验证|拖动|滑块/.test(bodyText)) throw new Error('抖音风控拦截（验证码/需登录）。请稍后重试，或手动下载后走「本地上传」');
      if (/视频不见了|作品已删除|内容不存在|该视频已删除|违规/.test(bodyText)) throw new Error('抖音视频不存在或已删除');
      if (/登录后观看|扫码登录|打开抖音/.test(bodyText)) throw new Error('抖音要求登录后观看（视频可能为私密/粉丝可见），或手动下载后走「本地上传」');
      throw new Error('抖音视频源获取超时（视频可能不存在/已删除，或需登录后观看）');
    }
    return { src: finalSrc, title };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function douyinDownload(task, destDir) {
  const { id, pageUrl } = await douyinPageUrl(task.sourceUrl);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'dl.mp4');
  const run = dyChain.then(() => grabDouyinSrc(pageUrl));
  dyChain = run.then(() => {}, () => {}); // 无论成败释放锁
  const { src, title } = await run;
  // 真源带签名有有效期：拿到即下，带 Referer
  const size = await httpDownload(src, dest, { ua: DESKTOP_UA, referer: pageUrl, timeout: 180000 });
  if (size < 1024) { try { fs.unlinkSync(dest); } catch {} throw new Error('抖音视频下载结果异常（过小），请重试'); }
  return { dlPath: dest, title: cleanDouyinTitle(title, id), sizeMB: Math.round((size / 1048576) * 10) / 10 };
}

// ---------- 快手适配器（H5 直取，零浏览器依赖） ----------

async function kuaishouDownload(task, destDir) {
  const id = await kuaishouId(task.sourceUrl);
  fs.mkdirSync(destDir, { recursive: true });
  const h5 = `https://m.gifshow.com/fw/photo/${id}`;
  const r = await httpGet(h5, { ua: MOBILE_UA, referer: 'https://www.kuaishou.com/' });
  if (r.status !== 200) throw new Error('快手页面请求失败 HTTP ' + r.status);
  // SSR JSON 内嵌 backupUrl（无水印 mp4 直链）；backupUrl 数组首元素 + 后向 700 字符内 qualityLabel
  const urls = [];
  const re = /"backupUrl":\["([^"]+\.mp4\?[^"]+)"[\s\S]{0,700}?"qualityLabel":"([^"]+)"/g;
  let m;
  while ((m = re.exec(r.body))) urls.push({ url: m[1].replace(/\\u002F/g, '/'), q: m[2] });
  if (!urls.length) {
    if (/不存在|已删除|Page Not Found/i.test(r.body) || r.body.length < 10000) throw new Error('快手视频不存在或已删除');
    throw new Error('快手视频解析失败（页面结构可能已改版），可稍后重试或手动下载后走「本地上传」');
  }
  const pick = urls.sort((a, b) => (b.q.includes('高清') || b.q.includes('超清')) - (a.q.includes('高清') || a.q.includes('超清')))[0];
  const dest = path.join(destDir, 'dl.mp4');
  const size = await httpDownload(pick.url, dest, { ua: MOBILE_UA, referer: h5, timeout: 180000 });
  if (size < 1024) { try { fs.unlinkSync(dest); } catch {} throw new Error('快手视频下载结果异常（过小），请重试'); }
  return { dlPath: dest, title: extractKsTitle(r.body, id), sizeMB: Math.round((size / 1048576) * 10) / 10 };
}

// ---------- 注册表 ----------

const ADAPTERS = {
  douyin: {
    id: 'douyin', label: '抖音',
    test: (url) => /(^|\.)douyin\.com|iesdouyin\.com/i.test(url || ''),
    download: douyinDownload,
  },
  kuaishou: {
    id: 'kuaishou', label: '快手',
    test: (url) => /kuaishou\.com|gifshow\.com/i.test(url || ''),
    download: kuaishouDownload,
  },
};

function detectAdapter(url) {
  for (const k of Object.keys(ADAPTERS)) {
    if (ADAPTERS[k].test(url)) return ADAPTERS[k];
  }
  return null;
}

module.exports = { ADAPTERS, detectAdapter, httpGet, httpDownload };
