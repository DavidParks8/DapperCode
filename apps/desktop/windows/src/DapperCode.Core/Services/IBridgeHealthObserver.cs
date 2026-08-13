using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

public interface IBridgeHealthObserver : IAsyncDisposable
{
    event EventHandler<BridgeHealthUpdatedEventArgs>? HealthUpdated;
    event EventHandler<BridgeDisconnectedEventArgs>? Disconnected;

    void Synchronize(IReadOnlyCollection<BridgeObservationTarget> targets);
}
