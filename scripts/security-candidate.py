"""Check the committed tree and npm lockfile. Emit only aggregate, SHA-bound evidence."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def command(args, cwd, env=None, timeout=60):
    return subprocess.run(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=timeout)


def materialize(repo, sha, tree):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Expected a full commit SHA")
    head = command(["git", "rev-parse", "HEAD"], repo)
    if head.returncode or head.stdout.decode().strip() != sha:
        raise ValueError("Checkout differs from the requested commit")
    entries = command(["git", "ls-tree", "-rz", sha], repo)
    entries.check_returncode()
    for entry in entries.stdout.rstrip(b"\0").split(b"\0"):
        header, name = entry.split(b"\t", 1)
        mode, kind, oid = header.split()
        if kind != b"blob" or mode not in (b"100644", b"100755", b"120000"):
            raise ValueError("Unsupported tree entry")
        path = tree / os.fsdecode(name)
        if not path.is_relative_to(tree) or ".." in path.parts:
            raise ValueError("Unexpected tree path")
        path.parent.mkdir(parents=True, exist_ok=True)
        blob = command(["git", "cat-file", "blob", oid], repo)
        blob.check_returncode()
        # Materialize link text as data so the scanner cannot follow a repository symlink.
        with path.open("xb") as target:
            target.write(blob.stdout)


def scan_secrets(tree, private, env):
    config = private / "gitleaks.toml"
    config.write_text("[extend]\nuseDefault = true\n")
    ignore = private / "empty-ignore"
    ignore.touch()
    output = private / "leaks.json"
    tool = shutil.which("gitleaks", path=env["PATH"])
    if not tool or command([tool, "version"], private, env).stdout.strip() != b"8.30.1":
        raise ValueError("Required scanner unavailable")
    run = command([tool, "dir", "--config", str(config), "--gitleaks-ignore-path", str(ignore),
                   "--ignore-gitleaks-allow", "--redact=100", "--exit-code", "10", "--timeout", "120",
                   "--report-format", "json", "--report-path", str(output), str(tree)], private, env, 130)
    if run.returncode not in (0, 10):
        raise ValueError("Secret scanner error")
    findings = json.loads(output.read_bytes())
    if not isinstance(findings, list) or bool(findings) != (run.returncode == 10):
        raise ValueError("Invalid secret scan result")
    return {"status": "findings" if findings else "clean", "count": len(findings), "scanner": "gitleaks 8.30.1"}


def scan_dependencies(tree, private, env):
    audit_dir = private / "npm-audit"
    audit_dir.mkdir()
    for name in ("package.json", "package-lock.json"):
        shutil.copyfile(tree / name, audit_dir / name)
    lock_digest = hashlib.sha256((audit_dir / "package-lock.json").read_bytes()).hexdigest()
    run = command(["npm", "audit", "--package-lock-only", "--ignore-scripts", "--json",
                   "--registry=https://registry.npmjs.org", "--fetch-retries=0"], audit_dir, env, 90)
    report = json.loads(run.stdout)
    if run.returncode not in (0, 1) or report.get("auditReportVersion") != 2 or "error" in report:
        raise ValueError("Dependency scanner error")
    counts = report["metadata"]["vulnerabilities"]
    total = counts["total"]
    if type(total) is not int or total < 0 or bool(total) != bool(run.returncode):
        raise ValueError("Invalid dependency scan result")
    return {"status": "findings" if total else "clean", "count": total, "lock_sha256": lock_digest}


def main():
    sha = sys.argv[1] if len(sys.argv) == 2 else ""
    receipt = {"sha": sha if re.fullmatch(r"[0-9a-f]{40}", sha) else None, "owner": "meteor-desktop maintainers",
               "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "secrets": {"status": "incomplete"}, "dependencies": {"status": "incomplete"}}
    try:
        with tempfile.TemporaryDirectory(prefix="candidate-security-") as directory:
            private = Path(directory).resolve()
            tree = private / "tree"
            tree.mkdir()
            materialize(Path.cwd(), sha, tree)
            env = {"HOME": str(private), "PATH": os.environ["PATH"], "NPM_CONFIG_USERCONFIG": os.devnull,
                   "NPM_CONFIG_GLOBALCONFIG": str(private / "empty-npmrc")}
            for key, scan in (("secrets", scan_secrets), ("dependencies", scan_dependencies)):
                try:
                    receipt[key] = scan(tree, private, env)
                except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                    pass  # The prefilled incomplete result blocks the gate.
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    print(json.dumps(receipt, sort_keys=True))
    return 0 if all(receipt[key]["status"] == "clean" for key in ("secrets", "dependencies")) else 1


if __name__ == "__main__":
    sys.exit(main())
