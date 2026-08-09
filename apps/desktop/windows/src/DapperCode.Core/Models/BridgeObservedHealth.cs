using System.Text.Json.Serialization;

namespace DapperCode.Core.Models;

public sealed record BridgeObservedHealth
{
    [JsonPropertyName("status")]
    public string Status { get; init; } = "unknown";

    [JsonPropertyName("uptimeSec")]
    public ulong UptimeSec { get; init; }

    [JsonPropertyName("connectedClients")]
    public int ConnectedClients { get; init; }

    [JsonPropertyName("agents")]
    public IReadOnlyList<ObservedAgent> Agents { get; init; } = [];

    [JsonPropertyName("configuredWorkspaces")]
    public int ConfiguredWorkspaces { get; init; }

    [JsonPropertyName("runningWorkers")]
    public int RunningWorkers { get; init; }

    [JsonPropertyName("busyWorkers")]
    public int BusyWorkers { get; init; }

    [JsonPropertyName("operational")]
    public ObservedOperationalState Operational { get; init; } = new();
}
