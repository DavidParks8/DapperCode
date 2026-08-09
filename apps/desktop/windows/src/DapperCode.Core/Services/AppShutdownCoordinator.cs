namespace DapperCode.Core.Services;

public sealed class AppShutdownCoordinator(
    OperatorProcessRegistry processRegistry,
    IOperatorClient operatorClient,
    IBridgeHealthObserver healthObserver)
{
    private int _started;

    public async Task ShutdownAsync()
    {
        if (Interlocked.Exchange(ref _started, 1) != 0)
        {
            return;
        }

        processRegistry.BeginShutdown();
        await healthObserver.DisposeAsync().ConfigureAwait(false);
        _ = await operatorClient.StopAllForShutdownAsync(TimeSpan.FromSeconds(5))
            .ConfigureAwait(false);
    }
}
