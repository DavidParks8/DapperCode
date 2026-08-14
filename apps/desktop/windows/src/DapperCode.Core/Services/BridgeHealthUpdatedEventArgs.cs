using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

public sealed class BridgeHealthUpdatedEventArgs : EventArgs
{
    public BridgeHealthUpdatedEventArgs(string profileId, BridgeObservedHealth health)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(profileId);
        ProfileId = profileId;
        Health = health;
    }

    public string ProfileId { get; }
    public BridgeObservedHealth Health { get; }
}
