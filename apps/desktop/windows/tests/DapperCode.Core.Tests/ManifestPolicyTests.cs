using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace DapperCode.Core.Tests;

[TestClass]
public sealed class ManifestPolicyTests
{
    private static readonly string WindowsRoot = Path.GetFullPath(
        Path.Combine(Path.GetDirectoryName(CurrentSourcePath())!, "..", ".."));
    private static readonly string AppProject = Path.Combine(
        WindowsRoot,
        "src",
        "DapperCode.Windows");
    private static readonly string CoreProject = Path.Combine(
        WindowsRoot,
        "src",
        "DapperCode.Core");

    [TestMethod]
    public void CSharpFilesContainAtMostOneTopLevelType()
    {
        var topLevelType = new Regex(
            @"^(?:public|internal)\s+(?:(?:abstract|partial|readonly|ref|sealed|static|unsafe)\s+)*(?:class|enum|interface|record(?:\s+(?:class|struct))?|struct)\b",
            RegexOptions.Multiline);
        var violations = Directory
            .EnumerateFiles(WindowsRoot, "*.cs", SearchOption.AllDirectories)
            .Where(path =>
                !path.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                    .Any(component => component is "bin" or "obj"))
            .Select(path => new
            {
                Path = Path.GetRelativePath(WindowsRoot, path),
                Count = topLevelType.Count(File.ReadAllText(path)),
            })
            .Where(file => file.Count > 1)
            .Select(file => $"{file.Path} ({file.Count} types)")
            .ToArray();

        Assert.AreEqual(
            0,
            violations.Length,
            $"C# files with multiple top-level types:{Environment.NewLine}{string.Join(Environment.NewLine, violations)}");
    }

    [TestMethod]
    public void ProductionJsonSerializationUsesGeneratedTypeMetadata()
    {
        var serializerCall = new Regex(
            @"(?:JsonSerializer\.\w+|\.Deserialize)\s*(?:<[^>]+>)?\s*\([^;]+?\)",
            RegexOptions.Singleline);
        var violations = Directory
            .EnumerateFiles(
                Path.Combine(WindowsRoot, "src"),
                "*.cs",
                SearchOption.AllDirectories)
            .Where(path =>
                !path.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                    .Any(component => component is "bin" or "obj"))
            .SelectMany(path => serializerCall
                .Matches(File.ReadAllText(path))
                .Where(match =>
                    !match.Value.Contains("DapperCodeJsonContext", StringComparison.Ordinal) &&
                    !match.Value.Contains("jsonTypeInfo", StringComparison.Ordinal))
                .Select(match =>
                    $"{Path.GetRelativePath(WindowsRoot, path)}: {match.Value}"))
            .ToArray();

        Assert.AreEqual(
            0,
            violations.Length,
            $"Production JSON calls without generated type metadata:{Environment.NewLine}" +
            string.Join(Environment.NewLine, violations));
    }

    [TestMethod]
    public void NativeImportsAreCentralizedInNativeMethods()
    {
        var nativeImport = new Regex(
            @"\[\s*(?:System\.Runtime\.InteropServices\.)?(?:DllImport|LibraryImport)(?:Attribute)?\s*\(");
        var nativeMethodsPath = Path.Combine(
            AppProject,
            "Services",
            "NativeMethods.cs");
        var imports = Directory
            .EnumerateFiles(WindowsRoot, "*.cs", SearchOption.AllDirectories)
            .Where(path =>
                !path.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                    .Any(component => component is "bin" or "obj"))
            .SelectMany(path => nativeImport
                .Matches(File.ReadAllText(path))
                .Select(_ => path))
            .ToArray();

        Assert.IsTrue(imports.Length > 0, "No native import attributes were found.");
        Assert.IsTrue(
            imports.All(path =>
                string.Equals(path, nativeMethodsPath, StringComparison.OrdinalIgnoreCase)),
            $"Native import attributes outside NativeMethods.cs:{Environment.NewLine}" +
            string.Join(
                Environment.NewLine,
                imports
                    .Where(path => !string.Equals(
                        path,
                        nativeMethodsPath,
                        StringComparison.OrdinalIgnoreCase))
                    .Select(path => Path.GetRelativePath(WindowsRoot, path))
                    .Distinct()));
    }

