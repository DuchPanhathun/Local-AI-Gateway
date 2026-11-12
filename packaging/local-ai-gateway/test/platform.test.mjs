// node --test packaging/local-ai-gateway/test
// The Windows and macOS answers, checked from any computer: nothing here touches the real
// file system or starts a program.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browserCommand,
  chromeFiles,
  cliFiles,
  expandHome,
  findChrome,
  findCli,
  findPython,
  killTree,
  pythonCandidates,
  tarCommand,
  terminate,
  venvPython,
  which,
  withExtensions,
} from "../bin/platform.mjs";

const having = (...files) => {
  const set = new Set(files);
  return (file) => set.has(file);
};

test("a Windows name is tried with each extension that can start, .exe first", () => {
  assert.deepEqual(withExtensions("C:\\bin\\claude", "win32"), ["C:\\bin\\claude.exe", "C:\\bin\\claude.cmd", "C:\\bin\\claude.bat", "C:\\bin\\claude.com"]);
  assert.deepEqual(withExtensions("C:\\bin\\codex.CMD", "win32"), ["C:\\bin\\codex.CMD"]);
  assert.deepEqual(withExtensions("python3.13", "win32")[0], "python3.13.exe", "a dot in the name is not an extension");
  assert.deepEqual(withExtensions("/usr/bin/claude", "linux"), ["/usr/bin/claude"]);
});

test("which on Windows reads PATH in any case, drops quotes, and finds npm's .cmd shim", () => {
  const env = { Path: 'C:\\Windows;"C:\\Users\\Mia Lee\\AppData\\Roaming\\npm";;C:\\tools' };
  const found = which("codex", { platform: "win32", env, check: having("C:\\Users\\Mia Lee\\AppData\\Roaming\\npm\\codex.cmd") });
  assert.equal(found, "C:\\Users\\Mia Lee\\AppData\\Roaming\\npm\\codex.cmd");
});

test("which on Windows prefers claude.exe over claude.cmd in the same folder, and an earlier folder over both", () => {
  const env = { PATH: "C:\\a;C:\\b" };
  assert.equal(which("claude", { platform: "win32", env, check: having("C:\\a\\claude.cmd", "C:\\a\\claude.exe") }), "C:\\a\\claude.exe");
  assert.equal(which("claude", { platform: "win32", env, check: having("C:\\b\\claude.exe", "C:\\a\\claude.cmd") }), "C:\\a\\claude.cmd");
  assert.equal(which("claude", { platform: "win32", env, check: having() }), null);
});

test("which on Linux and macOS looks for the bare name along PATH", () => {
  const env = { PATH: "/usr/local/bin:/usr/bin" };
  assert.equal(which("claude", { platform: "linux", env, check: having("/usr/bin/claude") }), "/usr/bin/claude");
  assert.equal(which("claude", { platform: "darwin", env, check: having("/usr/bin/claude.exe") }), null);
});

test("a CLI is also found where its own installer or npm puts it", () => {
  const cli = { cmd: "claude", also: [] };
  const home = "C:\\Users\\Mia";
  const env = { APPDATA: "C:\\Users\\Mia\\AppData\\Roaming" };
  assert.deepEqual(cliFiles(cli, { platform: "win32", env, home }), ["C:\\Users\\Mia\\AppData\\Roaming\\npm\\claude", "C:\\Users\\Mia\\.local\\bin\\claude"]);
  assert.equal(findCli(cli, { platform: "win32", env: { PATH: "" }, home, check: having("C:\\Users\\Mia\\.local\\bin\\claude.exe") }), "C:\\Users\\Mia\\.local\\bin\\claude.exe");

  const agy = { cmd: "agy", also: [".gemini/bin/agy", ".local/bin/agy"] };
  assert.deepEqual(cliFiles(agy, { platform: "linux", env: {}, home: "/home/mia" }), ["/home/mia/.gemini/bin/agy", "/home/mia/.local/bin/agy"]);
  assert.equal(findCli(agy, { platform: "darwin", env: { PATH: "" }, home: "/Users/mia", check: having("/Users/mia/.local/bin/agy") }), "/Users/mia/.local/bin/agy");
});

test("the Python environment's interpreter is in Scripts on Windows and bin elsewhere", () => {
  assert.equal(venvPython("C:\\Users\\Mia\\.local-ai-gateway\\venv", "win32"), "C:\\Users\\Mia\\.local-ai-gateway\\venv\\Scripts\\python.exe");
  assert.equal(venvPython("/home/mia/.local-ai-gateway/venv", "linux"), "/home/mia/.local-ai-gateway/venv/bin/python");
  assert.equal(venvPython("/Users/mia/.local-ai-gateway/venv", "darwin"), "/Users/mia/.local-ai-gateway/venv/bin/python");
});

test("Python is looked for through the py launcher on Windows", () => {
  const windows = pythonCandidates("win32");
  assert.deepEqual(windows[0], { cmd: "py", args: ["-3.13"] });
  assert.ok(windows.findIndex((c) => c.cmd === "python") > windows.findIndex((c) => c.cmd === "py" && c.args[0] === "-3"), "the Store's stub python comes after py");
  assert.deepEqual(pythonCandidates("linux")[0], { cmd: "python3.13", args: [] });
});

