using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ShiyinLauncher;

internal enum ServiceMode { Offline, Ready, Occupied }

internal sealed record ServiceStatus(
    string? App, string? Version, string? Model, string? OutDir,
    int Running, int Queued, bool Busy, bool Managed);

internal sealed record ServiceState(ServiceMode Mode, ServiceStatus? Status = null);

internal sealed class LocalService
{
    public const string Address = "http://127.0.0.1:18900";
    private readonly string root = Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory);
    private readonly HttpClient http = new(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
    {
        BaseAddress = new Uri(Address),
        Timeout = TimeSpan.FromSeconds(3),
        MaxResponseContentBufferSize = 64 * 1024,
    };

    private string TokenPath
    {
        get
        {
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(root.ToUpperInvariant()));
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Shiyin", Convert.ToHexString(hash)[..20] + ".token");
        }
    }

    private string? ReadToken()
    {
        var path = TokenPath;
        if (!File.Exists(path)) return null;
        var token = File.ReadAllText(path).Trim();
        return token.Length == 64 && token.All(Uri.IsHexDigit) ? token : null;
    }

    private string EnsureToken()
    {
        var existing = ReadToken();
        if (existing is not null) return existing;

        var path = TokenPath;
        var folder = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(folder);
        var temp = Path.Combine(folder, Path.GetRandomFileName());
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        try
        {
            File.WriteAllText(temp, token);
            File.Move(temp, path);
            return token;
        }
        catch (IOException) when (File.Exists(path))
        {
            return ReadToken() ?? throw new InvalidOperationException("无法读取启动器的本地会话文件。");
        }
        finally
        {
            File.Delete(temp);
        }
    }

    public async Task<ServiceState> ProbeAsync()
    {
        if (!HasLocalListener()) return new(ServiceMode.Offline);
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, "/api/launcher/status");
            if (ReadToken() is { } token) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var response = await http.SendAsync(request);
            if (response.IsSuccessStatusCode)
            {
                var status = await response.Content.ReadFromJsonAsync<ServiceStatus>();
                if (status?.App == "shiyin") return new(ServiceMode.Ready, status);
            }
            else if (response.StatusCode == HttpStatusCode.NotFound)
            {
                // 识别已经由旧批处理启动的拾音实例，仍可打开网页。
                using var legacy = await http.GetAsync("/api/config");
                if (legacy.IsSuccessStatusCode)
                {
                    var config = await legacy.Content.ReadFromJsonAsync<JsonElement>();
                    if (config.ValueKind == JsonValueKind.Object
                        && config.TryGetProperty("defaultOutDir", out var fallback)
                        && fallback.ValueKind == JsonValueKind.String
                        && fallback.GetString()?.EndsWith("拾音收件箱", StringComparison.Ordinal) == true
                        && config.TryGetProperty("outDir", out var output) && output.ValueKind == JsonValueKind.String
                        && config.TryGetProperty("version", out var version) && version.ValueKind == JsonValueKind.String)
                    {
                        return new(ServiceMode.Ready, new("shiyin", version.GetString(), null,
                            output.GetString(), 0, 0, false, false));
                    }
                }
            }
        }
        catch (HttpRequestException e) when (e.InnerException is SocketException
            { SocketErrorCode: SocketError.ConnectionRefused })
        {
            return new(ServiceMode.Offline);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException) { }

        return new(HasLocalListener() ? ServiceMode.Occupied : ServiceMode.Offline);
    }

    private static bool HasLocalListener() =>
        IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(endpoint =>
            endpoint.Port == 18900 && (endpoint.Address.Equals(IPAddress.Loopback)
                || endpoint.Address.Equals(IPAddress.Any) || endpoint.Address.Equals(IPAddress.IPv6Any)));

    public async Task StartAsync()
    {
        if (!File.Exists(Path.Combine(root, "server.js")))
            throw new InvalidOperationException("请把启动器放在拾音目录中，和 server.js 放在一起。");
        if (!File.Exists(Path.Combine(root, "node_modules", "express", "package.json")))
            throw new InvalidOperationException("拾音的 Node.js 依赖尚未安装。请在项目目录运行 npm ci。");

        var portableNode = Path.Combine(root, "node.exe");
        var info = new ProcessStartInfo(File.Exists(portableNode) ? portableNode : "node.exe")
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        info.ArgumentList.Add(Path.Combine(root, "server.js"));
        info.Environment["PORT"] = "18900";
        info.Environment["BIND"] = "127.0.0.1";
        info.Environment["SHIYIN_LAUNCHER_TOKEN"] = EnsureToken();
        // 启动器可能一直开着，而 FFmpeg 等工具的系统路径已经更新。
        var searchPath = string.Join(Path.PathSeparator, new[]
        {
            Path.Combine(root, "bin", "ffmpeg"),
            Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.Machine),
            Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User),
            Environment.GetEnvironmentVariable("Path"),
        }.Where(path => !string.IsNullOrWhiteSpace(path)));
        info.Environment["Path"] = searchPath;

        var setup = Path.Combine(root, "setup-tools.ps1");
        if (File.Exists(setup) && (!File.Exists(Path.Combine(root, "bin", "Release", "whisper-cli.exe"))
            || !FindTool(searchPath, "ffmpeg.exe") || !FindTool(searchPath, "ffprobe.exe")
            || (!File.Exists(Path.Combine(root, "bin", "yt-dlp.exe"))
                && !File.Exists(Path.Combine(root, "bin", "yt-dlp-pkg", "yt_dlp", "__init__.py")))))
            await PrepareToolsAsync(setup, searchPath);

        Process? process;
        try { process = Process.Start(info); }
        catch (Win32Exception e) when (e.NativeErrorCode is 2 or 3)
        {
            throw new InvalidOperationException("找不到 Node.js。请安装 Node.js 18 或更新版本。", e);
        }
        using var child = process ?? throw new InvalidOperationException("无法启动拾音。");
        var wait = Stopwatch.StartNew();
        while (wait.Elapsed < TimeSpan.FromSeconds(12))
        {
            var state = await ProbeAsync();
            if (state.Mode == ServiceMode.Ready) return;
            if (child.HasExited)
                throw new InvalidOperationException($"拾音启动失败（退出码 {child.ExitCode}）。请检查端口和项目依赖。");
            await Task.Delay(200);
        }
        throw new TimeoutException("等待拾音服务就绪超时。");
    }

    private static bool FindTool(string searchPath, string executable) => searchPath.Split(Path.PathSeparator)
        .Any(dir => !string.IsNullOrWhiteSpace(dir) && File.Exists(Path.Combine(dir.Trim('"'), executable)));

    private async Task PrepareToolsAsync(string script, string searchPath)
    {
        var powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        var info = new ProcessStartInfo(powershell)
        {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true,
        };
        info.Environment["Path"] = searchPath;
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script })
            info.ArgumentList.Add(arg);
        using var setup = Process.Start(info) ?? throw new InvalidOperationException("无法准备首次运行工具。");
        var errors = setup.StandardError.ReadToEndAsync();
        await setup.WaitForExitAsync();
        if (setup.ExitCode != 0)
        {
            var detail = (await errors).Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
            throw new InvalidOperationException("首次运行工具准备失败。" + detail);
        }
    }

    public async Task StopAsync()
    {
        var token = ReadToken() ?? throw new InvalidOperationException("此服务由其他方式启动。");
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/launcher/stop");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await http.SendAsync(request);
        if (response.StatusCode == HttpStatusCode.Conflict)
            throw new InvalidOperationException("正在处理文件或下载模型，完成后才能停止。");
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException("当前启动器无法停止此服务。");
        for (var i = 0; i < 15; i++)
        {
            if ((await ProbeAsync()).Mode == ServiceMode.Offline) return;
            await Task.Delay(200);
        }
        throw new TimeoutException("拾音正在关闭，请稍后刷新状态。");
    }

    public string OutputDirectory(ServiceStatus? status)
    {
        if (!string.IsNullOrWhiteSpace(status?.OutDir)) return status.OutDir;
        var path = Path.Combine(Path.GetPathRoot(root)!, "shiyin-cache", "settings.json");
        try
        {
            if (File.Exists(path))
            {
                using var settings = JsonDocument.Parse(File.ReadAllText(path));
                if (settings.RootElement.TryGetProperty("outDir", out var output)
                    && output.ValueKind == JsonValueKind.String
                    && output.GetString() is { } value && Path.IsPathFullyQualified(value))
                    return value;
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException) { }
        return Environment.GetEnvironmentVariable("SHIYIN_OUT_DIR")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Desktop", "拾音收件箱");
    }

    public static void Open(string target) =>
        Process.Start(new ProcessStartInfo(target) { UseShellExecute = true })?.Dispose();
}
