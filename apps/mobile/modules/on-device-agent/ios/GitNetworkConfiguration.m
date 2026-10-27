#include "GitNetworkConfiguration.h"
#include <git2.h>

int32_t DapperGitConfigureNetworkTimeouts(void) {
  int result = git_libgit2_opts(GIT_OPT_SET_SERVER_CONNECT_TIMEOUT, 15000);
  return result < 0 ? result : git_libgit2_opts(GIT_OPT_SET_SERVER_TIMEOUT, 15000);
}
