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

public sealed class WindowsUserSettings : IUserSettings
{
    private const string WorkspaceKey = "workspace";
    private readonly ApplicationDataContainer _settings =
        ApplicationData.Current.LocalSettings;

    public string Workspace
    {
        get => _settings.Values[WorkspaceKey] as string
            ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        set => _settings.Values[WorkspaceKey] = value;
    }
}
