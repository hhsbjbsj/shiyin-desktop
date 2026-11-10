using System.Windows;

namespace ShiyinLauncher;

public partial class App : System.Windows.Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        if (e.Args is ["--apply-update", var previous, var resume] && int.TryParse(previous, out var previousId))
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            Shutdown(DesktopUpdate.Apply(previousId, resume == "1"));
            return;
        }

        var window = new MainWindow();
        MainWindow = window;
        if (e.Args is ["--updated", var restart, var stage, var helper] && int.TryParse(helper, out var helperId))
        {
            window.ResumeAfterUpdate(restart == "1");
            _ = DesktopUpdate.CleanupAsync(stage, helperId);
        }
        else if (e.Args is ["--resume-service"])
        {
            window.ResumeAfterUpdate(true, showUpdated: false);
        }
        window.Show();
    }
}