test("findPython takes the first Python that is 3.11 or newer and skips the rest", () => {
  const asked = [];
  const versions = { "py -3.13": null, "py -3.12": 310, "py -3.11": 312 }; // null: not installed (status 103)
  const run = (cmd, args) => {
    const key = `${cmd} ${args[0]}`;
    asked.push(key);
    const version = versions[key];
    return version === null ? { status: 103, stdout: "" } : { status: 0, stdout: `${version}\n` };
  };
  assert.deepEqual(findPython({ platform: "win32", run }), { cmd: "py", args: ["-3.11"] });
  assert.deepEqual(asked, ["py -3.13", "py -3.12", "py -3.11"]);
  assert.equal(findPython({ platform: "linux", run: () => ({ status: null, error: new Error("ENOENT") }) }), null);
  assert.equal(findPython({ platform: "darwin", run: () => ({ status: 0, stdout: "309" }) }), null, "macOS's own python3 is 3.9");
});

test("Chrome is looked for where each system installs it", () => {
  const windows = chromeFiles({
    platform: "win32",
    home: "C:\\Users\\Mia",
    env: { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramW6432: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\Mia\\AppData\\Local" },
  });
  assert.equal(windows[0], "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  assert.ok(windows.includes("C:\\Users\\Mia\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"));
  assert.equal(new Set(windows).size, windows.length, "ProgramW6432 is the same folder as ProgramFiles: listed once");
  assert.equal(findChrome({ platform: "win32", home: "C:\\Users\\Mia", env: { LOCALAPPDATA: "C:\\Users\\Mia\\AppData\\Local" }, check: having("C:\\Users\\Mia\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe") }), "C:\\Users\\Mia\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe");

  assert.equal(findChrome({ platform: "darwin", home: "/Users/mia", env: { PATH: "" }, check: having("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") }), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(findChrome({ platform: "darwin", home: "/Users/mia", env: { PATH: "" }, check: having("/Users/mia/Applications/Chromium.app/Contents/MacOS/Chromium") }), "/Users/mia/Applications/Chromium.app/Contents/MacOS/Chromium");
  assert.equal(findChrome({ platform: "linux", home: "/home/mia", env: { PATH: "/usr/bin" }, check: having("/usr/bin/chromium") }), "/usr/bin/chromium");
  assert.equal(findChrome({ platform: "linux", home: "/home/mia", env: { PATH: "/usr/bin" }, check: having() }), null);
});

test("the browser is opened the way each system does it, with the link as one argument", () => {
  const url = "http://127.0.0.1:3000/#key=abc_-123";
  assert.deepEqual(browserCommand(url, "darwin"), { cmd: "open", args: [url] });
  assert.deepEqual(browserCommand(url, "linux"), { cmd: "xdg-open", args: [url] });
  assert.deepEqual(browserCommand(url, "win32"), { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
});

test("stopping: SIGTERM then SIGKILL on Linux and macOS; on Windows no polite signal, then taskkill of the whole tree", () => {
  const signals = [];
  const child = { pid: 4242, kill: (signal) => signals.push(signal) };
  const ran = [];
  const run = (cmd, args, options) => ran.push({ cmd, args, options });

  terminate(child, "linux");
  killTree(child, { platform: "linux", run });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(ran, []);

  signals.length = 0;
  terminate(child, "win32");
  killTree(child, { platform: "win32", env: { SystemRoot: "D:\\Win" }, run });
  assert.deepEqual(signals, [], "Windows can't be sent SIGTERM; child.kill would end it without letting it clean up");
  assert.equal(ran.length, 1);
  assert.equal(ran[0].cmd, "D:\\Win\\System32\\taskkill.exe");
  assert.deepEqual(ran[0].args, ["/PID", "4242", "/T", "/F"]);

  killTree({ pid: undefined, kill: () => assert.fail("not started") }, { platform: "linux", run });
});

test("tar on Windows is the system's, so Git's GNU tar can't misread C:\\ as a remote host", () => {
  const system = "C:\\Windows\\System32\\tar.exe";
  assert.equal(tarCommand({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, exists: having(system) }), system);
  assert.equal(tarCommand({ platform: "win32", env: {}, exists: having() }), "tar");
  assert.equal(tarCommand({ platform: "darwin", exists: () => assert.fail("no lookup needed") }), "tar");
});

test("~ means the home folder in --allow, with \\ too on Windows", () => {
  assert.equal(expandHome("~/code", "/home/mia", "linux"), "/home/mia/code");
  assert.equal(expandHome("~", "/Users/mia", "darwin"), "/Users/mia");
  assert.equal(expandHome("~\\code", "C:\\Users\\Mia", "win32"), "C:\\Users\\Mia\\code");
  assert.equal(expandHome("~/code", "C:\\Users\\Mia", "win32"), "C:\\Users\\Mia/code");
  assert.equal(expandHome("~\\code", "/home/mia", "linux"), "~\\code", "a backslash is an ordinary character outside Windows");
  assert.equal(expandHome("~mia/code", "/home/mia", "linux"), "~mia/code", "another user's home is not expanded");
});
