# Transactional email templates

The emails Dokploy sends — build succeeded, build failed, database backup, Docker
cleanup, server threshold reached, invitations, email verification — written as React
components with [React Email](https://react.email).

`emails/` holds the templates that are actually sent. Several files alongside them
(`stripe-welcome`, `plaid-verify-identity`, `notion-magic-link`, `vercel-invite-user`)
are the starter's examples, kept as references for the component API rather than used.

## Previewing them

React Email renders the templates in a browser, so you can iterate without sending real
mail:

```bash
cd packages/server/src/emails
bun install
bun run dev
```

Then open [localhost:3000](http://localhost:3000).

This directory has its own `package.json` because the preview server pulls in
`react-email`, a dev-only tool that the runtime image has no reason to carry.

## License

MIT, from the React Email starter this was derived from.
