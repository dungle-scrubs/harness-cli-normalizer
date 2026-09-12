/* Clone one regular file, with no ordinary-copy fallback. */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/clonefile.h>
#elif defined(__linux__)
#include <linux/fs.h>
#include <sys/ioctl.h>
#endif

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  int src = open(argv[1], O_RDONLY | O_NONBLOCK | O_CLOEXEC);
  if (src < 0) {
    int code = errno == ENOENT ? 3 : 4;
    perror("source");
    return code;
  }
  struct stat st;
  if (fstat(src, &st) || !S_ISREG(st.st_mode)) {
    close(src);
    fprintf(stderr, "regular source required\n");
    return 1;
  }
  int result;
#ifdef __APPLE__
  result = fclonefileat(src, AT_FDCWD, argv[2], CLONE_NOOWNERCOPY);
#elif defined(__linux__)
  int dst = open(argv[2], O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (dst < 0) { close(src); perror("destination"); return 1; }
  result = ioctl(dst, FICLONE, src);
  int saved = errno;
  if (close(dst) && !result) { result = -1; saved = errno; }
  if (result) unlink(argv[2]);
  errno = saved;
#else
  result = -1;
  errno = ENOTSUP;
#endif
  int saved_error = errno;
  close(src);
  if (result) { errno = saved_error; perror("clone"); return 1; }
  return 0;
}
