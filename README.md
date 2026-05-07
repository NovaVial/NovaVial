# NovaVial Research Store

Static storefront plus a small Node backend for Square Web Payments.

## Local Setup

1. Copy `.env.example` to `.env`.
2. Create a Square sandbox application in the Square Developer Dashboard.
3. Put your sandbox access token, application ID, and location ID in `.env`.
4. Run either command:

```bash
npm start
# or
node server.js
```

5. Open `http://localhost:4242`.

Do not put bank, SSN, tax ID, or other personal onboarding details in this repo or in chat. Add payout bank details inside Square Dashboard.

## Test Before Deploying

```bash
node --check server.js
node tests/smoke.mjs
```

The smoke test starts the backend on a temporary port and verifies the homepage, policies, products API, health check, and Square configuration guard.

## Deployment Checklist

- Push the repo to GitHub.
- Create a Render web service from the repo, or use `render.yaml`.
- Set `node server.js` as the start command.
- Add Square credentials as environment variables in the host dashboard.
- Keep `.env`, `data/orders.json`, and `data/square-events.json` out of Git.
- Configure the host health check path as `/api/health`.
- Add a custom domain and confirm HTTPS is active.
- Configure Square webhooks to `https://YOUR_DOMAIN/api/webhooks/square`.
- Replace file-based order storage with a production database before accepting real orders at scale.

## Going Live

- Confirm Square supports your exact product category before taking real payments.
- Switch `SQUARE_ENVIRONMENT=production`.
- Replace sandbox credentials with production credentials.
- Use HTTPS hosting.
- Configure a Square webhook pointing to `/api/webhooks/square`.
- Add real shipping, taxes, return policy, terms, privacy policy, and fulfillment workflows.
