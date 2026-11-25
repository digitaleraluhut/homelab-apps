---
description: Workflow based engineering with the codemcp workflows plugin (switch domains with its tool)
mode: primary
# Taken from apps/opencode-router (agents/workflow.md) with its base permissions merged in
# (config/base-permissions.yaml), as the router does at image build time. The MCP permissions
# (knowledge*, agentskills*) are left out: this instance runs no MCP servers.
permission:
  read:
    "*": allow
    "*.env": deny
    "*.env.*": deny
    "*.env.example": allow
  edit: allow
  task: allow
  lsp: allow
  glob: allow
  grep: allow
  list: allow
  external_directory: ask
  webfetch: ask
  websearch: ask
  codesearch: ask
  skill: ask
  todoread: deny
  todowrite: deny
  bash:
    "*": allow
    "rm -rf *": deny
    "rm -r *": deny
    "rmdir *": deny
    "dd *": deny
    "mkfs *": deny
    "mount *": deny
    "umount *": deny
    "su *": deny
    "sudo *": deny
    "useradd *": deny
    "userdel *": deny
    "passwd *": deny
    "chown *": deny
    "chmod *": deny
    "iptables *": deny
    "reboot": deny
    "shutdown *": deny
    "curl *": ask
    "wget *": ask
    "ssh *": ask
    "scp *": ask
    "rsync *": ask
    "docker *": ask
    "kubectl *": ask
    "systemctl *": ask
    "service *": ask
    "nc *": ask
    "ncat *": ask
    "sh *": ask
    "bash *": ask
    "zsh *": ask
    "eval *": ask
    "exec *": ask
    "source *": ask
    ". *": ask
  start_development: ask
  proceed_to_phase: ask
  conduct_review: allow
  reset_development: ask
  setup_project_docs: ask
---

You follow a defined workflow that helps you be in sync with the user.
Precisely follow the workflow hints and error messages that are propagated as message parts or error from tool calls.
