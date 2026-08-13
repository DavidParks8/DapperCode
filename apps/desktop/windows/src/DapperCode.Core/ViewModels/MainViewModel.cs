using System.Collections.ObjectModel;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DapperCode.Core.Models;
using DapperCode.Core.Services;
using QRCoder.Exceptions;

namespace DapperCode.Core.ViewModels;

public sealed class MainViewModel : ObservableObject, IAsyncDisposable
{
    private readonly IOperatorClient _operatorClient;
    private readonly IBridgeHealthObserver _healthObserver;
    private readonly IQrCodeService _qrCodeService;
    private readonly IUserSettings _settings;
    private readonly IStartupService _startupService;
    private readonly IFilePickerService _filePicker;
    private readonly ISystemActions _systemActions;
    private readonly IFileSystem _fileSystem;
    private readonly IBrokerEndpointReplacementConfirmation _endpointReplacementConfirmation;
    private readonly IUiDispatcher _dispatcher;
    private readonly SemaphoreSlim _operationGate = new(1, 1);
    private readonly CancellationTokenSource _lifetime = new();
    private BridgeSnapshot _snapshot = BridgeSnapshot.Loading;
    private bool _isBusy;
    private NetworkMode _networkMode = NetworkMode.Tailscale;
    private string _host = string.Empty;
    private string _bridgePort = string.Empty;
    private string _agentId = "opencode";
    private string _agentDisplayName = "OpenCode";
    private string _agentExecutable = string.Empty;
    private string _agentArguments = "acp";
    private bool _launchAtLogin;
    private bool _launchAtLoginCanChange;
    private BrokerEndpointConfiguration? _configuredBrokerEndpoint;
    private string? _startupMessage;
    private ReadOnlyMemory<byte> _pairingQrPng;
    private DateTimeOffset _lastRefresh = DateTimeOffset.MinValue;
    private Task? _deferredResourceDisposal;
    private int _initialized;
    private int _disposed;

    public MainViewModel(
        IOperatorClient operatorClient,
        IBridgeHealthObserver healthObserver,
        IQrCodeService qrCodeService,
        IUserSettings settings,
        IStartupService startupService,
        IFilePickerService filePicker,
        ISystemActions systemActions,
        IFileSystem fileSystem,
        IBrokerEndpointReplacementConfirmation endpointReplacementConfirmation,
        IUiDispatcher dispatcher)
    {
        _operatorClient = operatorClient;
        _healthObserver = healthObserver;
        _qrCodeService = qrCodeService;
        _settings = settings;
        _startupService = startupService;
        _filePicker = filePicker;
        _systemActions = systemActions;
        _fileSystem = fileSystem;
        _endpointReplacementConfirmation = endpointReplacementConfirmation;
        _dispatcher = dispatcher;

        _healthObserver.HealthUpdated += OnHealthUpdated;
        _healthObserver.Disconnected += OnHealthDisconnected;

        RefreshCommand = new AsyncRelayCommand(RefreshAsync, () => !IsBusy);
        SetupCommand = new AsyncRelayCommand(
            SetupAsync,
            () => !IsBusy && !string.IsNullOrWhiteSpace(AgentExecutable));
        ChooseWorkspaceCommand = new AsyncRelayCommand(
            ChooseWorkspaceAsync,
            () => !IsBusy);
        ChooseAgentCommand = new AsyncRelayCommand(ChooseAgentAsync, () => !IsBusy);
        CopyBridgeUrlCommand = new AsyncRelayCommand(
            CopyBridgeUrlAsync,
            () => Snapshot.BridgeUrl is not null);
        CopyPairingDataCommand = new AsyncRelayCommand(
            CopyPairingDataAsync,
            () => Snapshot.PairingPayload is not null);
        OpenLogsCommand = new AsyncRelayCommand(
            () => OpenLogsAsync(Snapshot),
            () => !string.IsNullOrWhiteSpace(Snapshot.LogPath));
        RevealConfigCommand = new AsyncRelayCommand(
            RevealConfigAsync,
            () => !string.IsNullOrWhiteSpace(Snapshot.ConfigPath));
        OpenWorkspaceLogsCommand = new RelayCommand<BridgeSnapshot>(
            bridge =>
            {
                if (bridge is not null)
                {
                    _ = OpenLogsAsync(bridge);
                }
            },
            bridge => bridge is not null && !string.IsNullOrWhiteSpace(bridge.LogPath));
    }

