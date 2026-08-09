using System.Text.Json.Serialization;

namespace DapperCode.Core.Services;

internal sealed record BrokerHealthRequest
{
    [JsonPropertyName("id")]
    public required string Id { get; init; }

    [JsonPropertyName("method")]
    public string Method { get; init; } = "bridge/health/read";

    [JsonPropertyName("params")]
    public BrokerHealthRequestParameters Parameters { get; init; } = new();
}
