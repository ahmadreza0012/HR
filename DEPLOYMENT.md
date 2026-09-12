# Automatic deployment

`.github/workflows/deploy.yml` runs on every push to `master`.

## One-time setup

1. Create the Render service and PostgreSQL database from `render.yaml`.
2. Create a Render deploy hook for the API service.
3. Create/link the Vercel project for this repository.
4. Add these GitHub repository secrets:

| Secret | Value |
| --- | --- |
| `RENDER_DEPLOY_HOOK_URL` | Render deploy hook URL |
| `VERCEL_TOKEN` | Vercel personal token |
| `VERCEL_ORG_ID` | Vercel team or account ID |
| `VERCEL_PROJECT_ID` | Vercel project ID |
| `VITE_API_URL` | Public API URL ending in `/api` |

Set `WEB_ORIGIN` on Render to the public Vercel URL. The workflow verifies the
code, triggers the API deploy, and then deploys the static frontend to Vercel.
