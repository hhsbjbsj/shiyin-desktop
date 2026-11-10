using System.ComponentModel;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace ShiyinLauncher;

public partial class MainWindow : Window
{
    private readonly LocalService service = new();
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(2) };
    private ServiceState? state;
    private bool polling;
    private string? action;
    private string? notice;
    private bool resumeService;
    private bool updated;

    public MainWindow()
    {
        InitializeComponent();
        var work = SystemParameters.WorkArea;
        var scale = Math.Min(1, Math.Min((work.Width - 24) / Width, (work.Height - 24) / Height));
        Width *= scale;
        Height *= scale;
        DrawWaveform();
        timer.Tick += async (_, _) => await RefreshAsync();
        Loaded += async (_, _) =>
        {
            await RefreshAsync();
            timer.Start();
            if (resumeService)
                await RunActionAsync("正在恢复拾音服务…", async () =>
                {
                    await service.StartAsync();
                    if (updated) notice = $"已更新到 v{DesktopUpdate.CurrentVersion.ToString(3)}";
                });
            else if (updated)
            {
                notice = $"已更新到 v{DesktopUpdate.CurrentVersion.ToString(3)}";
                Render();
            }
        };
        Closed += (_, _) => timer.Stop();
    }

    private async Task RefreshAsync()
    {
        if (polling || action is not null) return;
        polling = true;
        try { state = await service.ProbeAsync(); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            notice = e.Message;
            state = null;
        }
        finally
        {
            polling = false;
            Render();
        }
    }

    private void Render()
    {
        var status = state?.Status;
        var ready = state?.Mode == ServiceMode.Ready;
        var occupied = state?.Mode == ServiceMode.Occupied;
        var busy = action is not null;
        StatusText.Text = action ?? (ready ? "本地服务运行中" : occupied ? "端口被占用" :
            state is null ? "正在检查服务…" : "本地服务待启动");
        StatusDot.Fill = new SolidColorBrush((Color)ColorConverter.ConvertFromString(
            ready && !busy ? "#80EDC7" : occupied ? "#F7B276" : "#8796AF"));
        ModelText.Text = status?.Model switch
        {
            "ggml-large-v3-turbo-q5_0.bin" => "高精度 Turbo",
            "ggml-small.bin" => "均衡 Small",
            "ggml-base.bin" => "极速 Base",
            _ => status?.Version is { } version ? "v" + version : "Whisper · 本地",
        };
        HintText.Text = notice ?? (busy ? "127.0.0.1:18900" : occupied
            ? "18900 端口已有其他程序响应。释放端口后会自动更新状态。"
            : status is { Running: > 0 } || status is { Queued: > 0 }
                ? $"处理中 {status.Running} 项 · 排队 {status.Queued} 项"
                : status is { Busy: true } ? "正在接收文件或下载模型"
                : ready && status?.Managed != true ? "已连接现有拾音服务 · 服务由其他方式启动"
                : ready ? "127.0.0.1:18900 · 关闭启动器后服务继续在后台运行"
                : "启动后将在默认浏览器打开转写页面");
        LaunchButton.Content = ready ? "打开拾音   ›" : "启动拾音   ›";
        LaunchButton.IsEnabled = !busy && state is not null && !occupied;
        StopButton.IsEnabled = !busy && status is { Managed: true, Busy: false };
        UpdateButton.IsEnabled = !busy && (state?.Mode == ServiceMode.Offline || status is { Managed: true, Busy: false });
        UpdateButton.ToolTip = $"检查 GitHub 更新 · 当前 v{DesktopUpdate.CurrentVersion.ToString(3)}";
        StopButton.ToolTip = status?.Managed == false ? "由启动器启动的服务可在这里停止"
            : status?.Busy == true ? "请等待当前任务完成" : "停止本地服务";
    }

    private async Task RunActionAsync(string label, Func<Task> work)
    {
        if (action is not null || polling) return;
        notice = null;
        action = label;
        Render();
        try { await work(); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or
            HttpRequestException or TaskCanceledException or TimeoutException or Win32Exception or InvalidOperationException
            or JsonException or InvalidDataException)
        {
            notice = e.Message;
        }
        finally
        {
            action = null;
            await RefreshAsync();
        }
    }

    private async void LaunchService(object sender, RoutedEventArgs e) =>
        await RunActionAsync("正在准备拾音…", async () =>
        {
            var current = await service.ProbeAsync();
            if (current.Mode == ServiceMode.Occupied)
                throw new InvalidOperationException("18900 端口已被占用。");
            if (current.Mode == ServiceMode.Offline) await service.StartAsync();
            LocalService.Open(LocalService.Address);
        });

    private async void StopService(object sender, RoutedEventArgs e) =>
        await RunActionAsync("正在停止服务…", service.StopAsync);

    private async void CheckUpdate(object sender, RoutedEventArgs e) =>
        await RunActionAsync("正在检查更新…", async () =>
        {
            var update = await DesktopUpdate.CheckAsync();
            if (update is null)
            {
                notice = $"当前 v{DesktopUpdate.CurrentVersion.ToString(3)} 已是最新版本";
                return;
            }
            if (MessageBox.Show(this, $"发现 v{update.Version}。安装时拾音会短暂重启，模型、设置和字幕会保留。", "安装拾音更新",
                MessageBoxButton.OKCancel, MessageBoxImage.Information) != MessageBoxResult.OK) return;

            action = $"正在下载并校验 v{update.Version}…";
            Render();
            var stage = await DesktopUpdate.StageAsync(update);
            var restart = false;
            try
            {
                var current = await service.ProbeAsync();
                if (current.Mode != ServiceMode.Offline)
                {
                    if (current.Status is not { Managed: true, Busy: false })
                        throw new InvalidOperationException("请等当前任务完成并停止旧服务后再安装更新。");
                    await service.StopAsync();
                    restart = true;
                }
                DesktopUpdate.StartHelper(stage, restart);
            }
            catch
            {
                DesktopUpdate.DiscardStage(stage);
                if (restart) await service.StartAsync();
                throw;
            }
            Application.Current.Shutdown();
        });

    internal void ResumeAfterUpdate(bool restart, bool showUpdated = true)
    {
        resumeService = restart;
        updated = showUpdated;
    }

    private void OpenOutput(object sender, RoutedEventArgs e)
    {
        notice = null;
        try
        {
            var output = service.OutputDirectory(state?.Status);
            if (!System.IO.Path.IsPathFullyQualified(output) || !Directory.Exists(output))
                throw new InvalidOperationException("输出目录尚未创建。完成一次转写后即可打开。");
            LocalService.Open(output);
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            notice = ex.Message;
        }
        Render();
    }

    private void DrawWaveform()
    {
        const int count = 65;
        for (var i = 0; i < count; i++)
        {
            var position = i / (double)(count - 1);
            var envelope = Math.Pow(Math.Sin(position * Math.PI), .85);
            var signal = .23 + .51 * Math.Abs(Math.Sin(i * .43)) + .26 * Math.Abs(Math.Sin(i * 1.81));
            var height = 5 + 154 * envelope * signal;
            var color = i % 16 == 11 ? Color.FromRgb(250, 201, 129)
                : Color.FromRgb((byte)(105 + 68 * envelope), 232, 219);
            var bar = new Rectangle
            {
                Width = 3, Height = height, RadiusX = 1.5, RadiusY = 1.5,
                Fill = new SolidColorBrush(color), Opacity = .45 + envelope * .48,
            };
            Canvas.SetLeft(bar, 4 + i * 5.75);
            Canvas.SetTop(bar, (Waveform.Height - height) / 2);
            Waveform.Children.Add(bar);
        }
    }

    private void DragTitleBar(object sender, MouseButtonEventArgs e)
    {
        if (e.LeftButton == MouseButtonState.Pressed) DragMove();
    }

    private void MinimizeWindow(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void CloseWindow(object sender, RoutedEventArgs e) => Close();
}
