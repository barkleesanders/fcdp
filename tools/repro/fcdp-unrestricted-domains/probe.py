#!/usr/bin/env python3
"""Probe the requested CDP domains through fcdp's direct transport.

A protocol error caused by deliberately incomplete parameters still proves that
Chrome recognized and dispatched the method. Method-not-found, policy refusal,
transport failure, timeout, or proxy-synthesized output does not.
"""

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path


BASE = os.environ.get("FCDP_CDP_URL", "").rstrip("/")
PIPE_SOCKET = os.environ.get("FCDP_PIPE_SOCKET", "")
FCDP = Path(os.environ.get("FCDP_BIN", Path(__file__).resolve().parents[3] / "fcdp"))

# Each command is read-only, disables an isolated-profile feature, or intentionally
# omits required parameters so Chrome rejects it before any mutation occurs.
PROBES = {
    "Animation": ("Animation.getCurrentTime", {}),
    "Autofill": ("Autofill.disable", {}),
    "BackgroundService": ("BackgroundService.stopObserving", {}),
    "BluetoothEmulation": ("BluetoothEmulation.disable", {}),
    "Browser": ("Browser.getVersion", {}),
    "Cast": ("Cast.disable", {}),
    "CrashReportContext": ("CrashReportContext.getEntries", {}),
    "DeviceAccess": ("DeviceAccess.disable", {}),
    "DeviceOrientation": ("DeviceOrientation.clearDeviceOrientationOverride", {}),
    "DOMStorage": ("DOMStorage.disable", {}),
    "EventBreakpoints": ("EventBreakpoints.removeInstrumentationBreakpoint", {}),
    "Extensions": ("Extensions.getExtensions", {}),
    "FedCm": ("FedCm.disable", {}),
    "FileSystem": ("FileSystem.getDirectory", {}),
    "HeadlessExperimental": ("HeadlessExperimental.disable", {}),
    "HeapProfiler": ("HeapProfiler.getSamplingProfile", {}),
    "IndexedDB": ("IndexedDB.disable", {}),
    "LayerTree": ("LayerTree.disable", {}),
    "Media": ("Media.disable", {}),
    "Memory": ("Memory.getDOMCounters", {}),
    "PerformanceTimeline": ("PerformanceTimeline.enable", {}),
    "Preload": ("Preload.disable", {}),
    "PWA": (
        "PWA.getOsAppState",
        {"manifestId": "https://example.invalid/fcdp-probe-manifest.json"},
    ),
    "Schema": ("Schema.getDomains", {}),
    "Security": ("Security.disable", {}),
    "ServiceWorker": ("ServiceWorker.disable", {}),
    "SmartCardEmulation": ("SmartCardEmulation.disable", {}),
    "SystemInfo": ("SystemInfo.getInfo", {}),
    "Tethering": ("Tethering.unbind", {}),
    "WebMCP": ("WebMCP.disable", {}),
}

BROWSER_FIRST = {"Browser", "Extensions", "PWA", "SystemInfo", "Tethering"}
STRICT_SUCCESS = {"HeadlessExperimental", "SmartCardEmulation"}
HARD_FAILURE_TEXT = (
    "wasn't found",
    "method not found",
    "not allowed",
    "not available",
    "not supported",
    "requires direct-cdp mode",
    "does not advertise a browser websocket",
)


def http_json(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def page_target():
    if BASE:
        pages = [target for target in http_json("/json/list") if target.get("type") == "page"]
        if not pages:
            raise RuntimeError("isolated Chrome exposed no page target")
        return pages[0]["id"]
    completed = subprocess.run(
        [str(FCDP), "tabs"],
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"fcdp tabs failed: {completed.stderr.strip()}")
    for line in completed.stdout.splitlines():
        target_id = line.split("\t", 1)[0]
        if len(target_id) >= 16 and all(character in "0123456789abcdefABCDEF" for character in target_id):
            return target_id
    raise RuntimeError("pipe bridge exposed no page target")


def call(target, method, params):
    command = [str(FCDP), "raw"]
    command += ["--browser"] if target == "browser" else [target]
    command += [method, json.dumps(params, separators=(",", ":"))]
    env = os.environ.copy()
    env["FCDP_FULL"] = "1"
    completed = subprocess.run(
        command,
        env=env,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {
            "transport_error": completed.stderr.strip() or "non-JSON response",
            "stdout": completed.stdout.strip(),
            "exit_code": completed.returncode,
        }
    if completed.returncode != 0 and "error" not in response:
        return {
            "transport_error": completed.stderr.strip() or completed.stdout.strip(),
            "exit_code": completed.returncode,
        }
    return response


def message_of(response):
    error = response.get("error") if isinstance(response, dict) else None
    if isinstance(error, dict):
        return str(error.get("message", ""))
    return str(response.get("transport_error", "")) if isinstance(response, dict) else str(response)


def is_hard_failure(response):
    message = message_of(response).lower()
    return bool(response.get("transport_error")) or any(text in message for text in HARD_FAILURE_TEXT)


def main():
    page = page_target()

    positive = call(page, "Page.getFrameTree", {})
    if "result" not in positive:
        raise RuntimeError(f"positive control failed: {positive}")

    negative = call(page, "DefinitelyNotACdpDomain.nope", {})
    if not is_hard_failure(negative):
        raise RuntimeError(f"negative control did not fail as expected: {negative}")

    rows = []
    for domain, (method, params) in PROBES.items():
        order = ("browser", "page") if domain in BROWSER_FIRST else ("page", "browser")
        attempts = []
        selected = None
        for target in order:
            response = call(target if target == "browser" else page, method, params)
            attempts.append({"target": target, "response": response})
            if not is_hard_failure(response):
                selected = (target, response)
                break

        if selected is None:
            status = "unavailable"
            target = None
            detail = message_of(attempts[-1]["response"])
        else:
            target, response = selected
            if domain in STRICT_SUCCESS and "result" not in response:
                status = "runtime-unavailable"
            else:
                status = "success" if "result" in response else "dispatched"
            detail = message_of(response)
        rows.append(
            {
                "domain": domain,
                "method": method,
                "status": status,
                "target": target,
                "detail": detail,
                "attempts": attempts,
            }
        )

    version = call("browser", "Browser.getVersion", {}).get("result", {})
    summary = {
        "endpoint": BASE or ("pipe:" + PIPE_SOCKET),
        "product": version.get("product"),
        "protocolVersion": version.get("protocolVersion"),
        "positiveControl": "Page.getFrameTree",
        "negativeControl": "DefinitelyNotACdpDomain.nope",
        "requested": len(rows),
        "transportReachable": sum(row["status"] in {"success", "dispatched"} for row in rows),
        "runtimeUnavailable": sum(row["status"] == "runtime-unavailable" for row in rows),
        "unavailable": sum(row["status"] == "unavailable" for row in rows),
        "results": rows,
    }
    print(json.dumps(summary, indent=2))
    return 0 if summary["transportReachable"] == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
