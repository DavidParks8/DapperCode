using DapperCode.Core.Models;
using DapperCode.Core.Services;
using DapperCode.Core.ViewModels;
using NSubstitute;

namespace DapperCode.Core.Tests;

[TestClass]
public sealed class MainViewModelTests
{
    [TestMethod]
    public async Task FirstRunDiscoversAgentAndPresentsSetupWithoutStartingAnything()
    {
        var environment = new ViewModelEnvironment
        {
            Current = Snapshot("needsSetup", managed: false),
        };
        await using var model = environment.Create();

        await model.InitializeAsync();

        Assert.IsFalse(model.IsConfigured);
        Assert.AreEqual(@"C:\Tools\opencode.exe", model.AgentExecutable);
        Assert.AreEqual(string.Empty, model.Host);
        Assert.IsFalse(model.IsBusy);
        Received.InOrder(() =>
        {
            _ = environment.Operator.DiscoverAgentAsync(
                "opencode",
                Arg.Any<CancellationToken>());
            _ = environment.Operator.GetStatusAsync(
                @"C:\work\repo",
                Arg.Any<CancellationToken>());
            _ = environment.Operator.ListAsync(Arg.Any<CancellationToken>());
        });
        Assert.AreEqual(3, environment.Operator.ReceivedCalls().Count());
    }

