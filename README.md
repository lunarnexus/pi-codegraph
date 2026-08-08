# pi-codegraph

CodeGraph tools extension for the Pi coding agent.

## Install

Install from the Gitea git remote:

```bash
pi install git:http://git.lunarnexus.local:3000/james/pi-codegraph@main
```

## Prerequisites

Install the `codegraph` CLI and initialize CodeGraph in projects where you want code intelligence:

```bash
codegraph init
```

## Behavior

The extension discovers CodeGraph MCP tool metadata from the installed `codegraph` CLI, registers the CodeGraph tools in Pi, and injects CodeGraph usage guidance when those tools are active.
