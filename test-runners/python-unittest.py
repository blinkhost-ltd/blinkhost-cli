"""Native Python unittest adapter for BlinkHost's local customer check protocol.

Invoke this file through a structured BlinkHost check, using ordinary unittest
arguments (for example, discover -s tests). No BlinkHost account services are used.
"""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import re
import sys
import time
import unittest
import uuid

MAX_TESTS = 10_000
MAX_BYTES = 1_048_576
ERROR = "The BlinkHost Python unittest adapter could not qualify this runner result."


class CoverageOutput(io.StringIO):
    """Bound the optional library's JSON output before retaining numeric totals."""
    size = 0

    def write(self, value):
        self.size += len(value.encode("utf-8"))
        if self.size > MAX_BYTES:
            raise ValueError(ERROR)
        return super().write(value)


def start_coverage(argv):
    sources, remaining = [], [argv[0]]
    root = Path.cwd().resolve()
    for arg in argv[1:]:
        if arg == "--coverage" or arg.startswith("--coverage="):
            value = "." if arg == "--coverage" else arg.split("=", 1)[1]
            source = (root / value).resolve()
            if (not value or Path(value).is_absolute() or not source.is_relative_to(root)
                    or not source.is_dir() or len(sources) >= 16):
                raise ValueError(ERROR)
            sources.append(str(source))
        else:
            remaining.append(arg)
    if not sources:
        return None, {"status": "not_collected"}, remaining
    collector = None
    try:
        # The application supplies this optional dependency. Do not install it,
        # read ambient coverage configuration or write a coverage database.
        import coverage
        if not re.fullmatch(r"7\.\d+(?:\.\d+)?", coverage.__version__):
            raise ValueError(ERROR)
        collector = coverage.Coverage(source=list(dict.fromkeys(sources)), branch=True,
            data_file=None, config_file=False, omit=[str(Path(__file__).resolve())])
        collector.start()
    except Exception:
        if collector is not None:
            try:
                collector.stop()
            except Exception:
                pass
        collector = None
    return collector, {"status": "unavailable"}, remaining


def coverage_summary(collector, fallback, rows):
    if collector is None or not any(row["status"] in ("passed", "failed") for row in rows):
        return fallback
    try:
        with CoverageOutput() as output:
            with redirect_stdout(output):
                collector.json_report(outfile="-", pretty_print=False)
            totals = json.loads(output.getvalue())["totals"]
        metrics = {name: {"covered": totals[covered], "total": totals[total]}
            for name, covered, total in (("lines", "covered_lines", "num_statements"),
                ("branches", "covered_branches", "num_branches"))}
        for metric in metrics.values():
            if (any(type(value) is not int or not 0 <= value <= 1_000_000_000 for value in metric.values())
                    or metric["covered"] > metric["total"]):
                raise ValueError(ERROR)
        return {"status": "collected", "metrics": metrics}
    except Exception:
        # Coverage failure cannot erase real test outcomes or invent coverage.
        return fallback