    public event EventHandler<MessageEventArgs>? ErrorOccurred;
    public event EventHandler<MessageEventArgs>? NoticeOccurred;

    public ObservableCollection<BridgeSnapshot> Bridges { get; } = [];

    public AsyncRelayCommand RefreshCommand { get; }
    public AsyncRelayCommand SetupCommand { get; }
    public AsyncRelayCommand ChooseWorkspaceCommand { get; }
    public AsyncRelayCommand ChooseAgentCommand { get; }
    public AsyncRelayCommand CopyBridgeUrlCommand { get; }
    public AsyncRelayCommand CopyPairingDataCommand { get; }
    public AsyncRelayCommand OpenLogsCommand { get; }
    public AsyncRelayCommand RevealConfigCommand { get; }
    public RelayCommand<BridgeSnapshot> OpenWorkspaceLogsCommand { get; }

    public BridgeSnapshot Snapshot
    {
        get => _snapshot;
        private set
        {
            if (!SetProperty(ref _snapshot, value))
            {
                return;
            }

            UpdateQrCode();
            OnPropertyChanged(nameof(IsConfigured));
            OnPropertyChanged(nameof(IsRunning));
            OnPropertyChanged(nameof(SecretBackendLabel));
            OnPropertyChanged(nameof(UptimeLabel));
            OnPropertyChanged(nameof(HasPairingData));
            RaiseCommandStates();
        }
    }

    public bool IsBusy
    {
        get => _isBusy;
        private set
        {
            if (SetProperty(ref _isBusy, value))
            {
                RaiseCommandStates();
            }
        }
    }

    public string Workspace
    {
        get => _settings.Workspace;
        set
        {
            if (string.Equals(_settings.Workspace, value, StringComparison.Ordinal))
            {
                return;
            }

            _settings.Workspace = value;
            OnPropertyChanged();
        }
    }

    public NetworkMode NetworkMode
    {
        get => _networkMode;
        private set
        {
            if (SetProperty(ref _networkMode, value))
            {
                OnPropertyChanged(nameof(NetworkModeIndex));
            }
        }
    }

    public int NetworkModeIndex
    {
        get => NetworkMode == NetworkMode.Tailscale ? 0 : 1;
        set
        {
            if (value is 0 or 1)
            {
                NetworkMode = value == 0 ? NetworkMode.Tailscale : NetworkMode.Local;
            }
        }
    }

    public string Host
    {
        get => _host;
        set => SetProperty(ref _host, value);
    }

    public string BridgePort
    {
        get => _bridgePort;
        set => SetProperty(ref _bridgePort, value);
    }

    public string AgentId
    {
        get => _agentId;
        set => SetProperty(ref _agentId, value);
    }

    public string AgentDisplayName
    {
        get => _agentDisplayName;
        set => SetProperty(ref _agentDisplayName, value);
    }

    public string AgentExecutable
    {
        get => _agentExecutable;
        set
        {
            if (SetProperty(ref _agentExecutable, value))
            {
                SetupCommand.NotifyCanExecuteChanged();
            }
        }
    }

    public string AgentArguments
    {
        get => _agentArguments;
        set => SetProperty(ref _agentArguments, value);
    }

    public bool LaunchAtLogin
    {
        get => _launchAtLogin;
        private set => SetProperty(ref _launchAtLogin, value);
    }

    public string? StartupMessage
    {
        get => _startupMessage;
        private set => SetProperty(ref _startupMessage, value);
    }

    public bool LaunchAtLoginCanChange
    {
        get => _launchAtLoginCanChange;
        private set => SetProperty(ref _launchAtLoginCanChange, value);
    }

    public ReadOnlyMemory<byte> PairingQrPng
    {
        get => _pairingQrPng;
        private set => SetProperty(ref _pairingQrPng, value);
    }

    public bool IsConfigured =>
        Snapshot.State is not ("loading" or "needsSetup") &&
        (Snapshot.State != "error" || Snapshot.ManagedProcess);

    public bool IsRunning => Snapshot.IsRunning;
    public bool HasPairingData => Snapshot.PairingPayload is not null;

    public string SecretBackendLabel => Snapshot.SecretBackend switch
    {
        "keychain" => "Windows Credential Manager",
        "file" => "Private file — credential vault unavailable",
        _ => "Not stored yet",
    };

    public string UptimeLabel
    {
        get
        {
            if (Snapshot.UptimeSec is not { } seconds)
            {
                return "—";
            }

            var duration = TimeSpan.FromSeconds(seconds);
            return duration.TotalHours >= 1
                ? $"{(int)duration.TotalHours}h {duration.Minutes}m"
                : $"{Math.Max(0, duration.Minutes)}m";
        }
    }

