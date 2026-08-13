namespace DapperCode.Core.Models;

public sealed record BridgeObservationTarget(string ProfileId, string PairingPayload)
{
    public override string ToString() => ProfileId;
}
