namespace DapperCode.Core.Services;

public interface IUiDispatcher
{
    void Post(Action action);
}
