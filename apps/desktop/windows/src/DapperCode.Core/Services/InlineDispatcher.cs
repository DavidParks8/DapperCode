using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

public sealed class InlineDispatcher : IUiDispatcher
{
    public void Post(Action action) => action();
}