    [TestMethod]
    public void NativeInteropIsSourceGeneratedAndUsesWin32Widths()
    {
        var source = File.ReadAllText(Path.Combine(
            AppProject,
            "Services",
            "NativeMethods.cs"));

        StringAssert.Contains(source, "[Library" + "Import(", StringComparison.Ordinal);
        StringAssert.Contains(source, "SafeWaitHandle CreateEventW(", StringComparison.Ordinal);
        StringAssert.Contains(source, "uint handleCount", StringComparison.Ordinal);
        Assert.IsFalse(source.Contains("[Dll" + "Import(", StringComparison.Ordinal));
        Assert.IsFalse(source.Contains("ulong handleCount", StringComparison.Ordinal));
    }

    [TestMethod]
    public void WinRtOperationsForwardCancellationTokens()
    {
        foreach (var relativePath in new[]
                 {
                     "Services/WindowsFilePickerService.cs",
                     "Services/WindowsStartupService.cs",
                     "Services/WindowsSystemActions.cs",
                     "Services/BrokerEndpointReplacementConfirmationService.cs",
                 })
        {
            var source = File.ReadAllText(Path.Combine(
                AppProject,
                relativePath.Replace('/', Path.DirectorySeparatorChar)));

            StringAssert.Contains(source, ".AsTask(cancellationToken)", StringComparison.Ordinal);
        }
    }

    [TestMethod]
    public void SelectedDesktopPackagesAreCentrallyPinnedAndReferenced()
    {
        var packageVersions = XDocument.Load(Path.Combine(
            WindowsRoot,
            "Directory.Packages.props"));
        AssertPackageVersion(packageVersions, "CommunityToolkit.Mvvm", "8.4.2");
        AssertPackageVersion(packageVersions, "H.NotifyIcon.WinUI", "2.4.1");
        AssertPackageVersion(
            packageVersions,
            "Microsoft.Extensions.DependencyInjection",
            "10.0.11");

        AssertPackageReference(
            XDocument.Load(Path.Combine(CoreProject, "DapperCode.Core.csproj")),
            "CommunityToolkit.Mvvm");
        AssertPackageReference(
            XDocument.Load(Path.Combine(AppProject, "DapperCode.Windows.csproj")),
            "H.NotifyIcon.WinUI");
        AssertPackageReference(
            XDocument.Load(Path.Combine(AppProject, "DapperCode.Windows.csproj")),
            "Microsoft.Extensions.DependencyInjection");
    }

    [TestMethod]
    public void AppCompositionUsesDependencyInjection()
    {
        var source = File.ReadAllText(Path.Combine(AppProject, "App.xaml.cs"));

        StringAssert.Contains(source, "new ServiceCollection()", StringComparison.Ordinal);
        StringAssert.Contains(source, "ValidateOnBuild = true", StringComparison.Ordinal);
        StringAssert.Contains(
            source,
            "GetRequiredService<MainViewModel>()",
            StringComparison.Ordinal);
        StringAssert.Contains(
            source,
            "AddSingleton<IOperatorClient, OperatorClient>()",
            StringComparison.Ordinal);
        StringAssert.Contains(
            source,
            "AddSingleton<IBridgeHealthObserver, BridgeHealthObserver>()",
            StringComparison.Ordinal);
        StringAssert.Contains(source, "AddSingleton<TrayIconService>()", StringComparison.Ordinal);
        Assert.IsFalse(source.Contains("new MainViewModel(", StringComparison.Ordinal));
        Assert.IsFalse(source.Contains("new OperatorClient(", StringComparison.Ordinal));
        Assert.IsFalse(source.Contains("new BridgeHealthObserver(", StringComparison.Ordinal));
    }

