// A chmod only bites for a non-root POSIX user: a test proving EACCES by chmod must skip elsewhere.
export const modeBitsIgnored = process.platform === 'win32' || process.getuid?.() === 0;
