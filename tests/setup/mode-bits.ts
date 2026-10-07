// POSIX mode bits are only a real permission boundary for a non-root user on a POSIX platform:
// root bypasses them, and Windows does not implement them at all. Tests that prove an EACCES by
// chmod-ing a directory must skip where the chmod would not bite, or they fail for the wrong reason.
export const modeBitsIgnored = process.platform === 'win32' || process.getuid?.() === 0;
