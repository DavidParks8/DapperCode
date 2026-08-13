using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

public interface IBridgeHealthConnection : IAsyncDisposable
{
    Task RunAsync(
        BridgeObservationTarget target,
        Action<BridgeObservedHealth> onHealth,
        CancellationToken cancellationToken);
}
