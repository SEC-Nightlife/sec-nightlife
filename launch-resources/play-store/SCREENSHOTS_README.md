# Play Store screenshots (ready to upload)

Generated from App Store assets. Aspect ratio **9:16** (Play requirement).

## Folders

| Folder | Size | Play Console field | Max upload |
|--------|------|--------------------|------------|
| [`phone-screenshots/`](phone-screenshots/) | **1080×1920** | Phone screenshots | 2–8 |
| [`tablet-7-inch-screenshots/`](tablet-7-inch-screenshots/) | **1200×1920** | 7-inch tablet | up to 8 |
| [`tablet-10-inch-screenshots/`](tablet-10-inch-screenshots/) | **1600×2560** | 10-inch tablet | up to 8 |

Source:
- Phone ← `app-store/screenshots/` (1284×2778), center-cropped to 9:16
- Tablets ← `app-store/ipad-13-screenshots/` (2064×2752) when present, else phone sources

## Recommended upload order (first 8)

1. `01-home.png`
2. `02-profile.png`
3. `06-host-dashboard.png`
4. `01-dashboard.png` (or `01-venue-dashboard.png`)
5. `02-analytics.png`
6. `03-bookings.png`
7. `04-menu-food.png`
8. `03-messages.png`

Optional extras in the same folders: friends, notifications, guest-home, manage-tables, day-listings, hero-brand.

## Regenerate

```bash
node launch-resources/scripts/generate-play-screenshots.mjs
```