    public async Task InitializeAsync()
    {
        if (Interlocked.Exchange(ref _initialized, 1) != 0)
        {
            return;
        }

        await ExecuteBusyAsync(async cancellationToken =>
        {
            var startup = await _startupService.GetStatusAsync(cancellationToken)
                .ConfigureAwait(true);
            ApplyStartupStatus(startup);
            await DiscoverDefaultAgentAsync(cancellationToken).ConfigureAwait(true);
            await InitializeRefreshCoreAsync(cancellationToken).ConfigureAwait(true);
            await EnsureBrokerRunningAsync(cancellationToken).ConfigureAwait(true);
        }).ConfigureAwait(true);
    }

    public Task RefreshAsync() =>
        ExecuteBusyAsync(RefreshCoreAsync);

    public async Task RefreshIfStaleAsync()
    {
        if (DateTimeOffset.UtcNow - _lastRefresh < TimeSpan.FromSeconds(15))
        {
            return;
        }

        await RefreshAsync().ConfigureAwait(true);
    }

    public Task SetupAsync() =>
        ExecuteBusyAsync(async cancellationToken =>
        {
            var options = ValidateSetup();
            var replacement = new BrokerEndpointConfiguration(
                options.NetworkMode,
                options.Host,
                options.BridgePort);
            if (_configuredBrokerEndpoint is { } current &&
                !BrokerEndpointsEqual(current, replacement))
            {
                var confirmed = await _endpointReplacementConfirmation
                    .ConfirmReplacementAsync(current, replacement, cancellationToken)
                    .ConfigureAwait(true);
                if (!confirmed)
                {
                    return;
                }

                options = options with { ReplaceBrokerEndpoint = true };
                var managedBridge = Bridges.FirstOrDefault(bridge => bridge.ManagedProcess);
                if (managedBridge is not null)
                {
                    _ = await _operatorClient.StopAsync(
                        managedBridge.Workspace,
                        cancellationToken).ConfigureAwait(true);
                }
            }

            _ = await _operatorClient.SetupAsync(options, cancellationToken).ConfigureAwait(true);
            Snapshot = await _operatorClient.StartAsync(Workspace, cancellationToken)
                .ConfigureAwait(true);
            await RefreshCoreAsync(cancellationToken).ConfigureAwait(true);
        });

    public Task ChooseWorkspaceAsync() =>
        ExecuteBusyAsync(async cancellationToken =>
        {
            var selected = await _filePicker.PickWorkspaceAsync(cancellationToken)
                .ConfigureAwait(true);
            if (selected is null)
            {
                return;
            }

            Workspace = selected;
            await RefreshCoreAsync(cancellationToken).ConfigureAwait(true);
            await EnsureBrokerRunningAsync(cancellationToken).ConfigureAwait(true);
        });

    public Task ChooseAgentAsync() =>
        ExecuteBusyAsync(async cancellationToken =>
        {
            var selected = await _filePicker.PickExecutableAsync(cancellationToken)
                .ConfigureAwait(true);
            if (selected is null)
            {
                return;
            }

            AgentExecutable = selected;
            if (string.IsNullOrWhiteSpace(AgentDisplayName))
            {
                AgentDisplayName = Path.GetFileNameWithoutExtension(selected);
            }
        });

    public async Task SetLaunchAtLoginAsync(bool enabled)
    {
        await ExecuteBusyAsync(async cancellationToken =>
        {
            var status = await _startupService.SetEnabledAsync(enabled, cancellationToken)
                .ConfigureAwait(true);
            ApplyStartupStatus(status);
            if (status.IsEnabled != enabled && status.Message is { } message)
            {
                NoticeOccurred?.Invoke(this, new MessageEventArgs(message));
            }
        }).ConfigureAwait(true);
    }

