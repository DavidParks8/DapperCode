namespace DapperCode.Core.Models;

public sealed record BrokerEndpointConfiguration(
    NetworkMode NetworkMode,
    string Host,
    ushort? BridgePort);