    [TestMethod]
    public void WindowsShellOwnsBrokerLifecycleWithoutManualControls()
    {
        var viewModel = File.ReadAllText(Path.Combine(
            CoreProject,
            "ViewModels",
            "MainViewModel.cs"));
        var snapshot = File.ReadAllText(Path.Combine(
            CoreProject,
            "Models",
            "BridgeSnapshot.cs"));
        var app = File.ReadAllText(Path.Combine(AppProject, "App.xaml.cs"));
        var window = File.ReadAllText(Path.Combine(AppProject, "MainWindow.xaml"));
        var tray = File.ReadAllText(Path.Combine(
            AppProject,
            "Services",
            "TrayIconService.cs"));

        StringAssert.Contains(viewModel, "EnsureBrokerRunningAsync", StringComparison.Ordinal);
        StringAssert.Contains(
            viewModel,
            "ReconcileAfterDisconnectAsync",
            StringComparison.Ordinal);
        StringAssert.Contains(window, "Set up DapperCode", StringComparison.Ordinal);
        StringAssert.Contains(
            window,
            "The broker runs while DapperCode is open and stops when it quits.",
            StringComparison.Ordinal);
        StringAssert.Contains(
            tray,
            "Broker follows DapperCode's lifetime",
            StringComparison.Ordinal);
        Assert.IsFalse(snapshot.Contains("AutoStart", StringComparison.Ordinal));
        foreach (var prohibited in new[]
                 {
                     "PrimaryActionCommand",
                     "PerformPrimaryActionAsync",
                     "RestartCommand",
                     "RestartRequested",
                     "S&top broker",
                     "S&tart broker",
                     "&Restart broker",
                 })
        {
            Assert.IsFalse(
                viewModel.Contains(prohibited, StringComparison.Ordinal) ||
                app.Contains(prohibited, StringComparison.Ordinal) ||
                window.Contains(prohibited, StringComparison.Ordinal) ||
                tray.Contains(prohibited, StringComparison.Ordinal),
                $"Windows shell contains manual broker control '{prohibited}'.");
        }
    }

    [TestMethod]
    public void CommunityToolkitOwnsMvvmInfrastructure()
    {
        foreach (var fileName in new[]
                 {
                     "AsyncCommand.cs",
                     "ObservableObject.cs",
                     "RelayCommand.cs",
                 })
        {
            Assert.IsFalse(File.Exists(Path.Combine(
                CoreProject,
                "ViewModels",
                fileName)));
        }

        var source = File.ReadAllText(Path.Combine(
            CoreProject,
            "ViewModels",
            "MainViewModel.cs"));
        StringAssert.Contains(
            source,
            "using CommunityToolkit.Mvvm.ComponentModel;",
            StringComparison.Ordinal);
        StringAssert.Contains(
            source,
            "using CommunityToolkit.Mvvm.Input;",
            StringComparison.Ordinal);
        StringAssert.Contains(
            source,
            "public sealed class MainViewModel : ObservableObject",
            StringComparison.Ordinal);
        StringAssert.Contains(source, "AsyncRelayCommand", StringComparison.Ordinal);
        StringAssert.Contains(source, "RelayCommand<BridgeSnapshot>", StringComparison.Ordinal);
        Assert.IsFalse(source.Contains("RaiseCanExecuteChanged", StringComparison.Ordinal));
    }

    [TestMethod]
    public void NotifyIconPackageOwnsTrayIntegration()
    {
        var traySource = File.ReadAllText(Path.Combine(
            AppProject,
            "Services",
            "TrayIconService.cs"));
        StringAssert.Contains(traySource, "using H.NotifyIcon;", StringComparison.Ordinal);
        StringAssert.Contains(traySource, "new TaskbarIcon", StringComparison.Ordinal);
        StringAssert.Contains(traySource, "MenuFlyout", StringComparison.Ordinal);
        StringAssert.Contains(traySource, "ContextFlyout = _menu", StringComparison.Ordinal);
        StringAssert.Contains(traySource, "ForceCreate", StringComparison.Ordinal);
        StringAssert.Contains(traySource, "_taskbarIcon.Dispose()", StringComparison.Ordinal);
        Assert.IsFalse(traySource.Contains("DllImport", StringComparison.Ordinal));
        Assert.IsFalse(traySource.Contains("NifGuid", StringComparison.OrdinalIgnoreCase));
        Assert.IsFalse(traySource.Contains("NIF_GUID", StringComparison.OrdinalIgnoreCase));

        var appSource = File.ReadAllText(Path.Combine(AppProject, "App.xaml.cs"));
        Assert.IsFalse(appSource.Contains(
            "SystemShutdownRequested",
            StringComparison.Ordinal));
        StringAssert.Contains(
            appSource,
            "AppDomain.CurrentDomain.ProcessExit += OnProcessExit;",
            StringComparison.Ordinal);

        foreach (var fileName in new[]
                 {
                     "NativePoint.cs",
                     "NotifyIconData.cs",
                     "SubclassProcedure.cs",
                 })
        {
            Assert.IsFalse(File.Exists(Path.Combine(
                AppProject,
                "Services",
                fileName)));
        }
    }

