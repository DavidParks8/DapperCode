namespace DapperCode.Core.Services;

public interface IQrCodeService
{
    byte[] RenderPng(string payload);
}
