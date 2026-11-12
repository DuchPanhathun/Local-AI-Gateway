"""The cross-platform changes to the two gateways (packaging/patches), against real processes.

    python -m unittest discover packaging/tests

Run it where the package is meant to run (Linux, macOS, Windows), with the patched gateways
on the path, which is what `npm run build:package` leaves in packaging/local-ai-gateway/gateways
(GATEWAYS below; override with LOCAL_AI_GATEWAY_GATEWAYS) and the gateways' own packages
installed (psutil, and playwright for the web gateway's tests, which are skipped without it).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
GATEWAYS = Path(os.environ.get("LOCAL_AI_GATEWAY_GATEWAYS") or HERE.parent / "local-ai-gateway" / "gateways")
sys.path[:0] = [str(GATEWAYS / "local-agent" / "src"), str(GATEWAYS / "chatgpt-web" / "src")]

import psutil  # noqa: E402

from local_agent_gateway import runner  # noqa: E402
from local_agent_gateway.errors import BadRequest, CliTimeout  # noqa: E402

# A program that starts a child of its own (like a CLI starting a shell) and says its pid.
PARENT_AND_CHILD = (
    "import subprocess, sys, time\n"
    "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
    "print(child.pid, flush=True)\n"
    "time.sleep(120)\n"
)


def alive(pid: int) -> bool:
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def wait_until_gone(*pids: int, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not any(alive(pid) for pid in pids):
            return True
        time.sleep(0.1)
    return False


class RunnerTests(unittest.TestCase):
    def test_a_finished_cli_gives_its_output_and_status(self) -> None:
        argv = [sys.executable, "-c", "import sys; print(sys.stdin.read().upper(), end=''); sys.stderr.write('warn')"]
        done = asyncio.run(runner.run(argv, stdin=b"hello", cwd=None, env=os.environ, timeout_s=30))
        self.assertEqual((done.returncode, done.stdout, done.stderr), (0, "HELLO", "warn"))

    def test_a_timeout_ends_the_cli_and_what_it_started(self) -> None:
        pids: list[int] = []

        async def go() -> None:
            argv = [sys.executable, "-c", PARENT_AND_CHILD]
            with self.assertRaises(CliTimeout):
                async with runner.started(argv, stdin=b"", cwd=None, env=os.environ, timeout_s=2, grace_s=1) as cli:
                    pids.append(cli.proc.pid)
                    async for line in cli.lines():  # the child's pid, then silence until the timeout
                        pids.append(int(line))

        asyncio.run(go())
        self.assertEqual(len(pids), 2, "the parent and its child were both seen")
        self.assertTrue(wait_until_gone(*pids), f"still running: {[p for p in pids if alive(p)]}")

    def test_cancelling_a_run_ends_the_whole_tree(self) -> None:
        pids: list[int] = []

        async def go() -> None:
            async with runner.started([sys.executable, "-c", PARENT_AND_CHILD], stdin=b"", cwd=None, env=os.environ, timeout_s=60, grace_s=1) as cli:
                pids.append(cli.proc.pid)
                pids.append(int(await cli.proc.stdout.readline()))
            # leaving the block is what ends them

        asyncio.run(go())
        self.assertTrue(wait_until_gone(*pids), f"still running: {[p for p in pids if alive(p)]}")

    @unittest.skipIf(os.name == "nt", "simulates Windows on a system that has process groups")
    def test_without_process_groups_the_cli_itself_is_ended_like_its_children(self) -> None:
        # The Windows branch of _signal_tree: no os.killpg, so psutil ends the root and its descendants.
        proc = subprocess.Popen([sys.executable, "-c", PARENT_AND_CHILD], stdout=subprocess.PIPE, text=True)
        try:
            child = int(proc.stdout.readline())
            with mock.patch.object(runner.os, "killpg", create=True) as killpg:
                del runner.os.killpg  # as if it were never there
                runner._signal_tree(proc.pid, runner._descendants(proc.pid), runner._SIGKILL)
            killpg.assert_not_called()
            self.assertTrue(wait_until_gone(proc.pid, child))
        finally:
            with contextlib.suppress(psutil.Error):
                psutil.Process(proc.pid).kill()
            proc.wait()
            proc.stdout.close()

    def test_a_cmd_file_never_gets_an_argument_cmd_exe_would_run(self) -> None:
        with mock.patch.object(runner, "IS_WINDOWS", True):
            for bad in ("a&calc", "a|b", "a<b", "a>b", "a^b", "%PATH%", "a\nb"):
                with self.subTest(bad=bad), self.assertRaises(BadRequest):
                    runner._refuse_cmd_syntax(["C:\\npm\\codex.cmd", "exec", bad])
            runner._refuse_cmd_syntax(["C:\\npm\\codex.cmd", "exec", "-c", 'web_search="disabled"', "C:\\Temp\\last message.txt", "gpt-6.1-sol"])
            runner._refuse_cmd_syntax(["C:\\bin\\claude.exe", "--model", "a&b"])  # an .exe gets its arguments as they are
        with mock.patch.object(runner, "IS_WINDOWS", False):
            runner._refuse_cmd_syntax(["/usr/bin/x.cmd", "a&b"])

    def test_each_system_gets_its_own_way_to_lead_a_group(self) -> None:
        with mock.patch.object(runner, "IS_WINDOWS", False):
            self.assertEqual(runner._own_group(), {"start_new_session": True})
        with mock.patch.object(runner, "IS_WINDOWS", True), mock.patch.object(subprocess, "CREATE_NEW_PROCESS_GROUP", 512, create=True):
            self.assertEqual(runner._own_group(), {"creationflags": 512})

    def test_sigkill_exists_even_where_the_system_has_none(self) -> None:
        self.assertIsNotNone(runner._SIGKILL)


try:
    from chatgpt_web_gateway import chrome, config
except ImportError as exc:  # playwright isn't installed
    chrome = config = None
    WEB_SKIP = f"the web gateway's packages aren't installed here: {exc}"
else:
    WEB_SKIP = ""


@unittest.skipIf(WEB_SKIP, WEB_SKIP)
class WebGatewayTests(unittest.TestCase):
    def test_the_chrome_that_has_a_profile_open_is_found_by_its_command_line(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            profile = Path(folder).resolve() / "chrome-profile"
            profile.mkdir()
            browser = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)", f"--user-data-dir={profile}"])
            helper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)", f"--user-data-dir={profile}", "--type=renderer"])
            try:
                time.sleep(0.5)
                self.assertEqual(chrome._profile_owner_by_scan(profile), browser.pid, "the browser process, not its helper")
                self.assertIsNone(chrome._profile_owner_by_scan(profile / "another"))
            finally:
                browser.kill()
                helper.kill()
                browser.wait()
                helper.wait()
            self.assertIsNone(chrome._profile_owner_by_scan(profile), "gone once Chrome is closed")

    def test_chrome_is_started_apart_from_the_gateway(self) -> None:
        with mock.patch.object(chrome.subprocess, "Popen") as popen:
            chrome._spawn(["chrome"])
        options = popen.call_args.kwargs
        if os.name == "nt":
            self.assertEqual(options["creationflags"], subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
        else:
            self.assertTrue(options["start_new_session"])

    def test_the_default_profile_that_cant_be_used_is_the_one_of_each_system(self) -> None:
        home = Path("/home/mia")
        with mock.patch.object(config.Path, "home", return_value=home):
            with mock.patch.object(config.sys, "platform", "linux"):
                self.assertEqual(config._default_chrome_profile(), home / ".config" / "google-chrome")
            with mock.patch.object(config.sys, "platform", "darwin"):
                self.assertEqual(config._default_chrome_profile(), home / "Library" / "Application Support" / "Google" / "Chrome")
            with mock.patch.object(config.sys, "platform", "win32"), mock.patch.dict(os.environ, {"LOCALAPPDATA": "/win/Local"}):
                self.assertEqual(config._default_chrome_profile(), Path("/win/Local") / "Google" / "Chrome" / "User Data")


if __name__ == "__main__":
    unittest.main()
