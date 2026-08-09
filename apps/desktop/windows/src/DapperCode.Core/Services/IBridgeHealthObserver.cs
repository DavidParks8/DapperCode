using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

public interface IBridgeHealthObserver : IAsyncDisposable
{
    event Action<string, BridgeObservedHealth>? HealthUpdated;
    event Action<string>? Disconnected;

    void Synchronize(IReadOnlyCollection<BridgeObservationTarget> targets);
}
