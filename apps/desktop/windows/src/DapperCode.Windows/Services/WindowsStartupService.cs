using DapperCode.Core.Services;
using Windows.ApplicationModel;

namespace DapperCode.Windows.Services;

public sealed class WindowsStartupService : IStartupService
{
    private const string StartupTaskId = "DapperCodeStartup";

    public async Task<StartupStatus> GetStatusAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var task = await StartupTask.GetAsync(StartupTaskId).AsTask(cancellationToken);
        return ToStatus(task.State);
    }

    public async Task<StartupStatus> SetEnabledAsync(
        bool enabled,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var task = await StartupTask.GetAsync(StartupTaskId).AsTask(cancellationToken);
        if (!enabled)
        {
            task.Disable();
            return ToStatus(task.State);
        }

        if (task.State == StartupTaskState.Disabled)
        {
            _ = await task.RequestEnableAsync().AsTask(cancellationToken);
        }

        return ToStatus(task.State);
    }

    private static StartupStatus ToStatus(StartupTaskState state) => state switch
    {
        StartupTaskState.Enabled => new(true, true),
        StartupTaskState.EnabledByPolicy => new(
            true,
            false,
            "Your organization’s policy requires DapperCode to launch at sign-in."),
        StartupTaskState.Disabled => new(false, true),
        StartupTaskState.DisabledByUser => new(
            false,
            false,
            "Launch at sign-in is disabled in Windows Settings. Open Settings › Apps › Startup to enable DapperCode."),
        StartupTaskState.DisabledByPolicy => new(
            false,
            false,
            "Your organization’s policy prevents DapperCode from launching at sign-in."),
        _ => new(false, false, "Launch at sign-in is unavailable."),
    };
}
