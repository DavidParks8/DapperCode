using DapperCode.Core.Models;

namespace DapperCode.Core.ViewModels;

public static class BridgeLaunchPolicy
{
    public static bool ShouldStart(BridgeSnapshot snapshot)
    {
        return !snapshot.IsRunning && snapshot.State == "stopped";
    }
}
