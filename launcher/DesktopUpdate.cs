using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;

namespace ShiyinLauncher;

internal sealed record DesktopRelease(Version Version, Uri Url, byte[] Sha256, long Size);

internal static class DesktopUpdate
{
    private const string Repository = "hhsbjbsj/shiyin-desktop";
    internal const string AssetName = "Shiyin-win-x64.zip";
    private const string LauncherName = "ShiyinLauncher.exe";
    private const string StagePrefix = ".shiyin-update-";
    private const long MaxArchiveSize = 300L * 1024 * 1024;
    private static readonly string[] AppFiles = [
        "server.js", "platforms.js", "package.json", "package-lock.json", "public", "node_modules",
        "node.exe", "Node-LICENSE.txt", "Dotnet-LICENSE.txt", "LICENSE", "THIRD-PARTY-NOTICES.txt", "setup-tools.ps1", LauncherName,
    ];
    private static readonly HttpClient Http = new() { MaxResponseContentBufferSize = 1024 * 1024 };
    internal static readonly Version CurrentVersion = Assembly.GetExecutingAssembly().GetName().Version!;
    private static string Root => Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory);

    internal static async Task<DesktopRelease?> CheckAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{Repository}/releases/latest");
        request.Headers.UserAgent.ParseAdd($"Shiyin/{CurrentVersion.ToString(3)}");
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        using var response = await Http.SendAsync(request, timeout.Token);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"暂时无法检查 GitHub 更新（HTTP {(int)response.StatusCode}）。");

        using var release = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(timeout.Token));
        var tag = release.RootElement.GetProperty("tag_name").GetString();
        if (tag is null || !Regex.IsMatch(tag, @"\Av\d+\.\d+\.\d+\z") || !Version.TryParse(tag[1..], out var version))
            throw new InvalidDataException("GitHub 发布版本格式无效。");
        if (version <= new Version(CurrentVersion.Major, CurrentVersion.Minor, CurrentVersion.Build)) return null;

        var url = new Uri($"https://github.com/{Repository}/releases/download/{tag}/{AssetName}");
        foreach (var asset in release.RootElement.GetProperty("assets").EnumerateArray())
        {
            if (asset.GetProperty("name").GetString() != AssetName) continue;
            var size = asset.GetProperty("size").GetInt64();
            if (size <= 0 || size > MaxArchiveSize || asset.GetProperty("state").GetString() != "uploaded"
                || !asset.TryGetProperty("digest", out var digestValue) || digestValue.GetString() is not { } digest
                || !Regex.IsMatch(digest, @"\Asha256:[a-fA-F0-9]{64}\z")) break;
            return new(version, url, Convert.FromHexString(digest[7..]), size);
        }
        throw new InvalidDataException("新版尚未提供可校验的 Windows 更新包。");
    }

    internal static async Task<string> StageAsync(DesktopRelease release)
    {
        var stage = Path.Combine(Root, StagePrefix + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        try
        {
            var zipPath = Path.Combine(stage, AssetName);
            using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(15));
            using (var response = await Http.GetAsync(release.Url, HttpCompletionOption.ResponseHeadersRead, timeout.Token))
            {
                if (!response.IsSuccessStatusCode)
                    throw new HttpRequestException($"GitHub 更新包下载失败（HTTP {(int)response.StatusCode}）。");
                await using var input = await response.Content.ReadAsStreamAsync(timeout.Token);
                await using var output = File.Create(zipPath);
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var buffer = new byte[128 * 1024];
                long received = 0;
                int count;
                while ((count = await input.ReadAsync(buffer, timeout.Token)) != 0)
                {
                    received += count;
                    if (received > release.Size) throw new InvalidDataException("下载的更新包大小不正确。");
                    hash.AppendData(buffer, 0, count);
                    await output.WriteAsync(buffer.AsMemory(0, count), timeout.Token);
                }
                if (received != release.Size || !hash.GetHashAndReset().AsSpan().SequenceEqual(release.Sha256))
                    throw new InvalidDataException("更新包校验失败，请重新下载。");
            }

            await Task.Run(() => Extract(zipPath, Path.Combine(stage, "payload"), release.Version));
            File.Delete(zipPath);
            return stage;
        }
        catch
        {
            DiscardStage(stage);
            throw;
        }
    }

    private static void Extract(string zipPath, string payload, Version version)
    {
        using var archive = ZipFile.OpenRead(zipPath);
        long expandedSize = 0;
        foreach (var entry in archive.Entries)
        {
            var parts = entry.FullName.Replace('\\', '/').TrimEnd('/').Split('/');
            expandedSize += entry.Length;
            if (expandedSize > 1024L * 1024 * 1024 || !AppFiles.Contains(parts[0], StringComparer.Ordinal)
                || parts.Any(p => p.Length == 0 || p is "." or ".." || p.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                || (parts.Length > 1 && parts[0] is not ("public" or "node_modules")))
                throw new InvalidDataException("更新包包含无法安装的文件。");
        }
        archive.ExtractToDirectory(payload);
        CheckPayload(payload);
        using var package = JsonDocument.Parse(File.ReadAllText(Path.Combine(payload, "package.json")));
        if (package.RootElement.GetProperty("version").GetString() != version.ToString(3))
            throw new InvalidDataException("更新包里的版本与发布版本不符。");
    }

    private static void CheckPayload(string payload)
    {
        foreach (var item in AppFiles)
        {
            var path = Path.Combine(payload, item);
            if (!(item is "public" or "node_modules" ? Directory.Exists(path) : File.Exists(path)))
                throw new InvalidDataException($"更新包缺少 {item}。");
        }
    }

    internal static void StartHelper(string stage, bool restart)
    {
        var helper = Path.Combine(stage, "ShiyinUpdate.exe");
        File.Copy(Path.Combine(Root, LauncherName), helper);
        Start(helper, "--apply-update", Environment.ProcessId.ToString(), restart ? "1" : "0");
    }

    private static void Start(string executable, params string[] args)
    {
        var info = new ProcessStartInfo(executable) { WorkingDirectory = Path.GetDirectoryName(executable)!, UseShellExecute = false };
        foreach (var arg in args) info.ArgumentList.Add(arg);
        using var process = Process.Start(info) ?? throw new InvalidOperationException("无法启动拾音更新程序。");
    }

    internal static int Apply(int previousId, bool restart)
    {
        var stage = Root;
        if (!IsStageName(Path.GetFileName(stage))) return 1;
        var root = Path.GetDirectoryName(stage)!;
        var payload = Path.Combine(stage, "payload");
        var backup = Path.Combine(stage, "backup");
        var installed = new Stack<string>();
        var backedUp = new Stack<string>();
        var launcher = Path.Combine(root, LauncherName);
        FileStream? updateLock = null;
        try
        {
            using (var previous = FindProcess(previousId))
                if (previous is not null && !previous.WaitForExit(15000)) throw new IOException("旧版启动器尚未退出。");
            updateLock = new FileStream(Path.Combine(root, ".shiyin-update.lock"), FileMode.OpenOrCreate,
                FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose);
            CheckPayload(payload);
            Directory.CreateDirectory(backup);
            foreach (var item in AppFiles)
            {
                var target = Path.Combine(root, item);
                if (File.Exists(target) || Directory.Exists(target))
                {
                    Move(target, Path.Combine(backup, item));
                    backedUp.Push(item);
                }
                Move(Path.Combine(payload, item), target);
                installed.Push(item);
            }
            Start(launcher, "--updated", restart ? "1" : "0", Path.GetFileName(stage), Environment.ProcessId.ToString());
            return 0;
        }
        catch (Exception e)
        {
            try
            {
                foreach (var item in installed) Move(Path.Combine(root, item), Path.Combine(payload, item));
                foreach (var item in backedUp) Move(Path.Combine(backup, item), Path.Combine(root, item));
                MessageBox.Show($"更新未安装，已保留原版。\n{e.Message}", "拾音更新", MessageBoxButton.OK, MessageBoxImage.Warning);
                if (updateLock is not null) Start(launcher, restart ? ["--resume-service"] : []);
            }
            catch (Exception rollbackError)
            {
                MessageBox.Show($"无法恢复启动器。备份保留在 {backup}。\n{rollbackError.Message}", "拾音更新", MessageBoxButton.OK, MessageBoxImage.Error);
            }
            return 1;
        }
        finally { updateLock?.Dispose(); }
    }

    private static void Move(string from, string to)
    {
        if (Directory.Exists(from)) Directory.Move(from, to);
        else File.Move(from, to);
    }

    private static Process? FindProcess(int id)
    {
        try { return Process.GetProcessById(id); }
        catch (ArgumentException) { return null; }
    }

    private static bool IsStageName(string name) =>
        name.StartsWith(StagePrefix, StringComparison.Ordinal) && Guid.TryParseExact(name[StagePrefix.Length..], "N", out _);

    internal static void DiscardStage(string stage)
    {
        try { Directory.Delete(stage, recursive: true); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    internal static async Task CleanupAsync(string name, int helperId)
    {
        if (!IsStageName(name)) return;
        using var helper = FindProcess(helperId);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try
        {
            if (helper is not null) await helper.WaitForExitAsync(timeout.Token);
            DiscardStage(Path.Combine(Root, name));
        }
        catch (OperationCanceledException) { }
    }
}
