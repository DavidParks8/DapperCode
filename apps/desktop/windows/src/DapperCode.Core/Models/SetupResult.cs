using System.Text.Json.Serialization;

namespace DapperCode.Core.Models;

public sealed record SetupResult
{
    [JsonPropertyName("workspace")]
    public string Workspace { get; init; } = string.Empty;

    [JsonPropertyName("profileId")]
    public string ProfileId { get; init; } = string.Empty;

    [JsonPropertyName("bridgePort")]
    public ushort BridgePort { get; init; }

    [JsonPropertyName("previewPort")]
    public ushort PreviewPort { get; init; }

    [JsonPropertyName("agentId")]
    public string AgentId { get; init; } = string.Empty;

    [JsonPropertyName("agentVersion")]
    public string AgentVersion { get; init; } = string.Empty;

    [JsonPropertyName("executable")]
    public string Executable { get; init; } = string.Empty;

    [JsonPropertyName("configPath")]
    public string ConfigPath { get; init; } = string.Empty;

    [JsonPropertyName("secretBackend")]
    public string SecretBackend { get; init; } = string.Empty;
}
