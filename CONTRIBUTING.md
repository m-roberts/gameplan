# Contributing to GamePlan

Thank you for improving GamePlan.

## Before opening a pull request

- Keep user-facing terms consistent: **Game Night**, **Regular Game Night**,
  **Game Vote**, **Session Feed**, and **Games Tonight**. See `CONTEXT.md`.
- Do not add real deployment URLs, Discord identifiers, credentials, browser
  tokens, or personal data to source, fixtures, documentation, commits, or
  screenshots.
- Add or update tests for behaviour changes and run `npm test`.
- For database changes, add a new forward-only migration and refresh the fresh
  install baseline as explained in [migration policy](docs/migrations.md).

## Pull requests

Describe the user-visible behaviour, tests run, and any migration or operator
impact. Keep secrets in local environment files only. Report security issues
privately to the maintainers rather than filing a public issue with exploitable
details.
