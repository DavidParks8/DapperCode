using System.Text.Json.Serialization;

namespace DapperCode.Core.Models;

public sealed record AgentDiscovery
{
    [JsonPropertyName("agentId")]
    public string AgentId { get; init; } = string.Empty;

    [JsonPropertyName("executable")]
    public string Executable { get; init; } = string.Empty;
}
