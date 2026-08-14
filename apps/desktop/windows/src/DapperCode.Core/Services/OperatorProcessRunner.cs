using System.Diagnostics;
using System.Text;

namespace DapperCode.Core.Services;

/// <summary>
/// Runs the bundled operator without a shell while tracking it for coordinated application
/// shutdown and draining both redirected streams concurrently.
/// </summary>
public sealed class OperatorProcessRunner(
    OperatorProcessRegistry registry,
    IFileSystem fileSystem) : IOperatorProcessRunner
{
    public async Task<ProcessExecutionResult> RunAsync(
        string executable,
        IReadOnlyList<string> arguments,
        bool allowDuringShutdown,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(executable);
        ArgumentNullException.ThrowIfNull(arguments);
        if (!fileSystem.FileExists(executable))
        {
            throw OperatorException.Unavailable(executable);
        }

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = executable,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = AppContext.BaseDirectory,
            },
            EnableRaisingEvents = true,
        };
        foreach (var argument in arguments)
        {
            process.StartInfo.ArgumentList.Add(argument);
        }

        using var linkedCancellation = allowDuringShutdown
            ? CancellationTokenSource.CreateLinkedTokenSource(cancellationToken)
            : CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken,
                registry.ShutdownToken);

        if (!process.Start())
        {
            throw new OperatorException("Windows could not start the bundled DapperCode operator.");
        }

        try
        {
            registry.Register(process, allowDuringShutdown);
        }
        catch
        {
            OperatorProcessRegistry.TryKill(process);
            throw;
        }

        // Readers intentionally outlive cancellation long enough to drain after the child is killed.
        var stdoutTask = process.StandardOutput.ReadToEndAsync(CancellationToken.None);
        var stderrTask = process.StandardError.ReadToEndAsync(CancellationToken.None);
        try
        {
            await process.WaitForExitAsync(linkedCancellation.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            OperatorProcessRegistry.TryKill(process);
            try
            {
                await process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
            }
            catch (InvalidOperationException)
            {
            }

            _ = await stdoutTask.ConfigureAwait(false);
            _ = await stderrTask.ConfigureAwait(false);
            throw;
        }
        finally
        {
            registry.Unregister(process);
        }

        var output = await stdoutTask.ConfigureAwait(false);
        var error = await stderrTask.ConfigureAwait(false);
        return new ProcessExecutionResult(process.ExitCode, output, error);
    }
}
