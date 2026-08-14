using System.Text.Json.Serialization;

namespace DapperCode.Core.Models;

internal sealed record PairingPayload
{
    [JsonPropertyName("type")]
    public string Type { get; init; } = string.Empty;

    [JsonPropertyName("bridgeUrl")]
    public string BridgeUrl { get; init; } = string.Empty;

    [JsonPropertyName("bridgeToken")]
    public string BridgeToken { get; init; } = string.Empty;

    [JsonPropertyName("workspaceId")]
    public string? WorkspaceId { get; init; }
}
