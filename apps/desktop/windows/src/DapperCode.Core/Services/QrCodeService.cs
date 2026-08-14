using QRCoder;
using System.Text;

namespace DapperCode.Core.Services;

public sealed class QrCodeService : IQrCodeService
{
    private const int MaximumPayloadBytes = 2_200;

    public byte[] RenderPng(string payload)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(payload);
        if (Encoding.UTF8.GetByteCount(payload) > MaximumPayloadBytes)
        {
            throw new ArgumentOutOfRangeException(
                nameof(payload),
                "Pairing data is too large to render as a QR code.");
        }

        using var generator = new QRCodeGenerator();
        using var data = generator.CreateQrCode(payload, QRCodeGenerator.ECCLevel.M);
        using var code = new PngByteQRCode(data);
        return code.GetGraphic(pixelsPerModule: 8);
    }
}
