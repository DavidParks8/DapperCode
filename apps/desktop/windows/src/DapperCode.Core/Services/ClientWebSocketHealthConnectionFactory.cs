namespace DapperCode.Core.Services;

public sealed class ClientWebSocketHealthConnectionFactory : IBridgeHealthConnectionFactory
{
    public IBridgeHealthConnection Create() => new ClientWebSocketHealthConnection();
}
