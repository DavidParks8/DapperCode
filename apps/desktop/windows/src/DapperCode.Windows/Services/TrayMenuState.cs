namespace DapperCode.Windows.Services;

internal sealed record TrayMenuState(
    string Status,
    int WorkspaceCount,
    bool IsRunning,
    bool IsBusy,
    bool ManagedProcess,
    bool CanPerformPrimary,
    bool CanOpenLogs,
    bool LaunchAtLogin,
    bool CanChangeLaunchAtLogin);
