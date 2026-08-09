using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

public interface IUiDispatcher
{
    void Post(Action action);
}
