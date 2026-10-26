# Contributing to finbrief

Thank you for your interest in contributing. This project is pre-release:
implementation has not started, and the first contributions will be the
scaffolding described in the roadmap in [README.md](README.md#roadmap).

By participating, you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs

Use the **Bug report** issue template. Before filing:

- Search existing issues to avoid duplicates.
- Never include credentials, API keys, tokens, account numbers, or real
  financial data in a report. The bug form reminds you to redact; the
  security policy for vulnerabilities is separate (see below).
- Security vulnerabilities must **not** be filed as issues — follow
  [SECURITY.md](SECURITY.md) instead.

## Proposing features

Use the **Feature request** form. It is problem-first: describe the problem
before the solution, and indicate which product principle the request
advances (see the principles table in [README.md](README.md#overview)).

## Development standards

This project is developed test-first. These standards are non-negotiable:

1. **Test-driven development.** Write a failing test first (red), make it
   pass with the smallest change (green), then refactor. A change without a
   test is incomplete, except for changes to documentation only.
2. **Coverage gate.** The suite must hold at or above **80%** line coverage.
   Coverage is enforced in CI; a pull request that lowers it will not merge.
3. **Immutability.** Do not mutate shared or incoming state; return new
   values instead.
4. **Validate at the boundary.** All external input — HTTP requests, webhook
   payloads, third-party API responses — is validated at the edge before use.
5. **No secrets in the tree.** Credentials come from environment variables or
   a secret manager only. The pre-commit security scan must pass.
6. **Error handling.** Handle errors deliberately: catch, add context, and
   surface a safe message. Never swallow errors silently.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>
```

Valid types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`,
`ci`, `build`.

## Pull requests

1. Branch from `main`.
2. Keep changes focused; open separate PRs for unrelated work.
3. Fill in the pull request template — tests added, coverage held, no
   secrets, conventional commit message.
4. All CI checks must pass before review.

## Questions

See [SUPPORT.md](SUPPORT.md) for the right channel. Thank you for helping.
