using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;

namespace DapperCode.Core.Services;

public interface IOperatorProcessRunner
{
    Task<ProcessExecutionResult> RunAsync(
        string executable,
        IReadOnlyList<string> arguments,
        bool allowDuringShutdown,
        CancellationToken cancellationToken);
}