    [TestMethod]
    public async Task MissingSavedWorkspaceKeepsSetupAndWorkspacePickerAvailable()
    {
        var environment = new ViewModelEnvironment();
        await using var model = environment.Create();
        environment.Operator.GetStatusAsync(
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns<Task<BridgeSnapshot>>(_ =>
                throw new OperatorException("workspace does not exist"));
        string? error = null;
        model.ErrorOccurred += message => error = message;

        await model.InitializeAsync();

        Assert.IsFalse(model.IsConfigured);
        Assert.IsTrue(model.ChooseWorkspaceCommand.CanExecute(null));
        Assert.IsFalse(model.IsBusy);
        StringAssert.Contains(error, "workspace does not exist");
    }

    [TestMethod]
    public async Task MissingSavedWorkspaceStillRestoresAnotherRememberedBroker()
    {
        var remembered = Snapshot("stopped", managed: false) with
        {
            Workspace = @"C:\work\valid",
            ProfileId = "profile-valid",
            AutoStart = true,
        };
        var environment = new ViewModelEnvironment
        {
            Listed = [remembered],
        };
        await using var model = environment.Create();
        environment.Operator.GetStatusAsync(
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns<Task<BridgeSnapshot>>(_ =>
                throw new OperatorException("workspace does not exist"));

        await model.InitializeAsync();

        _ = environment.Operator.Received(1).StartAsync(
            remembered.Workspace,
            Arg.Any<CancellationToken>());
        Assert.IsFalse(model.IsConfigured);
        Assert.IsFalse(model.IsBusy);
    }

    [TestMethod]
    public async Task ConfiguredEndpointSeedsTheSetupFormOnInitialization()
    {
        var configured = Snapshot("stopped", managed: false) with
        {
            NetworkMode = NetworkMode.Local,
            BridgeHost = "192.168.1.20",
            BridgePort = 18_787,
        };
        var environment = new ViewModelEnvironment
        {
            Current = configured,
            Listed = [configured],
        };
        await using var model = environment.Create();

        await model.InitializeAsync();

        Assert.AreEqual(NetworkMode.Local, model.NetworkMode);
        Assert.AreEqual(1, model.NetworkModeIndex);
        Assert.AreEqual("192.168.1.20", model.Host);
        Assert.AreEqual("18787", model.BridgePort);
    }

    [TestMethod]
    public async Task AddingWorkspaceSeedsTheExistingSharedEndpoint()
    {
        var configured = Snapshot("stopped", managed: false) with
        {
            Workspace = @"C:\work\existing",
            ProfileId = "profile-existing",
            NetworkMode = NetworkMode.Tailscale,
            BridgeHost = "100.100.10.20",
            BridgePort = 8_787,
        };
        var environment = new ViewModelEnvironment
        {
            Current = Snapshot("needsSetup", managed: false) with
            {
                Workspace = @"C:\work\another",
                ProfileId = "profile-another",
            },
            Listed = [configured],
        };
        await using var model = environment.Create();

        await model.InitializeAsync();

        Assert.IsFalse(model.IsConfigured);
        Assert.AreEqual(NetworkMode.Tailscale, model.NetworkMode);
        Assert.AreEqual("100.100.10.20", model.Host);
        Assert.AreEqual("8787", model.BridgePort);
    }

    [TestMethod]
    public async Task UnchangedEndpointRunsSetupWithoutReplacementConfirmation()
    {
        var configured = Snapshot("stopped", managed: false) with
        {
            NetworkMode = NetworkMode.Tailscale,
            BridgeHost = "100.100.10.20",
            BridgePort = 8_787,
        };
        var environment = new ViewModelEnvironment
        {
            Current = configured,
            Listed = [configured],
        };
        await using var model = environment.Create();
        await model.InitializeAsync();
        environment.Operator.ClearReceivedCalls();

        await model.SetupAndStartAsync();

        _ = environment.Operator.Received(1).SetupAsync(
            Arg.Is<SetupOptions>(options => !options.ReplaceBrokerEndpoint),
            Arg.Any<CancellationToken>());
        _ = environment.Confirmation.DidNotReceive().ConfirmReplacementAsync(
            Arg.Any<BrokerEndpointConfiguration>(),
            Arg.Any<BrokerEndpointConfiguration>(),
            Arg.Any<CancellationToken>());
    }

    [TestMethod]
    [DataRow(1, "100.100.10.20", "8787")]
    [DataRow(0, "100.100.10.21", "8787")]
    [DataRow(0, "100.100.10.20", "18787")]
    public async Task EachEndpointChangeRequiresConfirmationAndCancellationStopsSetup(
        int networkModeIndex,
        string host,
        string bridgePort)
    {
        var configured = Snapshot("stopped", managed: false) with
        {
            NetworkMode = NetworkMode.Tailscale,
            BridgeHost = "100.100.10.20",
            BridgePort = 8_787,
        };
        var environment = new ViewModelEnvironment
        {
            Current = configured,
            Listed = [configured],
        };
        environment.Confirmation.ConfirmReplacementAsync(
                Arg.Any<BrokerEndpointConfiguration>(),
                Arg.Any<BrokerEndpointConfiguration>(),
                Arg.Any<CancellationToken>())
            .Returns(false);
        await using var model = environment.Create();
        await model.InitializeAsync();
        environment.Operator.ClearReceivedCalls();
        model.NetworkModeIndex = networkModeIndex;
        model.Host = host;
        model.BridgePort = bridgePort;
        var expectedNetworkMode = networkModeIndex == 0
            ? NetworkMode.Tailscale
            : NetworkMode.Local;
        var expectedPort = ushort.Parse(
            bridgePort,
            System.Globalization.CultureInfo.InvariantCulture);

        await model.SetupAndStartAsync();

        _ = environment.Confirmation.Received(1).ConfirmReplacementAsync(
            Arg.Is<BrokerEndpointConfiguration>(
                endpoint => endpoint.Host == "100.100.10.20"),
            Arg.Is<BrokerEndpointConfiguration>(
                endpoint =>
                    endpoint.NetworkMode == expectedNetworkMode &&
                    endpoint.Host == host &&
                    endpoint.BridgePort == expectedPort),
            Arg.Any<CancellationToken>());
        _ = environment.Operator.DidNotReceive().SetupAsync(
            Arg.Any<SetupOptions>(),
            Arg.Any<CancellationToken>());
        _ = environment.Operator.DidNotReceive().StartAsync(
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
        Assert.IsFalse(model.IsBusy);
    }

    [TestMethod]
    public async Task ConfirmedEndpointReplacementEmitsReplacementSetupArguments()
    {
        var configured = Snapshot("stopped", managed: false) with
        {
            NetworkMode = NetworkMode.Tailscale,
            BridgeHost = "100.100.10.20",
            BridgePort = 8_787,
        };
        var environment = new ViewModelEnvironment
        {
            Current = configured,
            Listed = [configured],
        };
        environment.Confirmation.ConfirmReplacementAsync(
                Arg.Any<BrokerEndpointConfiguration>(),
                Arg.Any<BrokerEndpointConfiguration>(),
                Arg.Any<CancellationToken>())
            .Returns(true);
        await using var model = environment.Create();
        await model.InitializeAsync();
        environment.Operator.ClearReceivedCalls();
        model.NetworkModeIndex = 1;
        model.Host = "192.168.1.20";
        model.BridgePort = "18787";

        await model.SetupAndStartAsync();

        _ = environment.Operator.Received(1).SetupAsync(
            Arg.Is<SetupOptions>(options =>
                options.NetworkMode == NetworkMode.Local &&
                options.Host == "192.168.1.20" &&
                options.BridgePort == 18_787 &&
                options.ReplaceBrokerEndpoint),
            Arg.Any<CancellationToken>());
        _ = environment.Operator.Received(1).StartAsync(
            @"C:\work\repo",
            Arg.Any<CancellationToken>());
    }

    [TestMethod]
    public async Task ConfirmedEndpointReplacementStopsRunningBrokerBeforeSetup()
    {
        var currentWorkspace = Snapshot("needsSetup", managed: false) with
        {
            NetworkMode = NetworkMode.Tailscale,
            BridgeHost = "100.100.10.20",
            BridgePort = 8_787,
        };
        var runningWorkspace = Snapshot("running", managed: true) with
        {
            Workspace = @"C:\work\existing",
            ProfileId = "profile-existing",
            NetworkMode = NetworkMode.Tailscale,
            BridgeHost = "100.100.10.20",
            BridgePort = 8_787,
        };
        var environment = new ViewModelEnvironment
        {
            Current = currentWorkspace,
            Listed = [runningWorkspace],
        };
        environment.Confirmation.ConfirmReplacementAsync(
                Arg.Any<BrokerEndpointConfiguration>(),
                Arg.Any<BrokerEndpointConfiguration>(),
                Arg.Any<CancellationToken>())
            .Returns(true);
        await using var model = environment.Create();
        await model.InitializeAsync();
        environment.Operator.ClearReceivedCalls();
        model.Host = "100.100.10.21";

        await model.SetupAndStartAsync();

        _ = environment.Operator.Received(1).StopAsync(
            runningWorkspace.Workspace,
            Arg.Any<CancellationToken>());
        var calls = environment.Operator.ReceivedCalls().ToArray();
        var stop = Array.FindIndex(
            calls,
            call => call.GetMethodInfo().Name == nameof(IOperatorClient.StopAsync));
        var setup = Array.FindIndex(
            calls,
            call => call.GetMethodInfo().Name == nameof(IOperatorClient.SetupAsync));
        var start = Array.FindIndex(
            calls,
            call => call.GetMethodInfo().Name == nameof(IOperatorClient.StartAsync));
        Assert.IsTrue(stop >= 0 && stop < setup && setup < start);
    }

    [TestMethod]
    public async Task SetupRunsSetupThenStartAndSettlesEveryDerivedControl()
    {
        var environment = new ViewModelEnvironment
        {
            Current = Snapshot("needsSetup", managed: false),
        };
        await using var model = environment.Create();
        await model.InitializeAsync();

        await model.SetupAndStartCommand.ExecuteAsync(null);

        Assert.IsTrue(model.IsConfigured);
        Assert.IsTrue(model.IsRunning);
        Assert.IsFalse(model.IsBusy);
        Assert.AreEqual("Stop broker", model.PrimaryActionTitle);
        Assert.IsTrue(model.RestartCommand.CanExecute(null));
        Assert.IsNotNull(model.PairingQrPng);
        Received.InOrder(() =>
        {
            _ = environment.Operator.DiscoverAgentAsync(
                "opencode",
                Arg.Any<CancellationToken>());
            _ = environment.Operator.GetStatusAsync(
                @"C:\work\repo",
                Arg.Any<CancellationToken>());
            _ = environment.Operator.ListAsync(Arg.Any<CancellationToken>());
            _ = environment.Operator.SetupAsync(
                Arg.Any<SetupOptions>(),
                Arg.Any<CancellationToken>());
            _ = environment.Operator.StartAsync(
                @"C:\work\repo",
                Arg.Any<CancellationToken>());
            _ = environment.Operator.GetStatusAsync(
                @"C:\work\repo",
                Arg.Any<CancellationToken>());
            _ = environment.Operator.ListAsync(Arg.Any<CancellationToken>());
        });
        Assert.AreEqual(7, environment.Operator.ReceivedCalls().Count());
    }

    [TestMethod]
    public async Task RememberedAutoStartBrokerIsRestoredOnHiddenStartupInitialization()
    {
        var stopped = Snapshot("stopped", managed: false) with { AutoStart = true };
        var environment = new ViewModelEnvironment
        {
            Current = stopped,
            Listed = [stopped],
        };
        await using var model = environment.Create();

        await model.InitializeAsync();

        Assert.IsTrue(model.IsRunning);
        _ = environment.Operator.Received(1).StartAsync(
            @"C:\work\repo",
            Arg.Any<CancellationToken>());
    }

    [TestMethod]
    public async Task LiveHealthUpdatesAllDashboardStateWithoutOperatorPolling()
    {
        var environment = new ViewModelEnvironment
        {
            Current = Snapshot("running", managed: true),
        };
        await using var model = environment.Create();
        await model.InitializeAsync();

        environment.Observer.HealthUpdated += Raise.Event<Action<string, BridgeObservedHealth>>(
            "profile-a",
            new BridgeObservedHealth
            {
                Status = "degraded",
                UptimeSec = 7_500,
                ConnectedClients = 3,
                ConfiguredWorkspaces = 2,
                RunningWorkers = 4,
                BusyWorkers = 1,
                Agents =
                [
                    new ObservedAgent { Lifecycle = "ready" },
                    new ObservedAgent { Lifecycle = "starting" },
                ],
                Operational = new ObservedOperationalState
                {
                    RecentErrors = [new ObservedRecentError()],
                },
            });

        Assert.AreEqual("degraded", model.Snapshot.State);
        Assert.AreEqual(3, model.Snapshot.ConnectedClients);
        Assert.AreEqual(1, model.Snapshot.ReadyAgents);
        Assert.AreEqual(4, model.Snapshot.TotalAgents);
        Assert.AreEqual(1, model.Snapshot.RecentErrorCount);
        Assert.AreEqual("2h 5m", model.UptimeLabel);
    }

    [TestMethod]
    public async Task SetupRejectsPrivilegedPortsBeforeInvokingTheOperator()
    {
        var environment = new ViewModelEnvironment
        {
            Current = Snapshot("needsSetup", managed: false),
        };
        await using var model = environment.Create();
        await model.InitializeAsync();
        environment.Operator.ClearReceivedCalls();
        string? error = null;
        model.ErrorOccurred += message => error = message;
        model.BridgePort = "443";

        await model.SetupAndStartAsync();

        Assert.AreEqual("Bridge port must be between 1024 and 65535.", error);
        _ = environment.Operator.DidNotReceive().SetupAsync(
            Arg.Any<SetupOptions>(),
            Arg.Any<CancellationToken>());
        _ = environment.Operator.DidNotReceive().StartAsync(
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
        Assert.IsFalse(model.IsBusy);
    }

    [TestMethod]
    public async Task SetupActionRequiresAnInstalledAgentSelection()
    {
        var environment = new ViewModelEnvironment
        {
            Current = Snapshot("needsSetup", managed: false),
        };
        await using var model = environment.Create();
        await model.InitializeAsync();

        model.AgentExecutable = string.Empty;
        Assert.IsFalse(model.SetupAndStartCommand.CanExecute(null));

        model.AgentExecutable = @"C:\Tools\opencode.exe";
        Assert.IsTrue(model.SetupAndStartCommand.CanExecute(null));
    }

    [TestMethod]
    public async Task PairingQrFailureKeepsCopyFallbackVisible()
    {
        var environment = new ViewModelEnvironment
        {
            Current = Snapshot("running", managed: true),
        };
        await using var model = environment.Create();
        environment.QrCode.RenderPng(Arg.Any<string>())
            .Returns(_ => throw new ArgumentException("Payload is too large."));
        string? notice = null;
        model.NoticeOccurred += message => notice = message;

        await model.InitializeAsync();

        Assert.IsNull(model.PairingQrPng);
        Assert.IsTrue(model.CopyPairingDataCommand.CanExecute(null));
        StringAssert.Contains(notice, "Copy pairing data");
    }

    [TestMethod]
    public async Task PolicyManagedStartupCannotBeChangedByTheUser()
    {
        var environment = new ViewModelEnvironment
        {
            Current = Snapshot("needsSetup", managed: false),
            StartupStatus = new StartupStatus(
                true,
                false,
                "Your organization requires launch at sign-in."),
        };
        await using var model = environment.Create();

        await model.InitializeAsync();

        Assert.IsTrue(model.LaunchAtLogin);
        Assert.IsFalse(model.LaunchAtLoginCanChange);
        StringAssert.Contains(model.StartupMessage, "organization");
    }

    private static BridgeSnapshot Snapshot(string state, bool managed) => new()
    {
        State = state,
        Headline = state,
        Detail = state,
        Workspace = @"C:\work\repo",
        ProfileId = "profile-a",
        ManagedProcess = managed,
        BridgeUrl = managed ? "http://100.100.10.20:8787" : null,
        PairingPayload = managed
            ? """{"type":"dappercode-broker-pair","bridgeUrl":"http://100.100.10.20:8787","bridgeToken":"secret","workspaceId":"profile-a"}"""
            : null,
        LogPath = @"C:\Data\bridge.log",
        ConfigPath = @"C:\Data\config.json",
    };

    private sealed class ViewModelEnvironment
    {
        public BridgeSnapshot Current { get; set; } = Snapshot("needsSetup", false);
        public IReadOnlyList<BridgeSnapshot>? Listed { get; set; }
        public StartupStatus StartupStatus { get; set; } = new(false, true);
        public IOperatorClient Operator { get; } = Substitute.For<IOperatorClient>();
        public IBridgeHealthObserver Observer { get; } =
            Substitute.For<IBridgeHealthObserver>();
        public IQrCodeService QrCode { get; } = Substitute.For<IQrCodeService>();
        public IUserSettings Settings { get; } = Substitute.For<IUserSettings>();
        public IStartupService Startup { get; } = Substitute.For<IStartupService>();
        public IFilePickerService Picker { get; } = Substitute.For<IFilePickerService>();
        public ISystemActions SystemActions { get; } = Substitute.For<ISystemActions>();
        public IFileSystem FileSystem { get; } = Substitute.For<IFileSystem>();
        public IBrokerEndpointReplacementConfirmation Confirmation { get; } =
            Substitute.For<IBrokerEndpointReplacementConfirmation>();
        public IUiDispatcher Dispatcher { get; } = Substitute.For<IUiDispatcher>();

        public MainViewModel Create()
        {
            Operator.GetStatusAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(_ => Task.FromResult(Current));
            Operator.ListAsync(Arg.Any<CancellationToken>())
                .Returns(_ => Task.FromResult(Listed ?? [Current]));
            Operator.StartAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(_ =>
                {
                    Current = Snapshot("running", true);
                    Listed = [Current];
                    return Task.FromResult(Current);
                });
            Operator.StopAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(_ => Task.FromResult(Current));
            Operator.RestartAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(_ => Task.FromResult(Current));
            Operator.SetupAsync(Arg.Any<SetupOptions>(), Arg.Any<CancellationToken>())
                .Returns(call => Task.FromResult(new SetupResult
                {
                    Workspace = call.Arg<SetupOptions>().Workspace,
                }));
            Operator.DiscoverAgentAsync(
                    Arg.Any<string>(),
                    Arg.Any<CancellationToken>())
                .Returns(call => Task.FromResult(new AgentDiscovery
                {
                    AgentId = call.Arg<string>(),
                    Executable = @"C:\Tools\opencode.exe",
                }));
            Operator.StopAllForShutdownAsync(Arg.Any<TimeSpan>())
                .Returns(Task.FromResult(true));
            QrCode.RenderPng(Arg.Any<string>()).Returns([0x89, 0x50, 0x4E, 0x47]);
            Settings.Workspace.Returns(@"C:\work\repo");
            Startup.GetStatusAsync(Arg.Any<CancellationToken>())
                .Returns(_ => Task.FromResult(StartupStatus));
            Startup.SetEnabledAsync(Arg.Any<bool>(), Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    StartupStatus = new StartupStatus(call.Arg<bool>(), true);
                    return Task.FromResult(StartupStatus);
                });
            Picker.PickWorkspaceAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<string?>(null));
            Picker.PickExecutableAsync(Arg.Any<string?>(), Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<string?>(null));
            SystemActions.CopyTextAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(Task.CompletedTask);
            SystemActions.OpenLogAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(Task.CompletedTask);
            SystemActions.RevealFileAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(Task.CompletedTask);
            FileSystem.FileExists(Arg.Any<string>()).Returns(true);
            FileSystem.DirectoryExists(Arg.Any<string>()).Returns(true);
            Dispatcher.When(dispatcher => dispatcher.Post(Arg.Any<Action>()))
                .Do(call => call.Arg<Action>()());

            return new MainViewModel(
                Operator,
                Observer,
                QrCode,
                Settings,
                Startup,
                Picker,
                SystemActions,
                FileSystem,
                Confirmation,
                Dispatcher);
        }
    }
}
