namespace DapperCode.Core.Services;

public sealed class BridgeDisconnectedEventArgs : EventArgs
{
    public BridgeDisconnectedEventArgs(string profileId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(profileId);
        ProfileId = profileId;
    }

    public string ProfileId { get; }
}