    public async Task OpenLogsAsync(BridgeSnapshot bridge)
    {
        ArgumentNullException.ThrowIfNull(bridge);
        try
        {
            await _systemActions.OpenLogAsync(bridge.LogPath, _lifetime.Token)
                .ConfigureAwait(true);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            ReportError(error);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        await _lifetime.CancelAsync().ConfigureAwait(true);
        _healthObserver.HealthUpdated -= OnHealthUpdated;
        _healthObserver.Disconnected -= OnHealthDisconnected;
        try
        {
            await _healthObserver.DisposeAsync().ConfigureAwait(true);
        }
        finally
        {
            if (await _operationGate.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(true))
            {
                DisposeResources();
            }
            else
            {
                _deferredResourceDisposal = DisposeResourcesWhenIdleAsync();
            }
        }
    }

    private async Task DisposeResourcesWhenIdleAsync()
    {
        await _operationGate.WaitAsync().ConfigureAwait(false);
        DisposeResources();
    }

    private void DisposeResources()
    {
        _operationGate.Release();
        _operationGate.Dispose();
        _lifetime.Dispose();
    }

    private async Task RefreshCoreAsync(CancellationToken cancellationToken)
    {
        var snapshot = await _operatorClient.GetStatusAsync(Workspace, cancellationToken)
            .ConfigureAwait(true);
        var bridges = await _operatorClient.ListAsync(cancellationToken).ConfigureAwait(true);
        ApplyRefresh(snapshot, bridges);
    }

    private async Task InitializeRefreshCoreAsync(CancellationToken cancellationToken)
    {
        try
        {
            await RefreshCoreAsync(cancellationToken).ConfigureAwait(true);
        }
        catch (OperatorException error)
        {
            ReportError(error);
            var bridges = await _operatorClient.ListAsync(cancellationToken).ConfigureAwait(true);
            ApplyRefresh(
                BridgeSnapshot.Loading with
                {
                    State = "needsSetup",
                    Headline = "Choose a workspace",
                    Detail = "The previously selected workspace is unavailable.",
                    Workspace = Workspace,
                },
                bridges);
        }
    }

    private async Task RefreshProfilesAsync(CancellationToken cancellationToken)
    {
        var bridges = await _operatorClient.ListAsync(cancellationToken).ConfigureAwait(true);
        ApplyRefresh(Snapshot, bridges);
    }

    private void ApplyRefresh(BridgeSnapshot snapshot, IReadOnlyList<BridgeSnapshot> bridges)
    {
        _dispatcher.Post(() =>
        {
            SynchronizeBrokerEndpoint(snapshot, bridges);
            Snapshot = snapshot;
            SynchronizeBridges(bridges);
            _lastRefresh = DateTimeOffset.UtcNow;
            SynchronizeHealthObserver();
        });
    }

    private void SynchronizeBridges(IReadOnlyList<BridgeSnapshot> bridges)
    {
        for (var desiredIndex = 0; desiredIndex < bridges.Count; desiredIndex++)
        {
            var desired = bridges[desiredIndex];
            var currentIndex = -1;
            for (var index = desiredIndex; index < Bridges.Count; index++)
            {
                if (Bridges[index].ProfileId == desired.ProfileId)
                {
                    currentIndex = index;
                    break;
                }
            }

            if (currentIndex < 0)
            {
                Bridges.Insert(desiredIndex, desired);
                continue;
            }

            if (currentIndex != desiredIndex)
            {
                Bridges.Move(currentIndex, desiredIndex);
            }
            if (Bridges[desiredIndex] != desired)
            {
                Bridges[desiredIndex] = desired;
            }
        }

        while (Bridges.Count > bridges.Count)
        {
            Bridges.RemoveAt(Bridges.Count - 1);
        }
    }

    private void SynchronizeBrokerEndpoint(
        BridgeSnapshot snapshot,
        IReadOnlyList<BridgeSnapshot> bridges)
    {
        var previous = _configuredBrokerEndpoint;
        var formMatchesPrevious = previous is null || SetupFormMatches(previous);
        var configured = GetBrokerEndpoint(snapshot) ??
            bridges.Select(GetBrokerEndpoint).FirstOrDefault(endpoint => endpoint is not null);
        _configuredBrokerEndpoint = configured;

        if (!formMatchesPrevious)
        {
            return;
        }

        if (configured is null)
        {
            if (previous is not null)
            {
                NetworkMode = NetworkMode.Tailscale;
                Host = string.Empty;
                BridgePort = string.Empty;
            }

            return;
        }

        NetworkMode = configured.NetworkMode;
        Host = configured.Host;
        BridgePort = configured.BridgePort?.ToString(CultureInfo.InvariantCulture) ?? string.Empty;
    }

    private bool SetupFormMatches(BrokerEndpointConfiguration endpoint)
    {
        ushort? port = null;
        if (!string.IsNullOrWhiteSpace(BridgePort))
        {
            if (!ushort.TryParse(
                    BridgePort,
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out var parsedPort))
            {
                return false;
            }

            port = parsedPort;
        }

        return BrokerEndpointsEqual(
            endpoint,
            new BrokerEndpointConfiguration(NetworkMode, Host.Trim(), port));
    }

    private static BrokerEndpointConfiguration? GetBrokerEndpoint(BridgeSnapshot snapshot) =>
        snapshot.NetworkMode is { } networkMode &&
        !string.IsNullOrWhiteSpace(snapshot.BridgeHost) &&
        snapshot.BridgePort is { } bridgePort
            ? new BrokerEndpointConfiguration(
                networkMode,
                snapshot.BridgeHost.Trim(),
                bridgePort)
            : null;

    private static bool BrokerEndpointsEqual(
        BrokerEndpointConfiguration left,
        BrokerEndpointConfiguration right) =>
        left.NetworkMode == right.NetworkMode &&
        string.Equals(left.Host.Trim(), right.Host.Trim(), StringComparison.OrdinalIgnoreCase) &&
        left.BridgePort == right.BridgePort;

    private async Task EnsureBrokerRunningAsync(CancellationToken cancellationToken)
    {
        var configured = Bridges.FirstOrDefault(BridgeLaunchPolicy.ShouldStart);
        if (configured is null)
        {
            return;
        }

        try
        {
            _ = await _operatorClient.StartAsync(configured.Workspace, cancellationToken)
                .ConfigureAwait(true);
            if (Snapshot.State == "needsSetup")
            {
                await RefreshProfilesAsync(cancellationToken).ConfigureAwait(true);
            }
            else
            {
                await RefreshCoreAsync(cancellationToken).ConfigureAwait(true);
            }
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            throw new OperatorException(
                $"Could not start the broker: {error.Message}",
                error);
        }
    }

    private SetupOptions ValidateSetup()
    {
        if (!_fileSystem.DirectoryExists(Workspace))
        {
            throw new OperatorException("Choose an existing workspace folder.");
        }

        if (string.IsNullOrWhiteSpace(AgentExecutable) ||
            !_fileSystem.FileExists(AgentExecutable))
        {
            throw new OperatorException("Choose an installed ACP agent executable.");
        }

        if (string.IsNullOrWhiteSpace(AgentId))
        {
            throw new OperatorException("Enter an ACP agent ID.");
        }

        if (string.IsNullOrWhiteSpace(AgentDisplayName))
        {
            throw new OperatorException("Enter a display name for the ACP agent.");
        }

        var host = Host.Trim();
        if (host.Length > 0 &&
            (!IPAddress.TryParse(host, out var address) ||
             address.AddressFamily != AddressFamily.InterNetwork ||
             IPAddress.IsLoopback(address) ||
             address.Equals(IPAddress.Any) ||
             address.GetAddressBytes() is [169, 254, _, _]))
        {
            throw new OperatorException(
                NetworkMode == NetworkMode.Tailscale
                    ? "Enter the connected Tailscale IPv4 address for this PC."
                    : "Enter a non-loopback local IPv4 address for this PC.");
        }

        ushort? port = null;
        if (!string.IsNullOrWhiteSpace(BridgePort))
        {
            if (!ushort.TryParse(
                    BridgePort,
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out var parsedPort) ||
                parsedPort < 1024)
            {
                throw new OperatorException(
                    "Bridge port must be between 1024 and 65535.");
            }

            port = parsedPort;
        }

        return new SetupOptions(
            Workspace,
            NetworkMode,
            host,
            port,
            AgentId.Trim(),
            AgentDisplayName.Trim(),
            AgentExecutable,
            AgentArguments);
    }

    private async Task DiscoverDefaultAgentAsync(CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(AgentExecutable))
        {
            return;
        }

        try
        {
            var discovered = await _operatorClient.DiscoverAgentAsync(AgentId, cancellationToken)
                .ConfigureAwait(true);
            AgentExecutable = discovered.Executable;
        }
        catch (OperatorException)
        {
            // The native file picker remains available when auto-discovery fails.
        }
    }

