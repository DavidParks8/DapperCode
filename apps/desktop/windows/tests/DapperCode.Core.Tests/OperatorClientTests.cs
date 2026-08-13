using System.Text.Json;
using DapperCode.Core.Models;
using DapperCode.Core.Serialization;
using DapperCode.Core.Services;
using DapperCode.ProcessFixture;
using NSubstitute;

namespace DapperCode.Core.Tests;

[TestClass]
public sealed class OperatorClientTests
{
    [TestMethod]
    public async Task ProcessRunnerConcurrentlyDrainsLargeStandardOutputAndError()
    {
        using var registry = new OperatorProcessRegistry();
        var runner = new OperatorProcessRunner(registry);
        var host = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH")
            ?? throw new InvalidOperationException(
                "DOTNET_HOST_PATH is required to run the process fixture.");
        var fixture = typeof(Marker).Assembly.Location;
        var runtimeConfig = Path.Combine(
            AppContext.BaseDirectory,
            "DapperCode.Core.Tests.runtimeconfig.json");

        var result = await runner.RunAsync(
            host,
            ["exec", "--runtimeconfig", runtimeConfig, fixture, "emit"],
            allowDuringShutdown: false,
            CancellationToken.None);

        Assert.AreEqual(0, result.ExitCode);
        StringAssert.Contains(result.StandardOutput, "stdout-255-", StringComparison.Ordinal);
        StringAssert.Contains(result.StandardError, "stderr-255-", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task LifecycleCommandsUseOwnerPidOnlyWhenTheyOwnTheBroker()
    {
        var (runner, arguments) = CreateRunner(
            Success(Snapshot("running")),
            Success(Snapshot("stopped")),
            Success(new List<BridgeSnapshot>()));
        var client = new OperatorClient(
            CreatePathProvider(),
            runner,
            processId: () => 4242);

        _ = await client.StartAsync(@"C:\work\one", CancellationToken.None);
        _ = await client.StopAsync(@"C:\work\one", CancellationToken.None);
        _ = await client.ListAsync(CancellationToken.None);

        _ = runner.Received(3).RunAsync(
            @"C:\Program Files\DapperCode\bin\dappercode.exe",
            Arg.Any<IReadOnlyList<string>>(),
            false,
            Arg.Any<CancellationToken>());
        CollectionAssert.AreEqual(
            new[] { "start", "--owner-pid", "4242", "--workspace", @"C:\work\one" },
            arguments[0]);
        CollectionAssert.AreEqual(
            new[] { "stop", "--workspace", @"C:\work\one" },
            arguments[1]);
        CollectionAssert.AreEqual(
            new[] { "list", "--owner-pid", "4242" },
            arguments[2]);
    }

    [TestMethod]
    public async Task SetupPassesEachValueAndReplacementFlagAsArguments()
    {
        var (runner, arguments) = CreateRunner(Success(new SetupResult
        {
            Workspace = @"C:\work\repo",
            BridgeUrl = "http://100.100.1.2:8787",
            BridgePort = 8787,
        }));
        var client = new OperatorClient(CreatePathProvider(), runner);

        _ = await client.SetupAsync(
            new SetupOptions(
                @"C:\work\repo",
                NetworkMode.Tailscale,
                "100.100.1.2",
                8787,
                "opencode",
                "OpenCode",
                @"C:\Program Files\OpenCode\opencode.exe",
                "acp --safe",
                ReplaceBrokerEndpoint: true),
            CancellationToken.None);

        _ = runner.Received(1).RunAsync(
            @"C:\Program Files\DapperCode\bin\dappercode.exe",
            Arg.Any<IReadOnlyList<string>>(),
            false,
            Arg.Any<CancellationToken>());
        CollectionAssert.AreEqual(
            new[]
            {
                "setup",
                "--network", "tailscale",
                "--host", "100.100.1.2",
                "--agent-id", "opencode",
                "--display-name", "OpenCode",
                "--agent-executable", @"C:\Program Files\OpenCode\opencode.exe",
                "--agent-args", "acp --safe",
                "--port", "8787",
                "--replace-broker-endpoint",
                "--workspace", @"C:\work\repo",
            },
            arguments.Single());
    }

    [TestMethod]
    public async Task SetupOmitsHostSoTheOperatorCanPerformSafeAutomaticDiscovery()
    {
        var (runner, arguments) = CreateRunner(Success(new SetupResult
        {
            Workspace = @"C:\work\repo",
            BridgeUrl = "http://192.168.1.20:8787",
            BridgePort = 8787,
        }));
        var client = new OperatorClient(CreatePathProvider(), runner);

        _ = await client.SetupAsync(
            new SetupOptions(
                @"C:\work\repo",
                NetworkMode.Local,
                string.Empty,
                null,
                "opencode",
                "OpenCode",
                @"C:\Tools\opencode.exe",
                "acp"),
            CancellationToken.None);

        CollectionAssert.DoesNotContain(
            arguments.Single(),
            "--host");
        CollectionAssert.DoesNotContain(
            arguments.Single(),
            "--replace-broker-endpoint");
    }

    [TestMethod]
    public async Task StatusDeserializesTheConfiguredEndpointWithGeneratedJsonMetadata()
    {
        var (runner, _) = CreateRunner(Success(Snapshot("stopped") with
        {
            NetworkMode = NetworkMode.Local,
            BridgeHost = "192.168.1.20",
            BridgePort = 18_787,
        }));
        var client = new OperatorClient(CreatePathProvider(), runner);

        var snapshot = await client.GetStatusAsync(
            @"C:\work\repo",
            CancellationToken.None);

        Assert.AreEqual(NetworkMode.Local, snapshot.NetworkMode);
        Assert.AreEqual("192.168.1.20", snapshot.BridgeHost);
        Assert.AreEqual((ushort)18_787, snapshot.BridgePort);
    }

    [TestMethod]
    public async Task FailureEnvelopeBecomesAnActionableOperatorError()
    {
        var (runner, _) = CreateRunner(new ProcessExecutionResult(
            1,
            string.Empty,
            """{"ok":false,"error":"stop the broker before replacing its endpoint"}"""));
        var client = new OperatorClient(CreatePathProvider(), runner);

        var error = await Assert.ThrowsAsync<OperatorException>(() =>
            client.GetStatusAsync(@"C:\work\repo", CancellationToken.None));

        Assert.AreEqual("stop the broker before replacing its endpoint", error.Message);
    }

    [TestMethod]
    public async Task InvalidSuccessEnvelopeIsRejected()
    {
        var (runner, _) = CreateRunner(
            new ProcessExecutionResult(0, """{"ok":true}""", string.Empty));
        var client = new OperatorClient(CreatePathProvider(), runner);

        var error = await Assert.ThrowsAsync<OperatorException>(() =>
            client.GetStatusAsync(@"C:\work\repo", CancellationToken.None));

        StringAssert.Contains(error.Message, "invalid response", StringComparison.Ordinal);
    }

    private static IOperatorPathProvider CreatePathProvider()
    {
        var pathProvider = Substitute.For<IOperatorPathProvider>();
        pathProvider.OperatorPath.Returns(
            @"C:\Program Files\DapperCode\bin\dappercode.exe");
        return pathProvider;
    }

    private static (
        IOperatorProcessRunner Runner,
        List<string[]> Arguments) CreateRunner(params ProcessExecutionResult[] results)
    {
        var queue = new Queue<ProcessExecutionResult>(results);
        var arguments = new List<string[]>();
        var runner = Substitute.For<IOperatorProcessRunner>();
        runner.RunAsync(
                Arg.Any<string>(),
                Arg.Do<IReadOnlyList<string>>(value => arguments.Add(value.ToArray())),
                Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(_ => Task.FromResult(queue.Dequeue()));
        return (runner, arguments);
    }

    private static ProcessExecutionResult Success<T>(T result)
    {
        var envelope = new OperatorEnvelope<T> { Ok = true, Result = result };
        var typeInfo = DapperCodeJsonContext.Default.GetTypeInfo(typeof(OperatorEnvelope<T>))
            ?? throw new InvalidOperationException(
                $"No generated JSON metadata exists for {typeof(OperatorEnvelope<T>)}.");
        return new ProcessExecutionResult(
            0,
            JsonSerializer.Serialize(envelope, typeInfo),
            string.Empty);
    }

    private static BridgeSnapshot Snapshot(string state) => new()
    {
        State = state,
        Headline = state,
        Workspace = @"C:\work\one",
        ProfileId = "one",
    };
}
