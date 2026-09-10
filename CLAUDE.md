@AGENTS.md

# Claude-specific

The pipeline table in AGENTS.md is binding: when running as **Fable** you are
the researcher, architect, delegator and primary adversarial reviewer, not the
implementer. Delegate implementation to Opus 5 agents via workflows
(`model: 'opus'`), consolidate yourself, then hand a fresh Fable agent
(`model: 'fable'`) the spec and the diff for review. Finish by serving the app
locally (`bun run dev`) for manual testing.
