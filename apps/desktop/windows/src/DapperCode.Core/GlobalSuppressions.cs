using System.Diagnostics.CodeAnalysis;

[assembly: SuppressMessage(
    "Design",
    "CA1056:URI-like properties should not be strings",
    Justification = "These properties mirror the Rust operator's JSON wire contract verbatim.",
    Scope = "member",
    Target = "~P:DapperCode.Core.Models.BridgeSnapshot.BridgeUrl")]
[assembly: SuppressMessage(
    "Design",
    "CA1056:URI-like properties should not be strings",
    Justification = "These properties mirror the Rust operator's JSON wire contract verbatim.",
    Scope = "member",
    Target = "~P:DapperCode.Core.Models.SetupResult.BridgeUrl")]
[assembly: SuppressMessage(
    "Reliability",
    "CA2025:Do not pass 'IDisposable' instances into unawaited tasks",
    Justification = "RunCoreAsync cancels and awaits every task before the socket and token sources leave scope.",
    Scope = "member",
    Target = "~M:DapperCode.Core.Services.ClientWebSocketHealthConnection.RunCoreAsync(DapperCode.Core.Models.BridgeObservationTarget,System.Action{DapperCode.Core.Models.BridgeObservedHealth},System.Threading.CancellationToken)~System.Threading.Tasks.Task")]
