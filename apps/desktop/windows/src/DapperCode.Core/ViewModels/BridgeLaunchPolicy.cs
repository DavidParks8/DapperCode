using System.Collections.ObjectModel;
using System.Globalization;
using DapperCode.Core.Models;
using DapperCode.Core.Services;

namespace DapperCode.Core.ViewModels;

public static class BridgeLaunchPolicy
{
    public static bool ShouldRestore(BridgeSnapshot snapshot) =>
        snapshot.AutoStart && !snapshot.IsRunning && snapshot.State == "stopped";
}
