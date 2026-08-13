using DapperCode.Core.Models;

namespace DapperCode.Core.ViewModels;

public static class BridgeLaunchPolicy
{
    public static bool ShouldRestore(BridgeSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        return snapshot.AutoStart && !snapshot.IsRunning && snapshot.State == "stopped";
    }
}
