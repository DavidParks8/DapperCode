namespace DapperCode.Core.Services;

public sealed record ProcessExecutionResult(int ExitCode, string StandardOutput, string StandardError);
