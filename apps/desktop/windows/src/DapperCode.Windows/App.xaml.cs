using System.Collections.Specialized;
using System.ComponentModel;
using DapperCode.Core.Services;
using DapperCode.Core.ViewModels;
using DapperCode.Windows.Services;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace DapperCode.Windows;

public sealed partial class App : Application
{
    private DispatcherQueue? _dispatcher;
    private OperatorProcessRegistry? _processRegistry;
    private IOperatorClient? _operatorClient;
    private BridgeHealthObserver? _healthObserver;
    private AppShutdownCoordinator? _shutdownCoordinator;
    private MainViewModel? _viewModel;
    private MainWindow? _window;
    private TrayIconService? _trayIcon;
    private int _quitting;

    public App()
    {
        InitializeComponent();
        Program.ActivationQueued += OnActivationQueued;
        AppDomain.CurrentDomain.ProcessExit += OnProcessExit;
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs arguments)
    {
        _dispatcher = DispatcherQueue.GetForCurrentThread();
        try
        {
            _processRegistry = new OperatorProcessRegistry();
            var processRunner = new OperatorProcessRunner(_processRegistry);
            _operatorClient = new OperatorClient(
                new PackagedOperatorPathProvider(),
                processRunner);
            _healthObserver = new BridgeHealthObserver(
                new ClientWebSocketHealthConnectionFactory());

            MainWindow? window = null;
            var dispatcherService = new DispatcherQueueService(_dispatcher);
            var endpointConfirmation = new BrokerEndpointReplacementConfirmationService(
                () => window?.Content.XamlRoot);
            _viewModel = new MainViewModel(
                _operatorClient,
                _healthObserver,
                new QrCodeService(),
                new WindowsUserSettings(),
                new WindowsStartupService(),
                new WindowsFilePickerService(() => window!.AppWindow),
                new WindowsSystemActions(),
                new PhysicalFileSystem(),
                endpointConfirmation,
                dispatcherService);
            window = new MainWindow(_viewModel);
            _window = window;
            _shutdownCoordinator = new AppShutdownCoordinator(
                _processRegistry,
                _operatorClient,
                _healthObserver);

            _trayIcon = new TrayIconService(GetTrayMenuState);
            WireTrayEvents(_trayIcon);
            _viewModel.PropertyChanged += OnViewModelPropertyChanged;
            _viewModel.Bridges.CollectionChanged += OnBridgesChanged;

            if (Program.InitialActivation.Kind != ExtendedActivationKind.StartupTask)
            {
                _window.ShowManagementWindow();
            }

            await _viewModel.InitializeAsync();
            _trayIcon.Update();
            DrainPendingActivations();
        }
        catch (Exception error)
        {
            if (_trayIcon is null)
            {
                if (_window is not null &&
                    Program.InitialActivation.Kind != ExtendedActivationKind.StartupTask)
                {
                    await _window.ShowFatalErrorAsync(
                        $"DapperCode could not finish starting: {error.Message}");
                }

                await QuitAsync();
                return;
            }

            if (_window is not null)
            {
                if (Program.InitialActivation.Kind != ExtendedActivationKind.StartupTask)
                {
                    _window.ShowManagementWindow();
                }

                _window.ReportFatalError(
                    $"DapperCode could not finish starting: {error.Message}");
            }
            else
            {
                Exit();
            }
        }
    }

    private TrayMenuState GetTrayMenuState()
    {
        var model = _viewModel;
        if (model is null)
        {
            return new TrayMenuState(
                "Starting",
                0,
                IsRunning: false,
                IsBusy: true,
                ManagedProcess: false,
                CanPerformPrimary: false,
                CanOpenLogs: false,
                LaunchAtLogin: false,
                CanChangeLaunchAtLogin: false);
        }

        return new TrayMenuState(
            model.Snapshot.Headline,
            model.Bridges.Count,
            model.IsRunning,
            model.IsBusy,
            model.Snapshot.ManagedProcess,
            model.PrimaryActionCommand.CanExecute(null),
            !string.IsNullOrWhiteSpace(model.Snapshot.LogPath),
            model.LaunchAtLogin,
            model.LaunchAtLoginCanChange);
    }

    private void WireTrayEvents(TrayIconService tray)
    {
        tray.OpenRequested += () => _window?.ShowManagementWindow();
        tray.PrimaryActionRequested += () =>
        {
            if (_viewModel?.PrimaryActionCommand.CanExecute(null) == true)
            {
                _viewModel.PrimaryActionCommand.Execute(null);
            }
        };
        tray.RestartRequested += () =>
        {
            if (_viewModel?.RestartCommand.CanExecute(null) == true)
            {
                _viewModel.RestartCommand.Execute(null);
            }
        };
        tray.OpenLogsRequested += () =>
        {
            if (_viewModel?.OpenLogsCommand.CanExecute(null) == true)
            {
                _viewModel.OpenLogsCommand.Execute(null);
            }
        };
        tray.LaunchAtLoginRequested += enabled =>
        {
            if (_viewModel is not null)
            {
                _ = _viewModel.SetLaunchAtLoginAsync(enabled);
            }
        };
        tray.AboutRequested += () =>
        {
            if (_window is not null)
            {
                _ = _window.ShowAboutAsync();
            }
        };
        tray.QuitRequested += () => _ = QuitAsync();
    }

    private void OnActivationQueued()
    {
        _ = _dispatcher?.TryEnqueue(DrainPendingActivations);
    }

    private void DrainPendingActivations()
    {
        while (Program.TryDequeueActivation(out var activation))
        {
            if (activation?.Kind != ExtendedActivationKind.StartupTask)
            {
                _window?.ShowManagementWindow();
            }
        }
    }

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs arguments) =>
        _trayIcon?.Update();

    private void OnBridgesChanged(object? sender, NotifyCollectionChangedEventArgs arguments) =>
        _trayIcon?.Update();

    private async Task QuitAsync()
    {
        if (Interlocked.Exchange(ref _quitting, 1) != 0)
        {
            return;
        }

        _trayIcon?.Dispose();
        if (_viewModel is not null)
        {
            await _viewModel.DisposeAsync();
        }

        if (_shutdownCoordinator is not null)
        {
            await _shutdownCoordinator.ShutdownAsync();
        }

        _processRegistry?.Dispose();
        _window?.PrepareForShutdown();
        _window?.Close();
        Program.ActivationQueued -= OnActivationQueued;
        AppDomain.CurrentDomain.ProcessExit -= OnProcessExit;
        Exit();
    }

    private void OnProcessExit(object? sender, EventArgs arguments) =>
        _processRegistry?.BeginShutdown();
}