def context():
    path = os.environ.get("BLINKHOST_TEST_RESULT_PATH", "")
    run_id = os.environ.get("BLINKHOST_TEST_RUN_ID", "")
    check_id = os.environ.get("BLINKHOST_TEST_CHECK_ID", "")
    if (not os.path.isabs(path) or not os.path.basename(path)
            or os.environ.get("BLINKHOST_TEST_PROFILE") != "native"
            or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", check_id)):
        raise ValueError(ERROR)
    if str(uuid.UUID(run_id)) != run_id:
        raise ValueError(ERROR)
    return path, run_id, check_id


def safe_text(value, maximum, run_context):
    value = str(value)
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    value = re.sub(r"[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]", "", value)
    value = re.sub(r"-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)",
                   "[REDACTED PRIVATE KEY]", value)
    value = re.sub(r"\b(Bearer|Basic)\s+[^\s\"'<>]+", r"\1 [REDACTED]", value, flags=re.I)
    value = re.sub(r"([\"']?(?:authorization|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)[\"']?\s*[:=]\s*)(?:\"[^\"\n]*\"|'[^'\n]*'|[^\s,;}]+)",
                   r"\1[REDACTED]", value, flags=re.I)
    value = re.sub(r"(https?://)[^\s/@]+:[^\s/@]+@", r"\1[REDACTED]@", value, flags=re.I)
    for secret in (run_context[0], os.path.dirname(run_context[0]), run_context[1]):
        value = value.replace(secret, "[LOCAL TEST CONTEXT]")
    # Screen before truncating, including complete credentials at the byte boundary.
    return value.encode("utf-8", errors="replace")[:maximum].decode("utf-8", errors="ignore").strip() or "(unavailable)"


class StructuredResult(unittest.TextTestResult):
    def __init__(self, stream, descriptions, verbosity):
        super().__init__(stream, descriptions, verbosity)
        self.run_context = context()
        self.rows = []
        self.active = None
        self.unrepresentable = False

    def startTest(self, test):
        if self.active is not None or len(self.rows) >= MAX_TESTS:
            raise ValueError(ERROR)
        if type(test).__module__ == "unittest.loader" and type(test).__name__ == "_FailedTest":
            self.unrepresentable = True
        self.active = {"test": test, "start": time.monotonic_ns(), "status": None,
                       "messages": [], "stack": None}
        super().startTest(test)

    def mark(self, test, status, message=None, error=None):
        parent = getattr(test, "test_case", test)
        if self.active is None or self.active["test"] is not parent:
            # Class/module fixture and collection failures are command failures;
            # they must never become fabricated application test records.
            self.unrepresentable = True
            return
        current = self.active
        if current["status"] != "failed":
            current["status"] = status
        if message is not None and len(current["messages"]) < 4:
            current["messages"].append(safe_text(message, 1024, self.run_context))
        if error is not None and current["stack"] is None:
            current["stack"] = safe_text(self._exc_info_to_string(error, test), 16_384, self.run_context)

    def addSuccess(self, test):
        super().addSuccess(test)
        self.mark(test, "passed")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.mark(test, "failed", str(err[1]), err)

    def addError(self, test, err):
        super().addError(test, err)
        self.mark(test, "failed", str(err[1]), err)

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        if getattr(test, "test_case", None) is not None:
            # Subtests remain part of one declared parent test, matching testsRun.
            if self.active is None or self.active["test"] is not test.test_case:
                self.unrepresentable = True
            else:
                if self.active["status"] is None:
                    self.active["status"] = "skipped"
                if len(self.active["messages"]) < 4:
                    self.active["messages"].append(safe_text("Skipped subtest: " + reason, 1024, self.run_context))
        else:
            self.mark(test, "skipped", reason)

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self.mark(test, "skipped", "Expected failure", err)

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.mark(test, "failed", "Unexpected success of an expected-failure test")

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            self.mark(test, "failed", str(err[1]), err)
        else:
            self.mark(test, "passed")

    def stopTest(self, test):
        current = self.active
        if current is None or current["test"] is not test:
            raise ValueError(ERROR)
        if current["status"] is None:
            # unittest calls stopTest while a KeyboardInterrupt propagates. Keep
            # cancellation intact and refuse an incomplete successful report.
            self.unrepresentable = True
            self.active = None
            super().stopTest(test)
            return
        duration = (time.monotonic_ns() - current["start"]) // 1_000_000
        if not 0 <= duration <= 1_000_000_000:
            raise ValueError(ERROR)
        row = {"id": "python-" + str(len(self.rows) + 1),
               "name": safe_text(test.id(), 1024, self.run_context),
               "status": current["status"], "duration_ms": duration}
        if current["messages"]:
            row["message"] = safe_text("\n".join(current["messages"]), 4096, self.run_context)
        if current["stack"]:
            row["stack"] = current["stack"]
        self.rows.append(row)
        self.active = None
        super().stopTest(test)

    def write_report(self, coverage=None):
        if self.active is not None or self.unrepresentable or len(self.rows) != self.testsRun:
            raise ValueError(ERROR)
        if self.wasSuccessful() != (not any(row["status"] == "failed" for row in self.rows)):
            raise ValueError(ERROR)
        path, run_id, check_id = self.run_context
        encoded = json.dumps({"schema": "blinkhost.local-test-results/v1", "run_id": run_id,
                              "check_id": check_id, "profile": "native",
                              "runner": "python:unittest/" + sys.version.split()[0], "tests": self.rows,
                              "coverage": coverage or {"status": "not_collected"}}, ensure_ascii=True).encode("utf-8")
        if len(encoded) > MAX_BYTES:
            raise ValueError(ERROR)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags, 0o600), "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())


class StructuredRunner(unittest.TextTestRunner):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, resultclass=StructuredResult, **kwargs)


def main():
    try:
        context()  # Validate profile/context before importing any customer tests.
        if sys.version_info < (3, 10):
            raise ValueError(ERROR)
        sys.path.insert(0, os.getcwd())
        collector, coverage, argv = start_coverage(sys.argv)
        try:
            program = unittest.TestProgram(module=None, argv=argv, testRunner=StructuredRunner, exit=False)
        finally:
            if collector is not None:
                try:
                    collector.stop()
                except Exception:
                    collector = None
        program.result.write_report(coverage_summary(collector, coverage, program.result.rows))
        return 0 if program.result.wasSuccessful() else 1
    except KeyboardInterrupt:
        return 130
    except (Exception, SystemExit):
        # Do not expose result paths, raw parser exceptions or run identifiers.
        print(ERROR, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
