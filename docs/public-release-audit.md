# Public-release audit

GamePlan's public release is built from an audited source snapshot. The source
tree must never contain production credentials, a real Discord application ID,
operator hostnames, or personal data.

## What is checked

- Current tracked files for secrets, private hostnames, credentials, and real
  configuration identifiers.
- Reachable Git history and GitHub metadata before choosing a repository to
  publish.
- GitHub Actions logs, artifacts, releases, wiki content, and repository
  settings.
- Third-party dependencies, licenses, and generated assets.

## Publishing rule

If a private repository's history or GitHub metadata contains private
deployment information, publish a newly created repository from the audited
release snapshot instead of changing that repository's visibility. Do not rely
on deleting text from the current working tree to make historic objects safe.

## Operator responsibility

Self-hosters must use a secret manager or an untracked environment file for
their Discord token, application public key, Steam API key, database password,
and `APP_SECRET`. Never commit those values to a fork or a deployment branch.
