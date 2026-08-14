using System.Text.Json.Serialization;

namespace DapperCode.Core.Models;

public sealed record BridgeSnapshot
{
    [JsonPropertyName("state")]
    public string State { get; init; } = "loading";

    [JsonPropertyName("headline")]
    public string Headline { get; init; } = "Checking broker";

    [JsonPropertyName("detail")]
    public string Detail { get; init; } = "Reading local broker state.";

    [JsonPropertyName("bridgeUrl")]
    public string? BridgeUrl { get; init; }

    [JsonPropertyName("uptimeSec")]
    public ulong? UptimeSec { get; init; }

    [JsonPropertyName("connectedClients")]
    public int ConnectedClients { get; init; }

    [JsonPropertyName("readyAgents")]
    public int ReadyAgents { get; init; }

    [JsonPropertyName("totalAgents")]
    public int TotalAgents { get; init; }

    [JsonPropertyName("recentErrorCount")]
    public int RecentErrorCount { get; init; }

    [JsonPropertyName("managedProcess")]
    public bool ManagedProcess { get; init; }

    [JsonPropertyName("workspace")]
    public string Workspace { get; init; } = string.Empty;

    [JsonPropertyName("profileId")]
    public string ProfileId { get; init; } = string.Empty;

    [JsonPropertyName("networkMode")]
    public NetworkMode? NetworkMode { get; init; }

    [JsonPropertyName("bridgeHost")]
    public string? BridgeHost { get; init; }

    [JsonPropertyName("bridgePort")]
    public ushort? BridgePort { get; init; }

    [JsonPropertyName("pairingPayload")]
    public string? PairingPayload { get; init; }

    [JsonPropertyName("logPath")]
    public string LogPath { get; init; } = string.Empty;

    [JsonPropertyName("configPath")]
    public string ConfigPath { get; init; } = string.Empty;

    [JsonPropertyName("secretBackend")]
    public string? SecretBackend { get; init; }

    [JsonIgnore]
    public bool IsRunning =>
        State is "running" or "degraded" or "unhealthy" or "inaccessible";

    [JsonIgnore]
    public string WorkspaceName
    {
        get
        {
            var trimmed = Workspace.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var name = Path.GetFileName(trimmed);
            return string.IsNullOrWhiteSpace(name) ? Workspace : name;
        }
    }

    public BridgeSnapshot Apply(BridgeObservedHealth health)
    {
        var state = health.Status switch
        {
            "ok" => "running",
            "degraded" => "degraded",
            "unhealthy" => "unhealthy",
            _ => "error",
        };
        var headline = health.Status switch
        {
            "ok" => "Broker running",
            "degraded" => "Broker degraded",
            "unhealthy" => "Broker unhealthy",
            _ => "Unknown broker status",
        };
        var workspaceSuffix = health.ConfiguredWorkspaces == 1 ? string.Empty : "s";
        var workerSuffix = health.RunningWorkers == 1 ? string.Empty : "s";

        return this with
        {
            State = state,
            Headline = headline,
            Detail =
                $"{health.ConfiguredWorkspaces} workspace{workspaceSuffix} configured · " +
                $"{health.RunningWorkers} worker{workerSuffix} running · " +
                $"{health.BusyWorkers} busy · {health.ConnectedClients} connected devices",
            UptimeSec = health.UptimeSec,
            ConnectedClients = health.ConnectedClients,
            ReadyAgents = health.Agents.Count(agent => agent.Lifecycle == "ready"),
            TotalAgents = health.RunningWorkers,
            RecentErrorCount = health.Operational.RecentErrors.Count,
        };
    }

    public override string ToString() => $"{ProfileId}: {Headline}";

    public static BridgeSnapshot Loading { get; } = new();
}
