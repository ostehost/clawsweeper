// Test harness setup shared by package scripts.
//
// The suite creates temporary git repositories and makes test commits. User-level
// git hooks (for example a global Conventional Commit hook configured through
// core.hooksPath) must not leak into those fixtures. Set GIT_CONFIG_GLOBAL to the
// platform null device before test files run so child git processes inherit a
// hermetic config. Keep this in Node instead of POSIX inline env assignment so
// package scripts remain portable to Windows.
process.env.GIT_CONFIG_GLOBAL ??= process.platform === "win32" ? "NUL" : "/dev/null";
