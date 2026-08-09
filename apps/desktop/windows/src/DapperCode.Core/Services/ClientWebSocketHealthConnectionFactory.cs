using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

public sealed class ClientWebSocketHealthConnectionFactory : IBridgeHealthConnectionFactory
{
    public IBridgeHealthConnection Create() => new ClientWebSocketHealthConnection();
}
