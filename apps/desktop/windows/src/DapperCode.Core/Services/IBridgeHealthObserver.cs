using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

/// <summary>
/// Reconciles the set of broker health streams needed by the current desktop snapshot and retries
/// transient disconnects without polling the operator.
/// </summary>
public interface IBridgeHealthObserver : IAsyncDisposable
{
    event EventHandler<BridgeHealthUpdatedEventArgs>? HealthUpdated;
    event EventHandler<BridgeDisconnectedEventArgs>? Disconnected;

    void Synchronize(IReadOnlyCollection<BridgeObservationTarget> targets);
}