    [TestMethod]
    public void NativeMethodsContainsNoTrayInterop()
    {
        var source = File.ReadAllText(Path.Combine(
            AppProject,
            "Services",
            "NativeMethods.cs"));
        var obsoleteTrayInterop = new[]
        {
            "Shell_NotifyIcon",
            "SetWindowSubclass",
            "RemoveWindowSubclass",
            "DefSubclassProc",
            "RegisterWindowMessage",
            "LoadImage",
            "DestroyIcon",
            "CreatePopupMenu",
            "DestroyMenu",
            "AppendMenu",
            "SetMenuDefaultItem",
            "TrackPopupMenu",
            "GetCursorPos",
            "PostMessage",
            "GetDpiForWindow",
            "GetSystemMetricsForDpi",
        };

        foreach (var value in obsoleteTrayInterop)
        {
            Assert.IsFalse(
                source.Contains(value, StringComparison.Ordinal),
                $"NativeMethods still contains tray interop '{value}'.");
        }
    }

    [TestMethod]
    public void PackagedAppRunsAsTheCurrentUserWithoutElevation()
    {
        var manifest = XDocument.Load(Path.Combine(AppProject, "app.manifest"));
        var executionLevel = manifest
            .Descendants()
            .Single(element => element.Name.LocalName == "requestedExecutionLevel");

        Assert.AreEqual("asInvoker", executionLevel.Attribute("level")?.Value);
        Assert.AreEqual("false", executionLevel.Attribute("uiAccess")?.Value);
    }

    [TestMethod]
    public void StartupRegistrationIsPerUserDisabledAndNotAnOsService()
    {
        var manifest = XDocument.Load(Path.Combine(AppProject, "Package.appxmanifest"));
        var extensions = manifest
            .Descendants()
            .Where(element => element.Name.LocalName == "Extension")
            .ToArray();
        var startupExtension = extensions.Single(element =>
            element.Attribute("Category")?.Value == "windows.startupTask");
        var startupTask = startupExtension
            .Descendants()
            .Single(element => element.Name.LocalName == "StartupTask");

        Assert.AreEqual("false", startupTask.Attribute("Enabled")?.Value);
        Assert.IsFalse(extensions.Any(element =>
            element.Attribute("Category")?.Value.Contains(
                "service",
                StringComparison.OrdinalIgnoreCase) == true));
    }

    [TestMethod]
    public void WindowsShellContainsNoMachineScopedOrAdministrativeIntegration()
    {
        var prohibited = new[]
        {
            "CreateService",
            "OpenSCManager",
            "ServiceController",
            "HKEY_LOCAL_MACHINE",
            "Registry.LocalMachine",
            "CommonApplicationData",
            "requireAdministrator",
            "highestAvailable",
            "schtasks",
            "TaskScheduler",
            "netsh",
        };
        var source = Directory
            .EnumerateFiles(AppProject, "*", SearchOption.AllDirectories)
            .Where(path =>
                !path.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                    .Any(component => component is "bin" or "obj") &&
                (Path.GetExtension(path) is ".cs" or ".xaml" or ".csproj" or
                    ".manifest" or ".appxmanifest"))
            .SelectMany(path => File.ReadLines(path).Select(line => (path, line)));

        foreach (var (path, line) in source)
        {
            foreach (var value in prohibited)
            {
                Assert.IsFalse(
                    line.Contains(value, StringComparison.OrdinalIgnoreCase),
                    $"{Path.GetRelativePath(WindowsRoot, path)} contains prohibited integration '{value}'.");
            }
        }
    }

    [TestMethod]
    public void PolicyEnabledStartupIsReportedAsEnabled()
    {
        var source = File.ReadAllText(Path.Combine(
            AppProject,
            "Services",
            "WindowsStartupService.cs"));

        source = source.Replace("\r\n", "\n", StringComparison.Ordinal);
        StringAssert.Contains(
            source,
            "StartupTaskState.EnabledByPolicy => new(",
            StringComparison.Ordinal);
        StringAssert.Contains(source, "true,\n            false,", StringComparison.Ordinal);
    }

    private static void AssertPackageVersion(
        XDocument document,
        string package,
        string version)
    {
        var reference = document
            .Descendants("PackageVersion")
            .Single(element => element.Attribute("Include")?.Value == package);
        Assert.AreEqual(version, reference.Attribute("Version")?.Value);
    }

    private static void AssertPackageReference(XDocument document, string package)
    {
        Assert.IsTrue(document
            .Descendants("PackageReference")
            .Any(element => element.Attribute("Include")?.Value == package));
    }

    private static string CurrentSourcePath([CallerFilePath] string path = "") => path;
}
