---
name: microsandbox-browser-howto
description: How the embedded browser surface works — three agent tools (browser_navigate / browser_snapshot / browser_screenshot), when each is the right pick, and what to do when the tools are not yet available.
when:
  toolPresent: browser_navigate
---

The microsandbox plugin ships an embedded **Stealth Chromium**
(CloakBrowser) reachable through Playwright MCP, plus a noVNC
viewport in the admin Browser page. Three agent tools surface that
stack:

| Tool | Use when |
|------|----------|
| `browser_navigate(url)` | You need a real page render — JS, redirects, cookies. Equivalent to `page.goto()`. |
| `browser_snapshot()` | You want to *act on* the page next. Returns an accessibility tree (roles, names, refs). Cheap, structured, easy to reason about. |
| `browser_screenshot()` | You need pixels — visual diffing, vision-model prompting, sharing a screenshot back to the user. |

## Default workflow

```
1. browser_navigate("https://…")
2. browser_snapshot()                 # find the element to act on
3. browser_screenshot()               # only if you need the picture
```

Snapshots beat screenshots whenever the model needs to *interact*
or *extract*. Screenshots are best treated as a presentation
format, not a comprehension format.

## Tool availability

These tools are gated on the BrowserSidecar reporting a live
Playwright MCP port. If the chromium stack isn't built into the
tenant's Sandboxfile yet, the tools won't show up in your tool
list — there's no point trying to fall back to them.

If the user wants to use the browser:

1. They open `/admin/microsandbox/browser` and check **Status**.
2. If "not running", they edit the Sandboxfile (Sandbox admin
   page) to include the browser layer (CloakBrowser + Xvfb +
   x11vnc + noVNC + Playwright MCP), build, then `use & reset`.
3. Once the admin page reports `ready: true` with three live
   ports, your tool list reloads and `browser_*` tools show up.

Don't tell the user "I'll navigate" before the tools are available
— the call will return a structured error and waste a turn.

## Coordinates and viewports

When the user has the admin Browser page open, the noVNC iframe
reports its size back to the host via a ResizeObserver, and that
viewport is reachable through `browser.cdp`'s `getLastViewport()`.
The browser tools auto-set Playwright's viewport from this before
each navigation, so screenshots match what the user sees.

If the user is **not** watching the page (no admin tab open), the
viewport falls back to `1280x800`. Don't write skills that
hard-code coordinates — they'll only work for one viewport.

## When the browser tools hang

If a `browser_*` call returns a confusing timeout / error, or
`exec` itself sticks (the symptom is "the conversation just
stops emitting tokens for 30+s"), call:

```
browser_health_check()
```

It probes CDP `/json/version` with a 2.5s timeout and returns
`{ok, latencyMs, error?, suggestion?}`. The `suggestion` field
tells you the next concrete recovery step:

- **CDP host port not mapped**: the snapshot you booted doesn't
  ship the browser stack. Build one that does (template
  `browser.yaml`).
- **CDP not reachable / connect refused**: chromium or
  supervisord crashed inside the guest. Try `browser_restart`
  first (cheap, ~5s). If the next `browser_health_check` still
  fails, escalate to `reset_sandbox`.
- **CDP probe timed out**: the sandbox VM itself is wedged.
  Skip `browser_restart` (it'll hang too) and go straight to
  `reset_sandbox`. Files under `/workspace` survive.

Don't loop the probe — call once, act on the suggestion, call
again only after attempting recovery.

## What NOT to do

- Don't `browser_navigate` to user input as a URL without
  validating the scheme. Stick to `https://` for arbitrary user
  input; if the user explicitly asks for a local resource (a
  service running in the same sandbox), confirm `http://localhost`
  is intended.
- Don't `browser_screenshot` without `browser_navigate` first —
  the tool will return whatever the page state was, which may be
  blank or the previous user's content.
- Don't paste large snapshot blobs back into the chat verbatim.
  Summarise: "the page has a search box (ref=e3) and a list of 12
  results (refs=e7..e18)" is much more useful than 4 KB of AX
  JSON.
- Don't expect the embedded chromium to share cookies with the
  user's host browser. Each sandbox has an isolated profile;
  authenticated sessions need to be performed inside the sandbox
  (e.g. via `browser_navigate` to a login URL the user trusts).

## Why CloakBrowser instead of stock Chromium

Stock headless chromium leaks several automation tells (navigator.
webdriver, headless UA, missing GPU/WebGL profile, abnormal
plugin/font lists). CloakBrowser patches those at the C++ source
level, so common bot-detection sites don't refuse the page. Same
Playwright API, drop-in `launch()` replacement.

This does **not** mean you can ignore site terms of service.
Realistic fingerprints help compatibility, not authorisation. If a
site's TOS forbids automated access, that's still a no.
