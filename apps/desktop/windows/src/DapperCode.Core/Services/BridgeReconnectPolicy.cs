namespace DapperCode.Core.Services;

public static class BridgeReconnectPolicy
{
    public static TimeSpan DelayForFailure(int failureCount)
    {
        var bounded = Math.Clamp(failureCount, 1, 6);
        return TimeSpan.FromSeconds(Math.Min(1 << (bounded - 1), 30));
    }
}
