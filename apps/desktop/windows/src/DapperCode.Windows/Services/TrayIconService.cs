using CommunityToolkit.Mvvm.Input;
using H.NotifyIcon;
using H.NotifyIcon.Core;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;

namespace DapperCode.Windows.Services;

internal sealed class TrayIconService : IDisposable
{
    private const string ActiveIconUri = "ms-appx:///Assets/TrayActive.ico";
    private const string IdleIconUri = "ms-appx:///Assets/TrayIdle.ico";
    private readonly Func<TrayMenuState> _stateProvider;
    private readonly MenuFlyout _menu = new();
    private readonly RelayCommand _openCommand;
    private readonly RelayCommand _primaryCommand;
    private readonly RelayCommand _restartCommand;
    private readonly RelayCommand _openLogsCommand;
    private readonly RelayCommand _launchAtLoginCommand;
    private readonly RelayCommand _aboutCommand;
    private readonly RelayCommand _quitCommand;
    private readonly TaskbarIcon _taskbarIcon;
    private bool? _isRunning;
    private int _disposed;

    public TrayIconService(Func<TrayMenuState> stateProvider)
    {
        _stateProvider = stateProvider;
        _openCommand = new RelayCommand(() => OpenRequested?.Invoke());
        _primaryCommand = new RelayCommand(
            () => PrimaryActionRequested?.Invoke(),
            CanPerformPrimaryAction);
        _restartCommand = new RelayCommand(
            () => RestartRequested?.Invoke(),
            CanRestart);
        _openLogsCommand = new RelayCommand(
            () => OpenLogsRequested?.Invoke(),
            () => _stateProvider().CanOpenLogs);
        _launchAtLoginCommand = new RelayCommand(
            ToggleLaunchAtLogin,
            CanToggleLaunchAtLogin);
        _aboutCommand = new RelayCommand(() => AboutRequested?.Invoke());
        _quitCommand = new RelayCommand(() => QuitRequested?.Invoke());

        _taskbarIcon = new TaskbarIcon
        {
            ContextFlyout = _menu,
            ContextMenuMode = ContextMenuMode.PopupMenu,
            DoubleClickCommand = _openCommand,
            LeftClickCommand = _openCommand,
            NoLeftClickDelay = true,
        };
        _taskbarIcon.TrayIcon.Created += OnTrayIconCreated;
        _taskbarIcon.TrayIcon.MessageWindow.KeyboardEventReceived += OnKeyboardEvent;
        Update();
    }

    public event Action? OpenRequested;
    public event Action? PrimaryActionRequested;
    public event Action? RestartRequested;
    public event Action? OpenLogsRequested;
    public event Action<bool>? LaunchAtLoginRequested;
    public event Action? AboutRequested;
    public event Action? QuitRequested;

