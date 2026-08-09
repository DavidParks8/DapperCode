using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;

namespace DapperCode.Core.Services;

public sealed record ProcessExecutionResult(int ExitCode, string StandardOutput, string StandardError);
