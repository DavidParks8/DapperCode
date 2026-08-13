using System.Diagnostics;
using DapperCode.Core.Services;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.Windows.Storage.Pickers;
using Windows.ApplicationModel;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.System;

namespace DapperCode.Windows.Services;

public sealed class PackagedOperatorPathProvider : IOperatorPathProvider
{
    public string OperatorPath { get; } =
        Path.Combine(AppContext.BaseDirectory, "bin", "dappercode.exe");
}
