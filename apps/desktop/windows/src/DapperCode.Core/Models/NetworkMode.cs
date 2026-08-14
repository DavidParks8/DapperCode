using System.Text.Json.Serialization;

namespace DapperCode.Core.Models;

[JsonConverter(typeof(JsonStringEnumConverter<NetworkMode>))]
public enum NetworkMode
{
    [JsonStringEnumMemberName("tailscale")]
    Tailscale,

    [JsonStringEnumMemberName("local")]
    Local,
}
