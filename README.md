# DotMock CLI

Build, configure, exercise, and inspect controlled API environments from a
terminal or coding agent.

## Start without installing

Node.js 18 or newer is required.

```sh
npx --yes @dotmock/cli@latest login
```

The command opens DotMock in your browser, asks you to approve a team-scoped
credential, and stores it in `~/.dotmock/config.json`.

To connect an onboarding session that is already open in the browser, run the
exact command shown there:

```sh
npx --yes @dotmock/cli@latest login --setup-id <setup-id>
```

## Install globally

```sh
npm install --global @dotmock/cli
dotmock login
dotmock status
```

## Use in CI

Create a scoped API key in DotMock, store it in your CI secret manager, and
inject it without writing credentials to the repository:

```sh
export DOTMOCK_API_KEY=mck_...
npx --yes @dotmock/cli@latest --json status
```

Use a pinned package version in repeatable production pipelines:

```sh
npx --yes @dotmock/cli@0.1.1 --json status
```

## Common workflows

```sh
dotmock --json list apis
dotmock create api --name "Orders" --from openapi.yaml
dotmock --json test --api "$API_ID" --method GET --path /orders
dotmock webhook listen --api "$WEBHOOK_API_ID" --forward-to http://localhost:3000/webhooks
dotmock skill install --scope project --agent auto
```

Read the complete [DotMock CLI guide](https://dotmock.com/docs/guides/cli) for
REST, realtime, GraphQL, SOAP, gRPC, LLM, webhook, state, and agent workflows.

## Security

The browser login creates a team-scoped CLI credential. Never commit
`~/.dotmock/config.json`, API keys, or copied setup commands. Setup IDs are
short-lived and should be treated as secrets while active.