    public void Update()
    {
        if (Volatile.Read(ref _disposed) != 0)
        {
            return;
        }

        var state = _stateProvider();
        if (_isRunning != state.IsRunning)
        {
            _taskbarIcon.IconSource = new BitmapImage(new Uri(
                state.IsRunning ? ActiveIconUri : IdleIconUri));
            _isRunning = state.IsRunning;
        }

        var toolTip = TruncateTooltip($"DapperCode: {state.Status}");
        if (!string.Equals(_taskbarIcon.ToolTipText, toolTip, StringComparison.Ordinal))
        {
            _taskbarIcon.ToolTipText = toolTip;
        }

        NotifyCommandStates();
        RebuildMenu(state);
        if (!_taskbarIcon.IsCreated)
        {
            TryCreate();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _taskbarIcon.TrayIcon.Created -= OnTrayIconCreated;
        _taskbarIcon.TrayIcon.MessageWindow.KeyboardEventReceived -= OnKeyboardEvent;
        _taskbarIcon.Dispose();
    }

    private bool CanPerformPrimaryAction()
    {
        var state = _stateProvider();
        return !state.IsBusy && state.CanPerformPrimary;
    }

    private bool CanRestart()
    {
        var state = _stateProvider();
        return !state.IsBusy && state.ManagedProcess;
    }

    private bool CanToggleLaunchAtLogin()
    {
        var state = _stateProvider();
        return !state.IsBusy && state.CanChangeLaunchAtLogin;
    }

    private void ToggleLaunchAtLogin()
    {
        var state = _stateProvider();
        LaunchAtLoginRequested?.Invoke(!state.LaunchAtLogin);
    }

    private void NotifyCommandStates()
    {
        _primaryCommand.NotifyCanExecuteChanged();
        _restartCommand.NotifyCanExecuteChanged();
        _openLogsCommand.NotifyCanExecuteChanged();
        _launchAtLoginCommand.NotifyCanExecuteChanged();
    }

    private void RebuildMenu(TrayMenuState state)
    {
        _menu.Items.Clear();
        _menu.Items.Add(new MenuFlyoutItem
        {
            Command = _openCommand,
            Text = "&Open DapperCode",
        });
        _menu.Items.Add(new MenuFlyoutSeparator());
        _menu.Items.Add(new MenuFlyoutItem
        {
            IsEnabled = false,
            Text = EscapeMenuLabel(state.Status),
        });
        if (state.WorkspaceCount > 1)
        {
            _menu.Items.Add(new MenuFlyoutItem
            {
                IsEnabled = false,
                Text = $"{state.WorkspaceCount} workspaces configured",
            });
        }

        _menu.Items.Add(new MenuFlyoutItem
        {
            Command = _primaryCommand,
            IsEnabled = !state.IsBusy && state.CanPerformPrimary,
            Text = state.IsRunning ? "S&top broker" : "S&tart broker",
        });
        _menu.Items.Add(new MenuFlyoutItem
        {
            Command = _restartCommand,
            IsEnabled = !state.IsBusy && state.ManagedProcess,
            Text = "&Restart broker",
        });
        _menu.Items.Add(new MenuFlyoutItem
        {
            Command = _openLogsCommand,
            IsEnabled = state.CanOpenLogs,
            Text = "Open &logs",
        });
        _menu.Items.Add(new MenuFlyoutSeparator());
        _menu.Items.Add(new ToggleMenuFlyoutItem
        {
            Command = _launchAtLoginCommand,
            IsChecked = state.LaunchAtLogin,
            IsEnabled = !state.IsBusy && state.CanChangeLaunchAtLogin,
            Text = "Launch at sign-&in",
        });
        _menu.Items.Add(new MenuFlyoutItem
        {
            Command = _aboutCommand,
            Text = "&About DapperCode",
        });
        _menu.Items.Add(new MenuFlyoutSeparator());
        _menu.Items.Add(new MenuFlyoutItem
        {
            Command = _quitCommand,
            Text = "&Quit DapperCode",
        });
    }

    private void TryCreate()
    {
        try
        {
            _taskbarIcon.ForceCreate(enablesEfficiencyMode: false);
        }
        catch (InvalidOperationException)
        {
            // The package's TaskbarCreated listener retries after Explorer starts or restarts.
        }
    }

    private void OnTrayIconCreated(object? sender, EventArgs arguments) => Update();

    private void OnKeyboardEvent(
        object? sender,
        MessageWindow.KeyboardEventReceivedEventArgs arguments)
    {
        switch (arguments.KeyboardEvent)
        {
            case KeyboardEvent.ContextMenu:
                RebuildMenu(_stateProvider());
                _taskbarIcon.ShowContextMenu(arguments.Point);
                break;
            case KeyboardEvent.KeySelect:
            case KeyboardEvent.Select:
                OpenRequested?.Invoke();
                break;
        }
    }

    private static string EscapeMenuLabel(string value) =>
        value.Replace("&", "&&", StringComparison.Ordinal);

    private static string TruncateTooltip(string value) =>
        value.Length <= 127 ? value : value[..127];
}
