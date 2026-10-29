# Working rules for this repo

This is altaready.info, a public wildfire early-warning site. Read README.md first; it describes how the site works.

## Deploying

- Pushing to `main` deploys `index.html` to altaready.info automatically through Cloudflare Workers Builds, usually within a minute. Commit straight to `main`; no pull requests needed. Other branches only build a preview.
- `worker/` is the data backend (firewatch-api). It is NOT auto-deployed. Never deploy it, and never run `wrangler` at all.

## Before every push that touches `index.html` or `worker/`

Run both test suites. All tests must pass, and report the results:

```
node tests/fail-states.mjs
node worker/test/feeds.mjs
```

## Safety rule

Missing or failed data must never look like an all-clear, either on the page or in the backend. Any change near the scoring or the failure states needs a test that checks it.

## Public repo

Never commit personal contact details, keys or secrets.

## Talking to Tim

Tim is not a developer. Explain changes in plain language.
