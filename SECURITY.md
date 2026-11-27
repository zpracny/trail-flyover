# Security

Trail Flyover is a library that runs in the browser. It has no server and no accounts, and it
does not handle any secrets of its own.

## Reporting a vulnerability

Please do not open a public issue with the details. If the repository's **Security** tab offers a
**Report a vulnerability** button, use it. Otherwise open an issue that only asks for a contact,
without technical details, and we will continue privately.

I will reply within a week. Only the latest version on the `main` branch is supported.

## What the library sends to third parties

- Map tiles and the elevation model are downloaded from the basemap providers (Esri, ČÚZK,
  OpenTopoMap, AWS Terrain Tiles). They can see which area you are looking at.
- `fetchPlaceLabels` sends the bounding box of the track to Overpass servers (the default list is
  `OVERPASS_ENDPOINTS`; pass your own in `endpoints`).
- Error messages and console output cut the query string off every URL (`redactUrls`), so the API
  key of a custom basemap does not end up in logs.
