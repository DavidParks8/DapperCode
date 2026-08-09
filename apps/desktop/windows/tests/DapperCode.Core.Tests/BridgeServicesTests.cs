using System.Text.Json;
using DapperCode.Core.Models;
using DapperCode.Core.Serialization;
using DapperCode.Core.Services;
using NSubstitute;

namespace DapperCode.Core.Tests;

[TestClass]
public sealed class BridgeServicesTests
{
    [TestMethod]
    public void PairingPayloadBuildsAnAuthenticatedBrokerWebSocketEndpoint()
    {
        var target = new BridgeObservationTarget(
            "profile-a",
            """
            {
              "type": "dappercode-broker-pair",
              "bridgeUrl": "https://host.test/private/",
              "bridgeToken": " secret ",
              "workspaceId": "profile-a"
            }
            """);

        var endpoint = BridgeEndpoint.Parse(target);

        Assert.AreEqual("wss", endpoint.SocketUri.Scheme);
        Assert.AreEqual("/private/broker/rpc", endpoint.SocketUri.AbsolutePath);
        StringAssert.Contains(endpoint.SocketUri.Query, "clientType=desktop-monitor");
        StringAssert.Contains(endpoint.SocketUri.Query, "workspace=profile-a");
        Assert.AreEqual("secret", endpoint.Token);
        Assert.AreEqual("Bearer secret", endpoint.AuthorizationHeader);
    }

    [TestMethod]
    public void PairingPayloadRejectsPublicOrUnsupportedSchemes()
    {
        var target = new BridgeObservationTarget(
            "profile-a",
            """{"type":"dappercode-broker-pair","bridgeUrl":"ftp://host","bridgeToken":"secret"}""");

        _ = Assert.Throws<OperatorException>(() => BridgeEndpoint.Parse(target));
    }

    [TestMethod]
    public void BrokerHealthRequestPreservesTheRpcWireShape()
    {
        var json = JsonSerializer.Serialize(
            new BrokerHealthRequest { Id = "desktop-health-1" },
            DapperCodeJsonContext.Default.BrokerHealthRequest);

        Assert.AreEqual(
            """{"id":"desktop-health-1","method":"bridge/health/read","params":{}}""",
            json);
    }

    [TestMethod]
    public void ReconnectBackoffIsBounded()
    {
        var delays = Enumerable.Range(1, 9)
            .Select(BridgeReconnectPolicy.DelayForFailure)
            .Select(delay => delay.TotalSeconds)
            .ToArray();

        CollectionAssert.AreEqual(
            new[] { 1d, 2d, 4d, 8d, 16d, 30d, 30d, 30d, 30d },
            delays);
    }

    [TestMethod]
    public void QrRendererProducesLocalPngBytes()
    {
        var bytes = new QrCodeService().RenderPng(
            """{"type":"dappercode-broker-pair","bridgeToken":"secret"}""");

        CollectionAssert.AreEqual(
            new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A },
            bytes[..8]);
        Assert.IsTrue(bytes.Length > 100);
    }

    [TestMethod]
    public void QrRendererRejectsPayloadsBeyondQrCapacity()
    {
        var error = Assert.Throws<ArgumentOutOfRangeException>(
            () => new QrCodeService().RenderPng(new string('x', 2_201)));

        StringAssert.Contains(error.Message, "too large");
    }

    [TestMethod]
    public async Task ObserverRetriesAfterDisconnectThenCancelsRemovedTargets()
    {
        var firstConnection = Substitute.For<IBridgeHealthConnection>();
        firstConnection.RunAsync(
                Arg.Any<BridgeObservationTarget>(),
                Arg.Any<Action<BridgeObservedHealth>>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new IOException("disconnected")));

        var secondConnectionCancelled = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var secondConnection = Substitute.For<IBridgeHealthConnection>();
        secondConnection.RunAsync(
                Arg.Any<BridgeObservationTarget>(),
                Arg.Any<Action<BridgeObservedHealth>>(),
                Arg.Any<CancellationToken>())
            .Returns(call => RunUntilCancelledAsync(
                call.Arg<Action<BridgeObservedHealth>>(),
                secondConnectionCancelled,
                call.Arg<CancellationToken>()));

        var factory = Substitute.For<IBridgeHealthConnectionFactory>();
        factory.Create().Returns(firstConnection, secondConnection);
        var delays = new List<TimeSpan>();
        var delay = Substitute.For<IAsyncDelay>();
        delay.DelayAsync(
                Arg.Do<TimeSpan>(value => delays.Add(value)),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        await using var observer = new BridgeHealthObserver(factory, delay);
        var disconnected = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var healthReceived = new TaskCompletionSource<BridgeObservedHealth>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        observer.Disconnected += _ => disconnected.TrySetResult();
        observer.HealthUpdated += (_, health) => healthReceived.TrySetResult(health);
        var target = new BridgeObservationTarget("profile-a", "payload");

        observer.Synchronize([target]);
        await disconnected.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var health = await healthReceived.Task.WaitAsync(TimeSpan.FromSeconds(2));
        observer.Synchronize([]);

        Assert.AreEqual("ok", health.Status);
        _ = factory.Received(2).Create();
        _ = delay.Received(1).DelayAsync(
            TimeSpan.FromSeconds(1),
            Arg.Any<CancellationToken>());
        Assert.AreEqual(TimeSpan.FromSeconds(1), delays.Single());
        await secondConnectionCancelled.Task.WaitAsync(TimeSpan.FromSeconds(2));
    }

    private static async Task RunUntilCancelledAsync(
        Action<BridgeObservedHealth> onHealth,
        TaskCompletionSource cancellationObserved,
        CancellationToken cancellationToken)
    {
        onHealth(new BridgeObservedHealth { Status = "ok" });
        try
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            cancellationObserved.TrySetResult();
            throw;
        }
    }
}
