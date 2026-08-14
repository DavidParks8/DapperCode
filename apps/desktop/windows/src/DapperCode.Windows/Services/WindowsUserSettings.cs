using DapperCode.Core.Services;
using Windows.Storage;

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
