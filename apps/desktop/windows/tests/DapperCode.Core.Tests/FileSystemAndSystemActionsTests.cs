using DapperCode.Core.Services;
using NSubstitute;

namespace DapperCode.Core.Tests;

[TestClass]
public sealed class FileSystemAndSystemActionsTests
{
    [TestMethod]
    public async Task ProcessRunnerUsesTheFilesystemAbstractionBeforeStarting()
    {
        using var registry = new OperatorProcessRegistry();
        var fileSystem = Substitute.For<IFileSystem>();
        fileSystem.FileExists("missing-operator.exe").Returns(false);
        var runner = new OperatorProcessRunner(registry, fileSystem);

        var error = await Assert.ThrowsAsync<OperatorException>(() =>
            runner.RunAsync(
                "missing-operator.exe",
                [],
                allowDuringShutdown: false,
                CancellationToken.None));

        StringAssert.Contains(error.Message, "unavailable", StringComparison.Ordinal);
        _ = fileSystem.Received(1).FileExists("missing-operator.exe");
    }

}
