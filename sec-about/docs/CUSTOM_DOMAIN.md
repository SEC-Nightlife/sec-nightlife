# Custom domain — about.secnightlife.com

The landing site is deployed as Vercel project **sec-about**.

Live preview (already working): https://sec-about.vercel.app

## Attach the custom domain

### In Vercel (Dashboard)

1. Open [Vercel → sec-about → Settings → Domains](https://vercel.com/sihles-projects-e4d810e0/sec-about/settings/domains)
2. Add `about.secnightlife.com`
3. Copy the CNAME target Vercel shows (usually `cname.vercel-dns.com`)

### Or via CLI (from `sec-about/`)

```bash
vercel domains add about.secnightlife.com
```

### At GoDaddy DNS

| Type | Name | Value |
|------|------|--------|
| CNAME | `about` | value from Vercel (e.g. `cname.vercel-dns.com`) |

Do **not** change `secnightlife.com`, `www`, or `api` records — those stay on the main app.

## Verify

```bash
curl -sI https://about.secnightlife.com | head -5
```

Share `https://about.secnightlife.com` with investors once DNS propagates (often a few minutes; up to 48h).
