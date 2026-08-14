using System.Text.Json.Serialization;

namespace DapperCode.Core.Models;

public sealed record ObservedOperationalState
{
    [JsonPropertyName("recentErrors")]
    public IReadOnlyList<ObservedRecentError> RecentErrors { get; init; } = [];
}