    private async Task CopyBridgeUrlAsync()
    {
        if (Snapshot.BridgeUrl is not { } value)
        {
            return;
        }

        await CopyAsync(value, "Broker URL copied.").ConfigureAwait(true);
    }

    private async Task CopyPairingDataAsync()
    {
        if (Snapshot.PairingPayload is not { } value)
        {
            return;
        }

        await CopyAsync(value, "Pairing data copied.").ConfigureAwait(true);
    }

    private async Task CopyAsync(string value, string confirmation)
    {
        try
        {
            await _systemActions.CopyTextAsync(value, _lifetime.Token).ConfigureAwait(true);
            NoticeOccurred?.Invoke(this, new MessageEventArgs(confirmation));
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            ReportError(error);
        }
    }

    private async Task RevealConfigAsync()
    {
        try
        {
            await _systemActions.RevealFileAsync(Snapshot.ConfigPath, _lifetime.Token)
                .ConfigureAwait(true);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            ReportError(error);
        }
    }

    [SuppressMessage(
        "Design",
        "CA1031:Do not catch general exception types",
        Justification = "This command boundary reports unexpected failures to the UI and restores busy state.")]
    private async Task ExecuteBusyAsync(Func<CancellationToken, Task> operation)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        var acquired = false;
        try
        {
            await _operationGate.WaitAsync(linked.Token).ConfigureAwait(true);
            acquired = true;
            IsBusy = true;
            await operation(linked.Token).ConfigureAwait(true);
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            ReportError(error);
        }
        finally
        {
            if (acquired)
            {
                IsBusy = false;
                _operationGate.Release();
            }
        }
    }

    private void ApplyStartupStatus(StartupStatus status)
    {
        _dispatcher.Post(() =>
        {
            LaunchAtLogin = status.IsEnabled;
            LaunchAtLoginCanChange = status.CanEnable;
            StartupMessage = status.Message;
        });
    }

    private void UpdateQrCode()
    {
        try
        {
            PairingQrPng = Snapshot.PairingPayload is { } payload
                ? _qrCodeService.RenderPng(payload)
                : ReadOnlyMemory<byte>.Empty;
        }
        catch (Exception error) when (
            error is ArgumentException or ArgumentOutOfRangeException or
            DataTooLongException)
        {
            PairingQrPng = ReadOnlyMemory<byte>.Empty;
            NoticeOccurred?.Invoke(
                this,
                new MessageEventArgs(
                    "The pairing QR code could not be generated. Use Copy pairing data instead."));
        }
    }

    private void SynchronizeHealthObserver()
    {
        if (Snapshot.IsRunning && Snapshot.PairingPayload is { } payload)
        {
            _healthObserver.Synchronize(
                [new BridgeObservationTarget(Snapshot.ProfileId, payload)]);
        }
        else
        {
            _healthObserver.Synchronize([]);
        }
    }

    private void OnHealthUpdated(object? sender, BridgeHealthUpdatedEventArgs arguments)
    {
        _dispatcher.Post(() =>
        {
            if (Snapshot.ProfileId == arguments.ProfileId)
            {
                Snapshot = Snapshot.Apply(arguments.Health);
            }

            for (var index = 0; index < Bridges.Count; index++)
            {
                if (Bridges[index].ProfileId == arguments.ProfileId)
                {
                    Bridges[index] = Bridges[index].Apply(arguments.Health);
                }
            }
        });
    }

    private void OnHealthDisconnected(object? sender, BridgeDisconnectedEventArgs arguments)
    {
        if (Snapshot.ProfileId != arguments.ProfileId || !Snapshot.IsRunning)
        {
            return;
        }

        _dispatcher.Post(() => _ = ReconcileAfterDisconnectAsync());
    }

    private Task ReconcileAfterDisconnectAsync() =>
        ExecuteBusyAsync(async cancellationToken =>
        {
            await RefreshCoreAsync(cancellationToken).ConfigureAwait(true);
            await EnsureBrokerRunningAsync(cancellationToken).ConfigureAwait(true);
        });

    private void RaiseCommandStates()
    {
        RefreshCommand.NotifyCanExecuteChanged();
        SetupCommand.NotifyCanExecuteChanged();
        ChooseWorkspaceCommand.NotifyCanExecuteChanged();
        ChooseAgentCommand.NotifyCanExecuteChanged();
        CopyBridgeUrlCommand.NotifyCanExecuteChanged();
        CopyPairingDataCommand.NotifyCanExecuteChanged();
        OpenLogsCommand.NotifyCanExecuteChanged();
        RevealConfigCommand.NotifyCanExecuteChanged();
        OpenWorkspaceLogsCommand.NotifyCanExecuteChanged();
    }

    private void ReportError(Exception error)
    {
        var message = error is OperatorException
            ? error.Message
            : $"DapperCode could not complete the action: {error.Message}";
        _dispatcher.Post(() => ErrorOccurred?.Invoke(this, new MessageEventArgs(message)));
    }
}
