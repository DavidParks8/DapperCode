using DapperCode.Core.Services;

namespace DapperCode.Windows.Services;

public sealed class PackagedOperatorPathProvider : IOperatorPathProvider
{
    public string OperatorPath { get; } =
        Path.Combine(AppContext.BaseDirectory, "bin", "dappercode.exe");
}
