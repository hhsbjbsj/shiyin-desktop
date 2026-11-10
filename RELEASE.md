# 桌面版发布与更新

当前桌面版为 v1.1.0，维护仓库为 https://github.com/hhsbjbsj/shiyin-desktop 。

首次安装下载 Shiyin-win-x64.zip 并解压，运行 ShiyinLauncher.exe。包内包含 Node.js 和 .NET 桌面运行时。首次启动会从固定版本的官方 Release 下载缺少的 Whisper CPU 引擎、FFmpeg 和 yt-dlp，并核对 SHA-256。识别模型在网页中按需下载。已有 GPU 引擎继续使用已有文件。

后续更新在启动器点「检查更新」，确认后下载正式 Release 的 Windows 包。应用核对 GitHub 提供的 SHA-256、版本和包内容，空闲时停止服务，更换应用文件并恢复服务。安装失败会尝试回退。识别引擎、模型、设置、缓存和导出结果位于应用更新清单之外。

维护者发布新版时修改 package.json 和 package-lock.json 的版本，提交到 main，再创建并推送对应标签。

```powershell
git add .
git commit -m "release: v1.1.1"
git push origin main
git tag v1.1.1
git push origin v1.1.1
```

GitHub Actions 的 Windows release 工作流会验证版本、构建桌面包并上传正式 Release。新版本需要高于已安装版本。请在 Release 工作流完成后再通知用户更新。可用 pwsh -File scripts/package-windows.ps1 在 Windows 本地预先构建。

桌面包与源码目录建议分开，避免应用内更新覆盖尚未提交的开发修改。Windows 包尚未做代码签名。

---
# 发布指南 · Release

发布新版本的完整流程（维护者用）。

## 版本号

遵循语义化版本：`vMAJOR.MINOR.PATCH`

- MAJOR：不兼容的重大变更
- MINOR：新增功能（向后兼容）
- PATCH：Bug 修复

## 发布步骤

1. **更新文档**
   - `CHANGELOG.md` 增加 `[x.y.z] - 日期` 条目
   - 同步 `README.md` / `README.en.md` / `README.txt` 中的版本号与功能描述
   - 如涉及模型/API 变化，同步 `package.json` 版本号

2. **运行全量自检**
   ```bash
   node --check server.js
   node --check scripts/render-icon.js
   node --check scripts/build-ico.js
   ```

3. **功能实测**
   - 启动服务（`npm start`），浏览器访问 `http://127.0.0.1:18900`
   - 上传一段测试音频，确认转写全流程（上传 → 识别 → 三格式输出 → 编辑保存）通过
   - 确认图标与 PWA 缓存版本号（`service-worker.js` 的 `CACHE` 与 `index.html` 的 `favicon ?v=N`）已同步

4. **提交并打标签**
   ```bash
   git add -A
   git commit -m "release: vX.X.X"
   git tag vX.X.X
   git push origin main --tags
   ```

5. **发布 GitHub Release**
   - 标题：`vX.X.X`
   - 内容：摘要本次变更（可引用 CHANGELOG）
   - 附件：源码 zip（或便携包，如已构建）

## 图标发布检查清单（重要）

图标变更后，以下五处必须同步，否则用户端仍显示旧图标：

| 位置 | 说明 |
|---|---|
| `public/app-icon*.png/ico` | 实际图标文件 |
| `public/service-worker.js` | `CACHE` 版本号 bump（如 `shiyin-v5`） |
| `public/index.html` | `favicon link ?v=N` 版本号 bump |
| `public/manifest.json` | 图标路径与主题色核对 |
| `安装到桌面.bat` | 已含 `ie4uinit.exe -show` 刷新 Windows 图标缓存 |

PWA 已固定的图标需**取消固定再重新固定**才会换新。
