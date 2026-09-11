# pi-codegraph

Give Pi a code map before it starts guessing.

`pi-codegraph` loads the CodeGraph toolset into Pi: fast symbol lookup, call graphs, impact checks, and project-aware code exploration. It is useful when you want Pi to inspect an indexed codebase instead of crawling files with grep.

## Install

From npm:

```bash
pi install npm:@lunarnexus/pi-codegraph
```

From GitHub, pinned to this release:

```bash
pi install git:github.com/LunarNexus/pi-codegraph@v0.2.1
```

Then restart Pi or run `/reload`.

Pi packages and extensions run with your user permissions. Review source before installing packages from any third-party repository.

## Prerequisites

Install the `codegraph` CLI and initialize CodeGraph in each project where you want code intelligence:

```bash
codegraph init
```

## What it does

The extension finds the installed `codegraph` CLI, reads its MCP tool metadata, and registers those tools inside Pi.

When CodeGraph tools are active, it also adds usage guidance to Pi's prompt so the agent prefers indexed code exploration for review, debugging, impact analysis, and architecture questions.

## Development checks

```bash
npm install
npm run typecheck
npm pack --dry-run
```

## References

- Pi package docs: https://pi.dev/docs/latest/packages
- Pi extension docs: https://pi.dev/docs/latest/extensions
