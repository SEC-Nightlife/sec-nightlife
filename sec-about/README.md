# SEC About — Investor / marketing landing

Standalone marketing site for **SEC Nightlife**, deployed at [about.secnightlife.com](https://about.secnightlife.com).

The live product app remains at [secnightlife.com](https://secnightlife.com).

## Develop

```bash
cd sec-about
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Deploy

Vercel project rooted at `sec-about` with custom domain `about.secnightlife.com`.

At GoDaddy DNS, add:

| Type | Name | Value |
|------|------|--------|
| CNAME | `about` | value shown in Vercel Domains |
