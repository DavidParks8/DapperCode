using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

/// <summary>
/// Owns one authenticated broker health-stream session. Implementations are single-use and must
/// cancel all transport work when disposed.
/// </summary>
public interface IBridgeHealthConnection : IAsyncDisposable
{
    Task RunAsync(
        BridgeObservationTarget target,
        Action<BridgeObservedHealth> onHealth,
        CancellationToken cancellationToken);
}
