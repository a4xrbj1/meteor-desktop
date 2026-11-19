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


def materialize(repo, sha, private, env):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Expected a full commit SHA")
    git_env = {**env, "GIT_CONFIG_NOSYSTEM": "1", "GIT_NO_REPLACE_OBJECTS": "1"}
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, env=git_env,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
    if head.returncode or head.stdout.decode().strip() != sha:
        raise ValueError("Checkout differs from the requested commit")
    objects = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-path", "objects"],
                             cwd=repo, env=git_env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             timeout=60, check=True)
    store = Path(os.fsdecode(objects.stdout.removesuffix(b"\n"))).resolve(strict=True)
    if not store.is_dir():
        raise ValueError("Git object directory is unavailable")
    pinned = private / "pinned.git"
    pinned.mkdir()
    subprocess.run(["git", "init", "--bare", "--object-format=sha1", "--template="],
                   cwd=pinned, env=git_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   timeout=60, check=True)
    (pinned / "HEAD").write_text(sha + "\n", encoding="ascii")
    git_env["GIT_OBJECT_DIRECTORY"] = str(store)
    tree = private / "tree"
    tree.mkdir()
    entries = subprocess.run(["git", "ls-tree", "-rz", "HEAD"], cwd=pinned, env=git_env,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
    entries.check_returncode()
    for entry in entries.stdout.split(b"\0")[:-1]:
        header, name = entry.split(b"\t", 1)
        mode, kind, oid = header.split()
        if kind != b"blob" or mode not in (b"100644", b"100755", b"120000") or not re.fullmatch(b"[0-9a-f]{40}", oid):
            raise ValueError("Unsupported tree entry")
        path = tree / os.fsdecode(name)
        if not path.is_relative_to(tree) or ".." in path.parts:
            raise ValueError("Unexpected tree path")
        path.parent.mkdir(parents=True, exist_ok=True)
        blob = subprocess.run(["git", "cat-file", "--batch"], cwd=pinned, env=git_env,
                              input=oid + b"\n", stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              timeout=60, check=True)
        metadata, data = blob.stdout.split(b"\n", 1)
        if not data.endswith(b"\n") or metadata != oid + b" blob " + str(len(data) - 1).encode("ascii"):
            raise ValueError("Unexpected blob response")
        # Materialize link text as data so the scanner cannot follow a repository symlink.
        with path.open("xb") as target:
            target.write(data[:-1])


def scan_secrets(private, env):
    config = private / "gitleaks.toml"
    config.write_text("[extend]\nuseDefault = true\n")
    ignore = private / "empty-ignore"
    ignore.touch()
    output = private / "leaks.json"
    version = subprocess.run(["gitleaks", "version"], cwd=private, env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=60, check=True)
    if version.stdout.strip() != b"8.30.1":
        raise ValueError("Required scanner unavailable")
    run = subprocess.run(["gitleaks", "dir", "--config", "gitleaks.toml", "--gitleaks-ignore-path", "empty-ignore",
                          "--ignore-gitleaks-allow", "--redact=100", "--exit-code", "10", "--timeout", "120",
                          "--report-format", "json", "--report-path", "leaks.json", "tree"],
                         cwd=private, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=130)
    if run.returncode not in (0, 10):
        raise ValueError("Secret scanner error")
    findings = json.loads(output.read_bytes())
    if not isinstance(findings, list) or bool(findings) != (run.returncode == 10):
        raise ValueError("Invalid secret scan result")
    return {"status": "findings" if findings else "clean", "count": len(findings), "scanner": "gitleaks 8.30.1"}


def scan_dependencies(private, env):
    audit_dir = private / "npm-audit"
    audit_dir.mkdir()
    for name in ("package.json", "package-lock.json"):
        shutil.copyfile(private / "tree" / name, audit_dir / name)
    lock_digest = hashlib.sha256((audit_dir / "package-lock.json").read_bytes()).hexdigest()
    run = subprocess.run(["npm", "audit", "--package-lock-only", "--ignore-scripts", "--json",
                          "--registry=https://registry.npmjs.org", "--fetch-retries=0"],
                         cwd=audit_dir, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=90)
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
            repo = Path.cwd().resolve()
            search = [Path(part) for part in os.environ.get("PATH", "").split(os.pathsep)]
            search = [p.resolve() for p in search if p.is_absolute()]
            trusted = [str(p) for p in search if not p.is_relative_to(repo)]
            env = {"HOME": str(private), "PATH": os.pathsep.join(trusted), "NPM_CONFIG_USERCONFIG": os.devnull,
                   "NPM_CONFIG_GLOBALCONFIG": str(private / "empty-npmrc")}
            if not trusted or any(Path(tool).resolve().is_relative_to(repo)
                                  for name in ("git", "gitleaks", "npm")
                                  if (tool := shutil.which(name, path=env["PATH"]))):
                raise ValueError("Expected tools outside the candidate")
            materialize(repo, sha, private, env)
            for key, scan in (("secrets", scan_secrets), ("dependencies", scan_dependencies)):
                try:
                    receipt[key] = scan(private, env)
                except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                    pass  # The prefilled incomplete result blocks the gate.
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    print(json.dumps(receipt, sort_keys=True))
    return 0 if all(receipt[key]["status"] == "clean" for key in ("secrets", "dependencies")) else 1


if __name__ == "__main__":
    sys.exit(main())
