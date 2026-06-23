# Updating

Tianshu publishes versioned releases to npm. The recommended
update workflow is `tianshu update`; it's a thin wrapper
around `npm install -g @tianshu-ai/tianshu@<tag>` that adds
some safety checks.

## Check for updates

```bash
tianshu update --check
```

Compares your installed version against npm's `latest`
dist-tag and prints the result. Exits `0` if up to date, `1`
if a newer version exists, `2` if the registry is unreachable.
Useful for cron jobs or external monitors.

`tianshu doctor` also includes a "Tianshu version" check that
runs the same comparison and surfaces a warning if a newer
version is available.

## Apply an update

```bash
tianshu update
```

Equivalent to:

```bash
npm install -g @tianshu-ai/tianshu@latest
```

…with two safety rails:

- **Refuses to run from a git checkout.** If the binary is
  running from a source tree (detected via a `.git/` ancestor),
  `tianshu update` tells you to use `git pull` instead. Updating
  via npm in that case would install a parallel global copy
  and confuse subsequent runs.
- **Restart hint after install.** Tianshu does NOT auto-bounce
  the launchd service. In-flight chat sessions and sandbox
  state would be lost. You restart explicitly:

  ```bash
  tianshu restart
  tianshu doctor              # confirm new version is live
  ```

## Pre-release channels

```bash
tianshu update --tag next
```

Installs from the `next` dist-tag (or whatever tag you pass).
Use only if the maintainers explicitly tell you to track a
pre-release.

## Dry run

```bash
tianshu update --dry-run
```

Prints the `npm install -g` command that would run, without
executing.

## Manual update

If `tianshu update` itself is broken for some reason:

```bash
npm install -g @tianshu-ai/tianshu@latest
tianshu restart
```

The launchd plist's `WorkingDirectory` points at your npm
prefix, so a fresh `npm install -g` overwrites the files the
service runs from. The new code goes live as soon as you
restart the service.

## EACCES errors

Symptom: `npm ERR! code EACCES` while installing globally.

Cause: you're on a system-Node install (`/usr/local/lib/...`)
where global installs need root.

Fix: don't `sudo`. Move to a per-user Node manager — nvm,
volta, asdf, fnm — where global installs land in a directory
you own. Sudo'd npm-global state is a recurring source of
permission-related upgrade failures.
