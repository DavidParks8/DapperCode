using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

public sealed record StartupStatus(bool IsEnabled, bool CanEnable, string? Message = null);
