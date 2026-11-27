# Bezpečnost

Trail Flyover je knihovna, která běží v prohlížeči. Nemá server ani účty a sama nepracuje s žádnými
tajnými údaji.

## Nahlášení zranitelnosti

Prosím nezakládej veřejné issue s podrobnostmi. Pokud je na stránce repozitáře v záložce
**Security** tlačítko **Report a vulnerability**, použij ho. Jinak založ issue jen s prosbou
o kontakt, bez technických detailů, a domluvíme se soukromě.

Ozvu se do týdne. Podporovaná je vždy jen poslední verze ve větvi `main`.

## Co knihovna posílá ven

- Mapové dlaždice a výškový model se stahují od poskytovatelů podkladů (Esri, ČÚZK,
  OpenTopoMap, AWS Terrain Tiles). Ti vidí, kterou oblast si prohlížíš.
- `fetchPlaceLabels` posílá ohraničení trasy serverům Overpass (výchozí seznam
  `OVERPASS_ENDPOINTS`; vlastní jde předat v `endpoints`).
- Chybové hlášky a výpisy do konzole odřezávají z URL parametry (`redactUrls`), aby se do logů
  nedostal API klíč vlastního podkladu.
