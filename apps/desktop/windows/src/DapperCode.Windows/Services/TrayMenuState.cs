namespace DapperCode.Windows.Services;

public sealed record TrayMenuState(
    string Status,
    int WorkspaceCount,
    bool IsRunning,
    bool IsBusy,
    bool IsConfigured,
    bool CanOpenLogs,
    bool LaunchAtLogin,
    bool CanChangeLaunchAtLogin);
