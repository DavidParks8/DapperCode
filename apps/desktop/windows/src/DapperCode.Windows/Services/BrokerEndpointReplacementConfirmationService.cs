using System.Globalization;
using DapperCode.Core.Models;
using DapperCode.Core.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace DapperCode.Windows.Services;

public sealed class BrokerEndpointReplacementConfirmationService(
    Func<XamlRoot?> xamlRoot) : IBrokerEndpointReplacementConfirmation
{
    public async Task<bool> ConfirmReplacementAsync(
        BrokerEndpointConfiguration current,
        BrokerEndpointConfiguration replacement,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var dialog = new ContentDialog
        {
            XamlRoot = xamlRoot() ?? throw new InvalidOperationException(
                "The DapperCode window is not ready to show endpoint confirmation."),
            Title = "Replace the shared broker endpoint?",
            Content = new TextBlock
            {
                Text =
                    $"Change the broker from {Describe(current)} to {Describe(replacement)}? " +
                    "This shared endpoint is used by every configured workspace, and connected " +
                    "phones may need to pair again. DapperCode will stop the running broker before " +
                    "applying this change.",
                TextWrapping = TextWrapping.Wrap,
                MaxWidth = 480,
            },
            PrimaryButtonText = "Replace endpoint",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
        };

        var result = await dialog.ShowAsync();
        cancellationToken.ThrowIfCancellationRequested();
        return result == ContentDialogResult.Primary;
    }

    private static string Describe(BrokerEndpointConfiguration endpoint)
    {
        var network = endpoint.NetworkMode == NetworkMode.Tailscale
            ? "Tailscale"
            : "the local network";
        var host = string.IsNullOrWhiteSpace(endpoint.Host)
            ? "an automatically detected host"
            : endpoint.Host;
        var port = endpoint.BridgePort?.ToString(CultureInfo.InvariantCulture) ??
            "an automatically allocated port";
        return $"{network} at {host}, port {port}";
    }
}
