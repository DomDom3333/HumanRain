# HumanRain

**[Try it →](https://domdom3333.github.io/HumanRain/)**

"1.3 mm of rain" tells you nothing about whether to take a coat. HumanRain works
out how much water will actually land on **you** — and shows it as glasses,
bottles or buckets.

Search a town for the next rain window, or load a walking route (GPX from
bergfex, Komoot, AllTrails, or a trail by name) to get the weather you'll
actually walk into, hour by hour. A week of forecast is on offer, a day at a
time, so tomorrow's walk can be planned today.

The search box takes anything OpenStreetMap has a name for — a town, a
waymarked trail, a gorge, a ridge, a peak. Whatever is a line on the map is
walked as a route; everything else gets the forecast where it stands.

Three files, no build step, no dependencies, no API key.

## How it works

One millimetre of rain is one litre per square metre. Two things get you wet:

- **What lands on you** — your horizontal profile, about 0.10 m² for an adult.
- **What you walk into** — rain hangs in the air at `rate ÷ 6 m/s`, and your
  front (~0.65 m²) sweeps through it.

The second term scales with *distance*, not time, so it dominates at anything
above a stroll: most of the water on you is water you drove into.

Routes use [Naismith's rule][n] for pace — an hour per 5 km plus an hour per
600 m of ascent — then integrate the hourly forecast along the way.

Units scale with the amount: eggcup (50 ml), glass (250 ml), bottle (1.5 L),
bucket (10 L), bathtub (150 L).

[n]: https://en.wikipedia.org/wiki/Naismith%27s_rule

## Data

Weather, elevation and town search: [Open-Meteo](https://open-meteo.com)
(CC BY 4.0). Places, landmarks and trails: [OpenStreetMap][osm] contributors,
ODbL — searched through [Photon](https://photon.komoot.io) and the
[Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API).

[osm]: https://www.openstreetmap.org/copyright

## Licence

[GNU AGPL v3](LICENSE) or later. If you host a modified version, you must offer
your users its source — the footer link is how that offer is made, so **point it
at your own repo** if you fork this.
